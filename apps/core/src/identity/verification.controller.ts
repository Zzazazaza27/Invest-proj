import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AcceptedSchema,
  EmailVerificationStatusSchema,
  EmailVerifyRequestSchema,
  PasswordForgotRequestSchema,
  PasswordResetCheckSchema,
  PasswordResetRequestSchema,
} from '@fifth/contracts';
import { Ctx, Public } from '../auth/guards';
import { errors } from '../common/errors';
import { parseOrThrow } from '../common/validation';
import { getEnv } from '../config/env';
import type { RequestContext } from '../db/unit-of-work';
import { VerificationService } from './verification.service';

/**
 * Восстановление пароля и подтверждение адреса почты.
 *
 * Маршруты живут под префиксом `/v1/auth/`, и это не только про порядок: класс
 * ограничения частоты определяется по началу пути (`main.ts`), и `auth` —
 * самый жёсткий. Вынести их, скажем, в `/v1/password/`, значило бы тихо
 * перевести подбор ссылки восстановления в общий лимит, вчетверо мягче.
 *
 * Три из четырёх маршрутов публичные по необходимости: человек, забывший
 * пароль, сессии не имеет, а ссылку подтверждения открывают из письма — иногда
 * в другом браузере.
 */
@Controller('auth')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  /**
   * Запрос ссылки на смену пароля.
   *
   * 202 и один и тот же текст — всегда: и когда письмо ушло, и когда такого
   * адреса нет, и когда по этому адресу уже отправили слишком много писем.
   * Любое различие превращает форму в инструмент перечисления пользователей.
   */
  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  async forgot(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    assertLocalAuthAvailable();
    const input = parseOrThrow(PasswordForgotRequestSchema, rawBody);
    await this.verification.requestPasswordReset(ctx, input.email);
    return AcceptedSchema.parse({ status: 'accepted' });
  }

  /** Смена пароля по ссылке из письма. */
  @Public()
  @Post('password/reset')
  @HttpCode(200)
  async reset(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    assertLocalAuthAvailable();
    const input = parseOrThrow(PasswordResetRequestSchema, rawBody);
    await this.verification.resetPassword(ctx, input.token, input.password);
    // Сессия НЕ открывается: смена пароля — не вход. Автоматический вход по
    // ссылке из письма означал бы, что доступ к почте эквивалентен паролю не
    // только для восстановления, но и прямо сейчас, без ввода нового пароля.
    return { ok: true };
  }

  /** Действует ли ссылка смены пароля: страница спрашивает при открытии. */
  @Public()
  @Post('password/reset/check')
  @HttpCode(200)
  async resetCheck(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    assertLocalAuthAvailable();
    const input = parseOrThrow(PasswordResetCheckSchema, rawBody);
    await this.verification.checkPasswordReset(ctx, input.token);
    return { ok: true };
  }

  /** Запрос письма с подтверждением своего адреса. Нужна открытая сессия. */
  @Post('email/verify/request')
  @HttpCode(202)
  async requestEmailVerification(@Ctx() ctx: RequestContext) {
    return this.verification.requestEmailVerification(ctx);
  }

  /** Переход по ссылке подтверждения. Сессия не нужна: письмо открывают где угодно. */
  @Public()
  @Post('email/verify/confirm')
  @HttpCode(200)
  async confirmEmail(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(EmailVerifyRequestSchema, rawBody);
    await this.verification.confirmEmail(ctx, input.token);
    return { verified: true };
  }

  @Get('email/verify/status')
  async emailStatus(@Ctx() ctx: RequestContext) {
    return EmailVerificationStatusSchema.parse(await this.verification.emailStatus(ctx));
  }
}

/**
 * Восстановление пароля существует только при локальном входе.
 *
 * При `AUTH_MODE=oidc` пароля у платформы нет вовсе — он живёт у внешнего
 * провайдера, и «сменить» его здесь нечем. Ответ 404, а не 403: 403
 * подтверждал бы существование маршрута, который в этом режиме не используется
 * (та же линия, что у register/login в Ф40).
 */
function assertLocalAuthAvailable(): void {
  if (getEnv().AUTH_MODE !== 'local') {
    throw errors.notFound({ subject: 'route', reason: 'oidc-mode' });
  }
}
