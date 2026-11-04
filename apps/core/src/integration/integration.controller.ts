import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  CreateWebhookRequestSchema,
  IntegrationTokenRequestSchema,
  IntegrationTokenResponseSchema,
  UuidSchema,
  WebhookCreatedSchema,
  WebhookEndpointSchema,
} from '@fifth/contracts';
import type { FastifyRequest } from 'fastify';
import { Public, ServiceAuth } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import { WebhooksService } from '../events/webhooks.service';
import { IntegrationService } from './integration.service';
import {
  clientCertFingerprint,
  IntegrationCtx,
  IntegrationGuard,
  Scope,
  type IntegrationContext,
} from './service-auth';

/**
 * Integration API — единственная дверь для внешних систем.
 *
 * `@ServiceAuth()` означает «маршрут обслуживается другой схемой
 * аутентификации», а не «открыт всем»: вместо пользовательской сессии работает
 * `IntegrationGuard`, который требует токен сервисного клиента и ЯВНО
 * объявленный скоуп. Маршрут без `@Scope(...)` guard отклоняет — незаявленное
 * право не выдаётся.
 *
 * Прямой доступ к чужой БД не предусмотрен ни в каком виде: только эти
 * маршруты и события (Architect_Launch §6).
 *
 * С 2.1-W05 здесь только общий механизм: токен сервисного клиента и вебхуки.
 * Выдачи выпускников, паспорта, IRS, листингов, сделок и сезона удалены
 * вместе с процессами, на которых держались.
 */
@ServiceAuth()
@UseGuards(IntegrationGuard)
@Controller('integration')
export class IntegrationController {
  constructor(
    private readonly integration: IntegrationService,
    private readonly webhooks: WebhooksService,
  ) {}

  /**
   * Подписка на события. Секрет подписи возвращается один раз — им получатель
   * проверяет, что доставка пришла от нас, а не от того, кто узнал адрес.
   */
  @Scope('webhooks:manage')
  @Post('webhooks')
  async registerWebhook(@Body() rawBody: unknown, @IntegrationCtx() ctx: IntegrationContext) {
    const input = parseOrThrow(CreateWebhookRequestSchema, rawBody);
    return WebhookCreatedSchema.parse(await this.webhooks.register(ctx, input));
  }

  @Scope('webhooks:manage')
  @Get('webhooks')
  async listWebhooks(@IntegrationCtx() ctx: IntegrationContext) {
    const items = await this.webhooks.list(ctx);
    return { items: items.map((item) => WebhookEndpointSchema.parse(item)) };
  }

  @Scope('webhooks:manage')
  @Delete('webhooks/:id')
  async disableWebhook(@Param('id') rawId: string, @IntegrationCtx() ctx: IntegrationContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    await this.webhooks.disable(ctx, id);
    return { disabled: true };
  }
}

/**
 * Выдача токена вынесена в отдельный контроллер намеренно: у неё нет и не может
 * быть скоупа — она его и выдаёт. Держать её внутри контроллера, защищённого
 * `IntegrationGuard`, значило бы требовать токен для получения токена.
 */
@Public()
@Controller('integration')
export class IntegrationTokenController {
  constructor(private readonly integration: IntegrationService) {}

  @Post('token')
  async token(@Body() rawBody: unknown, @Req() request: FastifyRequest) {
    const input = parseOrThrow(IntegrationTokenRequestSchema, rawBody);
    // Не сырой заголовок: `request.id` — это тот же внешний идентификатор, но
    // уже прошедший проверку формата (см. acceptableRequestId в main.ts).
    // Чтение заголовка напрямую обходило её и возвращало управляющие символы в
    // журнал (SEC-15).
    const traceId = request.id;
    const result = await this.integration.issueToken({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      certFingerprint: clientCertFingerprint(request),
      traceId,
    });
    return IntegrationTokenResponseSchema.parse({
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      expiresIn: result.expiresIn,
      scopes: result.scopes,
    });
  }
}
