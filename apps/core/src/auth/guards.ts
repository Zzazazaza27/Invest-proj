import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Role } from '@unicorn/contracts';
import { getEnv } from '../config/env';
import { errors } from '../common/errors';
import type { RequestContext } from '../db/unit-of-work';
import { TokenVerifier } from './token.verifier';
import { SessionEpochService } from './session-epoch.service';

/**
 * Авторизация: deny by default.
 *
 * Маршрут доступен анонимно ТОЛЬКО если помечен `@Public()`. Отсутствие
 * декоратора означает «требуется аутентификация», а не «забыли поставить»
 * (RULES.md §4: маршрут без объявленного требования аутентификации запрещён).
 */

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_ROLES = 'auth:roles';
export const REQUIRES_STEP_UP = 'auth:step-up';
export const AUTH_SCHEME = 'auth:scheme';

/** Маршрут доступен без аутентификации. Ставится осознанно и заметно. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Маршрут обслуживается ДРУГОЙ схемой аутентификации (Integration API,
 * service-to-service), у которой свой guard и свой формат токена.
 *
 * Это не «público»: доступ по-прежнему закрыт, просто проверяет его не
 * `AuthGuard`. Без этой пометки пользовательский guard попытался бы разобрать
 * сервисный токен как токен IdP и отклонил бы запрос раньше, чем до него дошёл
 * профильный guard — что и случилось при первом живом прогоне Ф9.
 */
export const ServiceAuth = () => SetMetadata(AUTH_SCHEME, 'service');

/** Требуемые роли. Пустой список недопустим — это была бы тихая дыра. */
export const Roles = (...roles: Role[]) => SetMetadata(REQUIRED_ROLES, roles);

/** Операция требует подтверждения вторым фактором (Architect_Launch §7). */
export const StepUp = () => SetMetadata(REQUIRES_STEP_UP, true);

export interface AuthenticatedRequest extends FastifyRequest {
  ctx?: RequestContext;
  auth?: { subject: string; roles: string[]; acr: string | null };
}

export const Ctx = createParamDecorator(
  (_data: unknown, host: ExecutionContext): RequestContext => {
    const request = host.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.ctx) throw errors.unauthenticated({ stage: 'ctx-missing' });
    return request.ctx;
  },
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly epochs: SessionEpochService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const traceId = (request.headers['x-request-id'] as string | undefined) ?? request.id;

    // Маршрут чужой схемы аутентификации: пользовательский контекст здесь не
    // создаётся вовсе, проверку выполняет профильный guard контроллера.
    const scheme = this.reflector.getAllAndOverride<string>(AUTH_SCHEME, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (scheme === 'service') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    const token = this.extractToken(request);

    if (!token) {
      if (isPublic) {
        // Анонимный контекст: RLS покажет ровно то, что разрешено публично.
        request.ctx = { userId: null, roles: [], traceId };
        return true;
      }
      throw errors.unauthenticated({ stage: 'no-token' });
    }

    // На ПУБЛИЧНОМ маршруте негодный токен означает «аноним», а не отказ.
    // Иначе протухшая или отозванная cookie делает невозможным сам вход:
    // запрос к /auth/login отклонялся бы раньше, чем дошёл до проверки пароля,
    // и пользователь оставался бы заперт снаружи до ручной очистки cookie.
    // Поймано прогоном отзыва прав: после отзыва повторный вход давал 401.
    let verified;
    try {
      verified = await this.verifier.verify(token);
      if (!(await this.epochs.isTokenValid(verified.subject, verified.issuedAt))) {
        // Токен, выпущенный до сдвига рубежа, недействителен: именно так снятая
        // роль перестаёт действовать сразу, а не по истечении часа (SEC-08).
        throw errors.unauthenticated({ stage: 'session-revoked' });
      }
    } catch (error) {
      if (!isPublic) throw error;
      request.ctx = { userId: null, roles: [], traceId };
      return true;
    }

    request.auth = { subject: verified.subject, roles: verified.roles, acr: verified.acr };
    request.ctx = { userId: verified.subject, roles: verified.roles, traceId };

    this.assertCsrf(request);

    const required = this.reflector.getAllAndOverride<Role[]>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && required.length > 0) {
      const has = required.some((role) => verified.roles.includes(role));
      if (!has) throw errors.forbidden({ required, actual: verified.roles });
    }

    const needsStepUp = this.reflector.getAllAndOverride<boolean>(REQUIRES_STEP_UP, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (needsStepUp && verified.acr !== 'mfa') {
      throw errors.stepUpRequired();
    }

    return true;
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    const env = getEnv();
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length).trim() || null;
    }
    const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies;
    return cookies?.[env.SESSION_COOKIE_NAME] ?? null;
  }

  /**
   * Double-submit CSRF: значение из cookie обязано совпасть с заголовком.
   *
   * Проверяется только для cookie-сессий и небезопасных методов. Для Bearer
   * CSRF неприменим: браузер не подставляет заголовок Authorization
   * автоматически, а значит и подделать межсайтовый запрос нечем.
   */
  private assertCsrf(request: AuthenticatedRequest): void {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return;

    const env = getEnv();
    const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies;
    const fromCookie = cookies?.[env.CSRF_COOKIE_NAME];
    const fromHeader = request.headers['x-csrf-token'];

    if (typeof fromCookie !== 'string' || typeof fromHeader !== 'string') {
      throw errors.forbidden({ stage: 'csrf-missing' });
    }
    const a = Buffer.from(fromCookie);
    const b = Buffer.from(fromHeader);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw errors.forbidden({ stage: 'csrf-mismatch' });
    }

    // Дополнительный барьер: браузер сообщает происхождение запроса сам.
    const site = request.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'same-site') {
      throw errors.forbidden({ stage: 'cross-site', site });
    }
  }
}
