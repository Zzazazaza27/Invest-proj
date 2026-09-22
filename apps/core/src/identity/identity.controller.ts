import { Body, Controller, Get, HttpCode, Logger, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  AuthSessionSchema,
  ConsentAcceptanceSchema,
  CurrentUserSchema,
  LoginRequestSchema,
  LocaleSchema,
  LogoutResultSchema,
  RegisterRequestSchema,
  type LogoutResult,
} from '@unicorn/contracts';
import { z } from 'zod';
import { getEnv } from '../config/env';
import { errors } from '../common/errors';
import { parseOrThrow } from '../common/validation';
import { Ctx, CsrfOriginFallback, Public, Roles, type AuthenticatedRequest } from '../auth/guards';
import { TokenVerifier } from '../auth/token.verifier';
import type { RequestContext } from '../db/unit-of-work';
import { IdentityService } from './identity.service';
import { VerificationService } from './verification.service';
import { TestingSessionsService } from '../testing/testing-sessions.service';

/**
 * Аутентификация и профиль.
 *
 * Токен НИКОГДА не возвращается в теле ответа: он уходит в httpOnly-cookie,
 * недоступную JavaScript. В теле — только то, что фронтенду действительно
 * нужно: роли, статус, CSRF-токен и признак необходимости ре-акцепта.
 */
/**
 * Локальный вход доступен только при `AUTH_MODE=local`.
 *
 * В production конфигурация требует `oidc`, а `issueLocal` там запрещён —
 * значит, register/login отрабатывали полностью (включая argon2-хеширование)
 * и падали 500 на самом последнем шаге. Это и мёртвая поверхность, и
 * бесплатный CPU-DoS-усилитель: каждый запрос стоил нам хеширования, а
 * атакующему — ничего (MEDIUM внешнего аудита №2).
 *
 * Отказ — 404, а не 403: 403 подтверждал бы существование маршрута, который
 * в этом режиме не используется вовсе (та же анти-оракульная линия, что у
 * описания API в production).
 */
/**
 * Происхождение записи — и доказательство права его назначить.
 *
 * Сервер не может САМ отличить браузерный проход от человека: и тот и другой
 * приходят обычной регистрацией. Поэтому прогоны называются сами. Вопрос в
 * том, чего стоит такое имя.
 *
 * ПЕРВАЯ ВЕРСИЯ ВЕРИЛА ЗАГОЛОВКУ. Проверялись окружение и список значений —
 * и этого казалось достаточно. Опыт показал обратное: обычный клиент без
 * всякой авторизации регистрировался с `X-Unicorn-Origin: render_check`, и
 * его запись становилась следом прогона. То есть посторонний мог подвести
 * СВОЮ учётную запись под уборку — или, наоборот, спрятать её из списка.
 * Разрешённое значение заголовка не полномочие.
 *
 * ТЕПЕРЬ ОПАСНОЕ ПРОИСХОЖДЕНИЕ ТРЕБУЕТ ДОКАЗАТЕЛЬСТВА. `render_check` и
 * `load_test` — единственные значения, которые уборка вправе удалять, и
 * назначаются они только вместе с `X-Unicorn-Run`: идентификатором ДЕЙСТВУЮЩЕЙ
 * тестовой сессии. Завести её может лишь администратор с полномочием
 * `testing.sessions.manage`, и она же становится владельцем записи. Остальные
 * значения (`seed_*`, `staff_check`) уборке не подлежат и остаются как были.
 */
const CLEANABLE_ORIGINS = new Set(['render_check', 'load_test']);
const SAFE_ORIGINS = new Set(['seed_demo', 'seed_acceptance', 'staff_check']);

