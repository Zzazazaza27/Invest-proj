import { Body, Controller, Get, Logger, Post, Query, Req, Res } from '@nestjs/common';
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
import { Ctx, Public, type AuthenticatedRequest } from '../auth/guards';
import { TokenVerifier } from '../auth/token.verifier';
import type { RequestContext } from '../db/unit-of-work';
import { IdentityService } from './identity.service';
import { VerificationService } from './verification.service';

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
  ) {}

  @Public()
  @Post('register')
  async register(
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertLocalAuthAvailable();
    const input = parseOrThrow(RegisterRequestSchema, rawBody);
    const { userId, roles } = await this.identity.register(input, ctx);
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
