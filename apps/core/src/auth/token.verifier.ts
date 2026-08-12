import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { getEnv } from '../config/env';
import { errors } from '../common/errors';

/**
 * Проверка access-токена.
 *
 * Launch не реализует OIDC самостоятельно (ADR-003): в production токены
 * выпускает проверенный IdP, а здесь выполняется только валидация — подпись по
 * JWKS, issuer, audience, срок, алгоритм из allowlist.
 *
 * Локальный режим существует ради dev и CI и запрещён в production проверкой
 * конфигурации (`config/env.ts`), а не соглашением.
 */

export interface VerifiedToken {
  subject: string;
  roles: string[];
  /** Момент выпуска (секунды). Нужен рубежу действительности сессий (M035). */
  issuedAt: number | null;
  /**
   * Идентификатор токена (`jti`). Нужен точечному отзыву: без него отозвать
   * можно только все сессии пользователя разом (M038). У токена внешнего IdP
   * claim может отсутствовать — тогда `null`, и такой токен отзывается только
   * рубежом сессий.
   */
  tokenId: string | null;
  /** Уровень аутентификации. 'mfa' требуется для денежных и регулируемых операций. */
  acr: string | null;
  expiresAt: number;
}

/** Алгоритмы с симметричным ключом и `none` не принимаются никогда. */
const ALLOWED_ALGS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384'] as const;

@Injectable()
export class TokenVerifier {
  private readonly logger = new Logger(TokenVerifier.name);
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  async verify(token: string): Promise<VerifiedToken> {
    const env = getEnv();
    return env.AUTH_MODE === 'oidc' ? this.verifyOidc(token) : this.verifyLocal(token);
  }

  private async verifyOidc(token: string): Promise<VerifiedToken> {
    const env = getEnv();
    this.jwks ??= createRemoteJWKSet(new URL(`${env.OIDC_ISSUER}/protocol/openid-connect/certs`), {
      cacheMaxAge: env.OIDC_JWKS_CACHE_TTL_SECONDS * 1000,
      // Внешний вызов без таймаута подвесил бы каждый запрос при недоступности IdP.
      timeoutDuration: 5_000,
    });

    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: env.OIDC_ISSUER,
        audience: env.OIDC_AUDIENCE,
        algorithms: [...ALLOWED_ALGS],
        clockTolerance: 5,
      });
      return this.toVerified(payload);
    } catch (error) {
      this.logger.warn({
        msg: 'токен отклонён',
        reason: error instanceof Error ? error.message : 'unknown',
      });
      throw errors.unauthenticated({ stage: 'oidc-verify' });
    }
  }

  /**
   * Локальный адаптер: компактный HMAC-токен `base64url(payload).base64url(mac)`.
   * Формат намеренно НЕ является JWT, чтобы его нельзя было спутать с
   * настоящим токеном IdP и случайно принять в production.
   */
  private verifyLocal(token: string): VerifiedToken {
    const env = getEnv();
    const [body, signature] = token.split('.');
    if (!body || !signature) throw errors.unauthenticated({ stage: 'local-format' });

    const expected = createHmac('sha256', env.LOCAL_AUTH_SIGNING_KEY).update(body).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, 'base64url');
    } catch {
      throw errors.unauthenticated({ stage: 'local-signature-encoding' });
    }
    // Сравнение подписи — только constant-time (RULES.md §4).
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw errors.unauthenticated({ stage: 'local-signature' });
    }

    let payload: JWTPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JWTPayload;
    } catch {
      throw errors.unauthenticated({ stage: 'local-payload' });
    }
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
      throw errors.unauthenticated({ stage: 'local-expired' });
    }
    return this.toVerified(payload);
  }

  private toVerified(payload: JWTPayload): VerifiedToken {
    const subject = payload.sub;
    if (typeof subject !== 'string' || subject.length === 0) {
      throw errors.unauthenticated({ stage: 'no-subject' });
    }
    const rawRoles = (payload as { roles?: unknown }).roles;
    const roles = Array.isArray(rawRoles)
      ? rawRoles.filter((r): r is string => typeof r === 'string')
      : [];
    const acr = typeof payload.acr === 'string' ? payload.acr : null;
    const issuedAt = typeof payload.iat === 'number' ? payload.iat : null;
    // Длина ограничена той же рамкой, что и колонка реестра: идентификатор
    // произвольной длины из чужого токена не должен доходить до запроса.
    const rawJti = payload.jti;
    const tokenId =
      typeof rawJti === 'string' && rawJti.length >= 8 && rawJti.length <= 128 ? rawJti : null;
    return { subject, roles, acr, issuedAt, tokenId, expiresAt: (payload.exp ?? 0) * 1000 };
  }

  /** Выпуск токена локального адаптера. Существует только вне production. */
  issueLocal(input: {
    subject: string;
    roles: string[];
    acr?: string;
    ttlSeconds: number;
  }): string {
    const env = getEnv();
    if (env.isProduction) {
      throw new Error('Выпуск локальных токенов в production невозможен');
    }
    const payload = {
      sub: input.subject,
      roles: input.roles,
      acr: input.acr ?? 'pwd',
      // Идентификатор токена: без него отозвать одну сессию, не трогая
      // остальные, нечем (M038). Случайный UUID, а не производная от
      // пользователя, — иначе по нему восстанавливалась бы связь между
      // сессиями одного человека.
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + input.ttlSeconds,
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const mac = createHmac('sha256', env.LOCAL_AUTH_SIGNING_KEY).update(body).digest('base64url');
    return `${body}.${mac}`;
  }
}
