import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { INTEGRATION_SCOPES, type IntegrationScope } from '@unicorn/contracts';
import { errors } from '../common/errors';
import { getEnv } from '../config/env';
import { ServiceAccountStateService } from './service-account-state.service';

/**
 * Аутентификация сервис-к-сервису.
 *
 * Субъект здесь — не человек, а чужая система, и это меняет три вещи:
 *
 *  1. **Токен живёт минуты, а не часы.** Его некому «разлогинить»: сервисный
 *     клиент не открывает браузер и не жмёт «выйти». Единственная работающая
 *     защита от утёкшего токена — истечение.
 *  2. **Формат токена намеренно НЕ JWT.** Тот же приём, что у локального
 *     адаптера пользователей: токен интеграции нельзя случайно принять там, где
 *     ждут токен IdP, и наоборот. Аудитория зашита в саму подпись.
 *  3. **Права выражены скоупами, а не ролями.** Скоуп проверяется на каждом
 *     маршруте явно; маршрут без объявленного скоупа не обслуживается вовсе —
 *     забыть объявить нельзя, это отказ, а не открытая дверь.
 */

export const INTEGRATION_SCOPE = 'integration:scope';

/** Требуемый скоуп маршрута. Отсутствие декоратора = маршрут не обслуживается. */
export const Scope = (scope: IntegrationScope) => SetMetadata(INTEGRATION_SCOPE, scope);

export interface IntegrationContext {
  serviceAccountId: string;
  clientId: string;
  scopes: readonly string[];
  traceId: string;
}

export interface IntegrationRequest extends FastifyRequest {
  integration?: IntegrationContext;
}

export const IntegrationCtx = createParamDecorator(
  (_data: unknown, host: ExecutionContext): IntegrationContext => {
    const request = host.switchToHttp().getRequest<IntegrationRequest>();
    if (!request.integration) throw errors.unauthenticated({ stage: 'integration-ctx-missing' });
    return request.integration;
  },
);

interface TokenPayload {
  sub: string;
  cid: string;
  scopes: string[];
  exp: number;
  aud: 'integration';
  /** Рубеж токенов аккаунта (M042). Сверяется с текущим на каждом запросе. */
  ep: number;
}

/** Отдельный контекст подписи: токен интеграции не проверится как токен сессии. */
const SIGNATURE_CONTEXT = 'unicorn-integration-token.v1';

export function issueServiceToken(input: {
  serviceAccountId: string;
  clientId: string;
  scopes: readonly string[];
  /** Рубеж аккаунта на момент выдачи (M042). */
  tokenEpoch: number;
}): { token: string; expiresIn: number } {
  const env = getEnv();
  const ttl = env.INTEGRATION_TOKEN_TTL_SECONDS;
  const payload: TokenPayload = {
    sub: input.serviceAccountId,
    cid: input.clientId,
    scopes: [...input.scopes],
    exp: Math.floor(Date.now() / 1000) + ttl,
    aud: 'integration',
    ep: input.tokenEpoch,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { token: `${body}.${sign(body)}`, expiresIn: ttl };
}

/**
 * Подпись сервисного токена СВОИМ ключом.
 *
 * Раньше здесь стоял ключ пользовательских сессий, длина которого проверяется
 * только при AUTH_MODE=local. В production (AUTH_MODE=oidc) он мог быть пустым,
 * и тогда подпись вычислялась с пустым — то есть общеизвестным — ключом:
 * токен с любыми scope подделывался без секрета. Конфигурация теперь требует
 * отдельный ключ всегда, когда контур включён.
 */
function sign(body: string): string {
  const env = getEnv();
  return createHmac('sha256', env.INTEGRATION_TOKEN_SIGNING_KEY)
    .update(`${SIGNATURE_CONTEXT}.${body}`)
    .digest('base64url');
}

export function verifyServiceToken(token: string): TokenPayload {
  const [body, signature] = token.split('.');
  if (!body || !signature) throw errors.unauthenticated({ stage: 'integration-format' });

  const expected = Buffer.from(sign(body), 'base64url');
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    throw errors.unauthenticated({ stage: 'integration-signature-encoding' });
  }
  // Сравнение подписи — только constant-time (RULES.md §4).
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw errors.unauthenticated({ stage: 'integration-signature' });
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    throw errors.unauthenticated({ stage: 'integration-payload' });
  }
  if (payload.aud !== 'integration') {
    throw errors.unauthenticated({ stage: 'integration-audience' });
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
    throw errors.unauthenticated({ stage: 'integration-expired' });
  }
  if (typeof payload.sub !== 'string' || !Array.isArray(payload.scopes)) {
    throw errors.unauthenticated({ stage: 'integration-claims' });
  }
  return payload;
}

@Injectable()
export class IntegrationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accounts: ServiceAccountStateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IntegrationRequest>();
    // Не сырой заголовок: `request.id` — это тот же внешний идентификатор, но
    // уже прошедший проверку формата (см. acceptableRequestId в main.ts).
    // Чтение заголовка напрямую обходило её и возвращало управляющие символы в
    // журнал (SEC-15).
    const traceId = request.id;

    const required = this.reflector.getAllAndOverride<IntegrationScope>(INTEGRATION_SCOPE, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Маршрут без объявленного скоупа не обслуживается. Это не «доступ всем», а
    // отказ: незаявленное право не может быть выдано.
    if (!required || !INTEGRATION_SCOPES.includes(required)) {
      throw errors.forbidden({ stage: 'integration-scope-undeclared' });
    }

    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw errors.unauthenticated({ stage: 'integration-no-token' });
    }
    const payload = verifyServiceToken(header.slice('Bearer '.length).trim());

    // Проверка действующего состояния аккаунта. Без неё приостановка не имела
    // силы до истечения токена: подпись и срок в токене есть, а «аккаунт ещё
    // существует и не приостановлен» — не проверялось (SEC-08).
    if (!(await this.accounts.isTokenCurrent(payload.sub, payload.ep))) {
      throw errors.unauthenticated({ stage: 'integration-account-state' });
    }

    if (!payload.scopes.includes(required)) {
      // Скоупы клиента наружу не перечисляются: это карта его прав.
      throw errors.forbidden({ stage: 'integration-scope', required, clientId: payload.cid });
    }

    request.integration = {
      serviceAccountId: payload.sub,
      clientId: payload.cid,
      scopes: payload.scopes,
      traceId,
    };
    return true;
  }
}

/**
 * Отпечаток клиентского сертификата из заголовка терминирующего прокси.
 *
 * Возвращает `null`, если проверка не настроена (dev без mTLS). В production
 * пустое имя заголовка не проходит валидацию конфигурации — приложение просто
 * не поднимется, а не начнёт молча пускать по одному лишь секрету.
 */
export function clientCertFingerprint(request: FastifyRequest): string | null {
  const env = getEnv();
  if (!env.INTEGRATION_CLIENT_CERT_HEADER) return null;
  const raw = request.headers[env.INTEGRATION_CLIENT_CERT_HEADER.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value.toLowerCase() : '';
}