export function originFromRequest(request: AuthenticatedRequest): string | undefined {
  if (getEnv().isProduction) return undefined;
  const raw = request.headers['x-unicorn-origin'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  if (SAFE_ORIGINS.has(value)) return value;
  // Опасное значение без доказательства не принимается: право его назначить
  // проверяется отдельно, по действующей сессии.
  return undefined;
}

/**
 * СЕКРЕТ запуска из заголовка — не идентификатор.
 *
 * Идентификатор сессии виден всем: он печатается прогонами, стоит в отчётах
 * и в админке. Пока подтверждением служил он, посторонний, узнавший его, мог
 * создавать записи от имени чужого запуска — проверено опытом. Поэтому здесь
 * принимается секрет, выданный создателю сессии один раз.
 */
export function runTokenFromRequest(request: AuthenticatedRequest): string | undefined {
  if (getEnv().isProduction) return undefined;
  const raw = request.headers['x-unicorn-run'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  // Длина и алфавит — как у выдаваемого секрета: мусор до базы не доходит.
  return /^[A-Za-z0-9_-]{32,64}$/.test(value) ? value : undefined;
}

/** Происхождение, которое просит клиент, если оно вообще подлежит уборке. */
export function cleanableOriginRequested(request: AuthenticatedRequest): string | undefined {
  const raw = request.headers['x-unicorn-origin'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && CLEANABLE_ORIGINS.has(value) ? value : undefined;
}

function assertLocalAuthAvailable(): void {
  if (getEnv().AUTH_MODE !== 'local')
    throw errors.notFound({ subject: 'route', reason: 'oidc-mode' });
}

@Controller('auth')
export class IdentityController {
  private readonly logger = new Logger(IdentityController.name);

  constructor(
    private readonly identity: IdentityService,
    private readonly verifier: TokenVerifier,
    private readonly verification: VerificationService,
    private readonly sessions: TestingSessionsService,
  ) {}

  @Public()
  @Post('register')
  async register(
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertLocalAuthAvailable();
    const input = parseOrThrow(RegisterRequestSchema, rawBody);

    /*
     * Право назвать запись следом прогона проверяется СЕРВЕРОМ.
     *
     * Клиент просит происхождение заголовком, но если оно из тех, что уборка
     * вправе удалять, одной просьбы мало: нужен идентификатор действующей
     * тестовой сессии. Сессию заводит администратор с полномочием, она же
     * становится владельцем записи — и записывается это в той же
     * транзакции, что и сам человек.
     */
    let origin = originFromRequest(request);
    let runSessionId: string | undefined;
    const wanted = cleanableOriginRequested(request);
    if (wanted && !getEnv().isProduction) {
      const token = runTokenFromRequest(request);
      const owned = token ? await this.sessions.runByToken(token) : null;
      if (owned) {
        origin = wanted;
        runSessionId = owned;
      }
    }

    const { userId, roles } = await this.identity.register(input, ctx, origin, runSessionId);
    const missing = await this.identity.missingConsents({ ...ctx, userId, roles }, input.locale);

    const { session, csrfToken } = this.identity.buildSession({
      userId,
      roles,
      status: missing.length === 0 ? 'active' : 'pending_consents',
      reacceptRequired: missing.length > 0,
      mfaEnabled: false,
    });
    this.setSessionCookies(reply, userId, roles, csrfToken);

    // Письмо с подтверждением адреса уходит СРАЗУ, а не по кнопке в кабинете:
    // иначе подтверждение остаётся функцией, о которой знает только тот, кто
    // её искал. Ошибка отправки не отменяет регистрацию — аккаунт создан, и
    // ронять ответ из-за почты значило бы потерять его вместе с акцептами;
    // повторить письмо можно из того же экрана входа.
    await this.verification
      .requestEmailVerification({ ...ctx, userId, roles })
      .catch((error: unknown) => {
        this.logger.warn({
          msg: 'письмо подтверждения при регистрации не отправлено',
          reason: error instanceof Error ? error.message : 'unknown',
          traceId: ctx.traceId,
        });
      });

    return AuthSessionSchema.parse(session);
  }

  @Public()
  @Post('login')
  async login(
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertLocalAuthAvailable();
    const input = parseOrThrow(LoginRequestSchema, rawBody);
    if (!input.email && !input.phone) {
      throw errors.validation([{ path: 'email', message: 'нужен email или телефон' }]);
    }
    const result = await this.identity.verifyPassword(
      { email: input.email, phone: input.phone },
      input.password,
      ctx,
    );
    const missing = await this.identity.missingConsents(
      { ...ctx, userId: result.userId, roles: result.roles },
      'ru-RU',
    );

    const { session, csrfToken } = this.identity.buildSession({
      userId: result.userId,
      roles: result.roles,
      status: result.status,
      reacceptRequired: missing.length > 0,
      mfaEnabled: false,
    });
    this.setSessionCookies(reply, result.userId, result.roles, csrfToken);
    return AuthSessionSchema.parse(session);
  }

  /**
   * Выход.
   *
   * Удаления cookie МАЛО: токен остаётся действительным до `exp`, и
   * скопированное значение продолжает работать (остаток SEC-07/08). Поэтому
   * идентификатор именно этого токена уходит в реестр отзыва — остальные
   * сессии пользователя при этом живут дальше, в отличие от сдвига рубежа.
   *
   * `tokenRevoked: false` означает, что у предъявленного токена нет
   * идентификатора (внешний IdP без claim `jti`): сессия закрыта только на
   * клиенте, и ответ говорит об этом прямо, а не изображает успех.
   */
  @CsrfOriginFallback()
  @Post('logout')
  async logout(
    @Ctx() ctx: RequestContext,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LogoutResult> {
    const env = getEnv();
    const tokenRevoked = await this.identity.revokeCurrentToken(ctx, {
      tokenId: request.auth?.tokenId ?? null,
      expiresAt: request.auth?.expiresAt ?? Date.now(),
    });
    // Обе cookie удаляются с теми же атрибутами, с какими ставились: иначе
    // браузер оставит старую.
    reply.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' });
    reply.clearCookie(env.CSRF_COOKIE_NAME, { path: '/' });
    return LogoutResultSchema.parse({ ok: true, tokenRevoked });
  }

  @Get('me')
  async me(@Ctx() ctx: RequestContext) {
    return CurrentUserSchema.parse(await this.identity.getCurrentUser(ctx));
  }

  /**
   * Привратник служебной консоли: пускать или нет.
   *
   * Консоль — обычная статика, права она проверять не умеет. Опасна не она
   * сама: она даёт постороннему КАРТУ ВСЕГО API одним списком, включая выдачу
   * служебных токенов, вебхуки и ротацию секретов. Поэтому решение принимается
   * до того, как отдан HTML.
   *
   * Маршрут вызывает nginx через `auth_request` (`infra/nginx/local/
   * console.conf`) и смотрит только на код ответа: 204 — пускаем, 401 или 403
   * — отдаём 404, чтобы посторонний не узнал даже о существовании консоли.
   * Тело ответа не нужно и не отдаётся.
   *
   * Проверку делает тот же guard, что и на всех остальных маршрутах: сессия,
   * роль, отзыв токена. Отдельной логики доступа здесь нет намеренно — иначе
   * она разъехалась бы с основной.
   */
  @Roles('admin')
  @Get('authz/console')
  @HttpCode(204)
  consoleAccess(): void {
    // Пустое тело: весь смысл — в том, что guard пропустил запрос сюда.
  }

  /**
   * Действующие версии обязательных документов — ДО регистрации.
   *
   * Публичный маршрут по необходимости: регистрация требует передать версию
   * каждого акцепта, а получить её было неоткуда. Клиенты подставляли версию
   * наугад, попадали в нарушение внешнего ключа и получали 500 — то есть
   * зарегистрироваться, не заглянув в таблицу базы, было нельзя.
   *
   * Отдаётся отпечаток текста, а не сам текст: тексты лежат в хранилище и
   * раздаются отдельно, а здесь важно, ЧТО именно принимает пользователь.
   */
  @Public()
  @Get('consents/templates')
  async consentTemplates(@Query('locale') rawLocale: unknown, @Ctx() ctx: RequestContext) {
    const locale = parseOrThrow(LocaleSchema.default('ru-RU'), rawLocale ?? 'ru-RU');
    return { items: await this.identity.consentTemplates(ctx.traceId, locale) };
  }

  @Post('consents')
  async acceptConsents(
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseOrThrow(
      z.object({ consents: z.array(ConsentAcceptanceSchema).min(1).max(10) }),
      rawBody,
    );
    await this.identity.acceptConsents(ctx, input.consents);
    const missing = await this.identity.missingConsents(ctx);

    const { session } = this.identity.buildSession({
      userId: ctx.userId!,
      roles: (request.auth?.roles ?? []) as never,
      status: missing.length === 0 ? 'active' : 'pending_consents',
      reacceptRequired: missing.length > 0,
      mfaEnabled: false,
    });
    // CSRF-токен не пересоздаётся: текущая сессия остаётся действующей.
    return AuthSessionSchema.parse({ ...session, csrfToken: this.currentCsrf(request) });
  }

  private currentCsrf(request: AuthenticatedRequest): string {
    const env = getEnv();
    const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies;
    return cookies?.[env.CSRF_COOKIE_NAME] ?? '';
  }

  /**
   * Сессионная cookie — httpOnly, Secure, SameSite=Strict, Path=/.
   *
   * CSRF-cookie намеренно ЧИТАЕМА из JS (httpOnly=false): схема double-submit
   * требует, чтобы фронтенд мог скопировать значение в заголовок. Секретом она
   * не является — её роль в том, что межсайтовый запрос не может выставить
   * заголовок.
   */
  private setSessionCookies(
    reply: FastifyReply,
    userId: string,
    roles: string[],
    csrfToken: string,
  ): void {
    const env = getEnv();
    const token = this.verifier.issueLocal({
      subject: userId,
      roles,
      ttlSeconds: env.SESSION_TTL_SECONDS,
    });

    reply.setCookie(env.SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: env.isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: env.SESSION_TTL_SECONDS,
    });
    reply.setCookie(env.CSRF_COOKIE_NAME, csrfToken, {
      httpOnly: false,
      secure: env.isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: env.SESSION_TTL_SECONDS,
    });
  }
}
