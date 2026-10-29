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
import { RoleSchema, type Role } from '@unicorn/contracts';
import { getEnv } from '../config/env';
import { errors } from '../common/errors';
import type { RequestContext } from '../db/unit-of-work';
import { TokenVerifier } from './token.verifier';
import { SessionEpochService } from './session-epoch.service';
import { TokenRevocationService } from './token-revocation.service';
import { isCsrfTokenValid } from './csrf';
import { AccessContextService, type ResolvedContext } from './access-context.service';

/**
 * Авторизация: deny by default.
 *
 * Маршрут доступен анонимно ТОЛЬКО если помечен `@Public()`. Отсутствие
 * декоратора означает «требуется аутентификация», а не «забыли поставить»
 * (RULES.md §4: маршрут без объявленного требования аутентификации запрещён).
 */

/** Методы, которые сами по себе ничего не меняют. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Роли, известные платформе; прочие роли из токена прав не дают (2.1-W05). */
const KNOWN_ROLES: ReadonlySet<string> = new Set(RoleSchema.options);

/**
 * Роли запроса — только известные платформе. Токен, выданный до удаления
 * ролей `organizer`, `showrunner` и `expert` (2.1-W05), может ещё нести их;
 * здесь они вырезаются. Фильтр — по перечню ролей, а не по списку удалённых:
 * будущая удалённая роль отсечётся так же.
 */
export function knownRoles(roles: readonly string[]): string[] {
  return roles.filter((role) => KNOWN_ROLES.has(role));
}

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_ROLES = 'auth:roles';
export const REQUIRES_STEP_UP = 'auth:step-up';
export const AUTH_SCHEME = 'auth:scheme';
export const CSRF_ORIGIN_FALLBACK = 'auth:csrf-origin-fallback';

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

/**
 * Запасной путь проверки для выхода (5.7, замечание ручного прохода).
 *
 * Обычные действия требуют пару «cookie + заголовок» с подписью, связанной с
 * владельцем сессии. У выхода это создавало тупик: если CSRF-cookie потеряна
 * или устарела (её вычистили, она не дожила до конца сессии), пользователь не
 * мог выйти вообще — сессия оставалась живой, а интерфейс лишь менял экран.
 *
 * Поэтому у выхода — и только у него — есть второй путь: запрос обязан быть
 * `Sec-Fetch-Site: same-origin`. Этот заголовок ставит сам браузер, подделать
 * его со стороннего сайта нельзя, а запрос без него (curl, чужой origin) по
 * этому пути не проходит. Защита не снимается: цена ложного срабатывания —
 * чужой сайт мог бы разлогинить пользователя, но не совершить действие от его
 * имени; цена прежнего поведения — невозможность закрыть сессию.
 */
export const CsrfOriginFallback = () => SetMetadata(CSRF_ORIGIN_FALLBACK, true);

export interface AuthenticatedRequest extends FastifyRequest {
  ctx?: RequestContext;
  /**
   * Контекст доступа: запрос выполняется от лица другого пользователя
   * (M129). `auth` при этом продолжает описывать ИНИЦИАТОРА — того, чей
   * токен предъявлен. Их нельзя путать: журнал обязан различать, кто
   * смотрел и от чьего лица.
   */
  accessContext?: ResolvedContext;
  auth?: {
    subject: string;
    roles: string[];
    acr: string | null;
    /** Идентификатор предъявленного токена: по нему отзывается одна сессия (M038). */
    tokenId: string | null;
    /** Истечение предъявленного токена, мс. Нужно записи в реестр отзыва. */
    expiresAt: number;
  };
}

/**
 * Сведения о предъявленном токене — об ИНИЦИАТОРЕ запроса.
 *
 * Отдельно от `Ctx`: в режиме контекста `Ctx` описывает того, от чьего лица
 * идёт запрос, а `AuthInfo` — того, кто его на самом деле делает. Их
 * смешение и есть та ошибка, из-за которой журнал перестаёт отвечать на
 * вопрос «кто смотрел».
 */
export const AuthInfo = createParamDecorator(
  (_data: unknown, host: ExecutionContext): NonNullable<AuthenticatedRequest['auth']> => {
    const request = host.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth) throw errors.unauthenticated({ stage: 'auth-missing' });
    return request.auth;
  },
);

