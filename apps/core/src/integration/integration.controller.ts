import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  CreateListingRefRequestSchema,
  CreateWebhookRequestSchema,
  ExternalRefSchema,
  GraduateSchema,
  INTEGRATION_DATA_VERSION,
  IntegrationDealSchema,
  IntegrationTokenRequestSchema,
  IntegrationTokenResponseSchema,
  IrsHistoryEntrySchema,
  PublicProfileSchema,
  UuidSchema,
  WebhookCreatedSchema,
  WebhookEndpointSchema,
} from '@unicorn/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Public, ServiceAuth } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import { WebhooksService } from '../events/webhooks.service';
import { IntegrationService, decodeIntegrationCursor } from './integration.service';
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
 */
@ServiceAuth()
@UseGuards(IntegrationGuard)
@Controller('integration')
export class IntegrationController {
  constructor(
    private readonly integration: IntegrationService,
    private readonly webhooks: WebhooksService,
  ) {}

  @Scope('graduates:read')
  @Get('graduates')
  async graduates(
    @Query('season_id') rawSeason: string | undefined,
    @Query('cursor') rawCursor: string | undefined,
    @Query('limit') rawLimit: string | undefined,
    @IntegrationCtx() ctx: IntegrationContext,
  ) {
    const seasonId = rawSeason ? parseOrThrow(UuidSchema, rawSeason) : undefined;
    const limit = parseOrThrow(z.coerce.number().int().min(1).max(100).default(50), rawLimit ?? 50);
    const cursor = rawCursor ? decodeIntegrationCursor(rawCursor) : undefined;

    const result = await this.integration.graduates(ctx, { seasonId, cursor, limit });
    return {
      items: result.items.map((item) => GraduateSchema.parse(item)),
      nextCursor: result.nextCursor,
      dataVersion: INTEGRATION_DATA_VERSION,
    };
  }

  @Scope('passport:read')
  @Get('projects/:id/passport')
  async passport(
    @Param('id') rawId: string,
    @Query('tier') rawTier: string | undefined,
    @IntegrationCtx() ctx: IntegrationContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    // Уровень dataroom во внешний контур не выдаётся: он существует для
    // проверенного инвестора внутри платформы, а не для чужой системы.
    const tier = parseOrThrow(z.enum(['teaser', 'full']).default('teaser'), rawTier ?? 'teaser');
    return this.integration.passport(ctx, id, tier);
  }

  @Scope('passport:read')
  @Get('projects/:id/irs-history')
  async irsHistory(@Param('id') rawId: string, @IntegrationCtx() ctx: IntegrationContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const items = await this.integration.irsHistory(ctx, id);
    return {
      items: items.map((item) => IrsHistoryEntrySchema.parse(item)),
      dataVersion: INTEGRATION_DATA_VERSION,
    };
  }

  @Scope('listing:create')
  @Post('listings')
  async createListing(@Body() rawBody: unknown, @IntegrationCtx() ctx: IntegrationContext) {
    const input = parseOrThrow(CreateListingRefRequestSchema, rawBody);
    return ExternalRefSchema.parse(await this.integration.createListingRef(ctx, input));
  }

  @Scope('deals:read')
  @Get('deals')
  async deals(
    @Query('cursor') rawCursor: string | undefined,
    @Query('limit') rawLimit: string | undefined,
    @IntegrationCtx() ctx: IntegrationContext,
  ) {
    const limit = parseOrThrow(z.coerce.number().int().min(1).max(100).default(50), rawLimit ?? 50);
    const cursor = rawCursor ? decodeIntegrationCursor(rawCursor) : undefined;
    const result = await this.integration.deals(ctx, { cursor, limit });
    return {
      items: result.items.map((item) => IntegrationDealSchema.parse(item)),
      nextCursor: result.nextCursor,
      dataVersion: INTEGRATION_DATA_VERSION,
    };
  }

  @Scope('show:read')
  @Get('projects/:id/public-profile')
  async publicProfile(@Param('id') rawId: string, @IntegrationCtx() ctx: IntegrationContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return PublicProfileSchema.parse(await this.integration.publicProfile(ctx, id));
  }

  @Scope('seasons:read')
  @Get('seasons/current')
  async currentSeason(@IntegrationCtx() ctx: IntegrationContext) {
    return {
      season: await this.integration.currentSeason(ctx),
      dataVersion: INTEGRATION_DATA_VERSION,
    };
  }

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
    const traceId = (request.headers['x-request-id'] as string | undefined) ?? request.id;
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