/** Контекст доступа запроса, если он есть. Панель тестовой вкладки читает его. */
export const AccessCtx = createParamDecorator(
  (_data: unknown, host: ExecutionContext): ResolvedContext | undefined =>
    host.switchToHttp().getRequest<AuthenticatedRequest>().accessContext,
);

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
    private readonly revocations: TokenRevocationService,
    private readonly contexts: AccessContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Не сырой заголовок: `request.id` — это тот же внешний идентификатор, но
    // уже прошедший проверку формата (см. acceptableRequestId в main.ts).
    // Чтение заголовка напрямую обходило её и возвращало управляющие символы в
    // журнал (SEC-15).
    const traceId = request.id;

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
      // Точечный отзыв: выход на одном устройстве не должен ронять остальные
      // сессии, а скопированное значение cookie обязано перестать работать
      // сразу после выхода, а не по истечении срока токена (M038).
      if (await this.revocations.isRevoked(verified.tokenId)) {
        throw errors.unauthenticated({ stage: 'token-revoked' });
      }
    } catch (error) {
      if (!isPublic) throw error;
      request.ctx = { userId: null, roles: [], traceId };
      return true;
    }

    // Единственная точка, где роли токена становятся ролями запроса (`@Roles`
    // и GUC для RLS): неизвестные роли отсекаются здесь.
    const roles = knownRoles(verified.roles);
    request.auth = {
      subject: verified.subject,
      roles,
      acr: verified.acr,
      tokenId: verified.tokenId,
      expiresAt: verified.expiresAt,
    };
    request.ctx = { userId: verified.subject, roles, traceId };

    const originFallback =
      this.reflector.getAllAndOverride<boolean>(CSRF_ORIGIN_FALLBACK, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    this.assertCsrf(request, originFallback);

    // --------------------------------------------- контекст доступа (M129)
    // Ставится ПОСЛЕ проверки токена инициатора и CSRF: подстановка личности
    // не должна ослаблять ни то, ни другое. Дальнейшие проверки ролей идут
    // уже по действующему пользователю — правà инициатора и участника не
    // объединяются.
    const contextId = this.extractContextId(request);
    if (contextId) {
      const resolved = await this.contexts.resolve(
        contextId,
        { userId: verified.subject, roles, tokenId: verified.tokenId },
        traceId,
      );
      request.accessContext = resolved;

      if (resolved.kind === 'guest') {
        // Гость — это НЕ администратор с пустыми правами. Запрос
        // обрабатывается как неавторизованный, хотя административная cookie
        // предъявлена: иначе «гостевая» страница показывала бы то, что
        // видно администратору.
        if (!isPublic) throw errors.unauthenticated({ stage: 'guest-context' });
        request.ctx = { userId: null, roles: [], traceId };
        void this.contexts.touch(resolved.id, { userId: verified.subject, roles }, traceId);
        return true;
      }

      if (resolved.kind === 'readonly' && !SAFE_METHODS.has(request.method.toUpperCase())) {
        // Первый рубеж — метод запроса. Второй, на неявные изменения внутри
        // чтения, стоит в `Database.transaction()`: запрет по методу неполон.
        throw errors.forbidden({ stage: 'view-only-method' });
      }

      request.ctx = {
        userId: resolved.subjectUserId,
        roles: resolved.subjectRoles,
        traceId,
        viewOnly: resolved.kind === 'readonly',
        initiatorUserId: resolved.initiatorUserId,
        testSessionId: resolved.sessionId,
      };
      void this.contexts.touch(resolved.id, { userId: verified.subject, roles }, traceId);

      const requiredInContext = this.reflector.getAllAndOverride<Role[]>(REQUIRED_ROLES, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (requiredInContext && requiredInContext.length > 0) {
        const has = requiredInContext.some((role) => resolved.subjectRoles.includes(role));
        if (!has)
          throw errors.forbidden({ required: requiredInContext, actual: resolved.subjectRoles });
      }
      return true;
    }

    const required = this.reflector.getAllAndOverride<Role[]>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && required.length > 0) {
      const has = required.some((role) => roles.includes(role));
      if (!has) throw errors.forbidden({ required, actual: roles });
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

  /**
   * Идентификатор контекста приходит ЗАГОЛОВКОМ, а не cookie.
   *
   * Это и даёт разделение вкладок: административная вкладка заголовка не
   * шлёт и остаётся административной. Cookie так не умеет — она общая на
   * весь origin, и переключение в одной вкладке меняло бы личность во всех.
   */
  private extractContextId(request: AuthenticatedRequest): string | null {
    const raw = request.headers['x-unicorn-context'];
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    return value.length > 0 ? value : null;
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
  private assertCsrf(request: AuthenticatedRequest, originFallback = false): void {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return;

    const env = getEnv();
    const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies;
    const fromCookie = cookies?.[env.CSRF_COOKIE_NAME];
    const fromHeader = request.headers['x-csrf-token'];
    // `Sec-Fetch-Site` ставит браузер, а не страница: со стороннего сайта
    // сюда попадёт `cross-site`, из curl заголовка не будет вовсе.
    const sameOrigin = request.headers['sec-fetch-site'] === 'same-origin';

    if (typeof fromCookie !== 'string' || typeof fromHeader !== 'string') {
      // Выход с потерянной парой: пропускаем только доказанный same-origin,
      // иначе закрыть сессию было бы невозможно (5.7, ручной проход).
      if (originFallback && sameOrigin) return;
      throw errors.forbidden({ stage: 'csrf-missing' });
    }
    const a = Buffer.from(fromCookie);
    const b = Buffer.from(fromHeader);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      if (originFallback && sameOrigin) return;
      throw errors.forbidden({ stage: 'csrf-mismatch' });
    }

    // Совпадения cookie и заголовка МАЛО: обе части подконтрольны тому, кто смог
    // поставить жертве свою cookie (перехваченный поддомен, dns takeover).
    // Поэтому проверяется ещё и подпись, связывающая токен с владельцем
    // сессии: изготовить её под чужой аккаунт без ключа сервера нельзя (SEC-12).
    const subject = request.auth?.subject;
    if (!subject || !isCsrfTokenValid(subject, fromCookie)) {
      // Устаревшая подпись (смена владельца cookie, истёкший токен) — тот же
      // запасной путь: выход обязан оставаться доступным.
      if (originFallback && sameOrigin) return;
      throw errors.forbidden({ stage: 'csrf-unbound' });
    }

    // Дополнительный барьер: браузер сообщает происхождение запроса сам.
    const site = request.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'same-site') {
      throw errors.forbidden({ stage: 'cross-site', site });
    }
  }
}
