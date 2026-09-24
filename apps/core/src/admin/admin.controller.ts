import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  AdminPlanSchema,
  AdminSubscriptionSchema,
  ClosePlanRequestSchema,
  FeatureFlagSchema,
  PublishPlanRequestSchema,
  SetUiSkinRequestSchema,
  UiSkinSchema,
  UpdateDraftPlanRequestSchema,
  UpdateFeatureFlagRequestSchema,
  UuidSchema,
  AiProviderCheckResultSchema,
  AiProviderModelsSchema,
  ListAiProviderModelsRequestSchema,
  AiProviderCredentialSchema,
  LlmProviderSchema,
  UpsertAiProviderCredentialRequestSchema,
} from '@unicorn/contracts';
import { z } from 'zod';
import { AiGatewayClient } from '../ai/ai-gateway.client';
import { ProviderCredentialsService } from '../ai/provider-credentials.service';
import { Ctx, Roles } from '../auth/guards';
import { errors } from '../common/errors';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { AdminService } from './admin.service';

/**
 * Административный кабинет.
 *
 * Весь контроллер закрыт ролью `admin` на уровне класса: забыть пометить
 * отдельный метод нельзя. Организатору сюда доступа нет — управление ценами и
 * фичефлагами это не операционная работа с воронкой, а изменение условий, под
 * которыми люди платят.
 */
@Roles('admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly credentials: ProviderCredentialsService,
    private readonly gateway: AiGatewayClient,
  ) {}

  // ---------------------------------------------------------- ключ LLM-провайдера
  //
  // Ключ задаётся здесь и нигде больше (ADR-008 §2). Ни один маршрут не
  // возвращает его обратно: наружу — отпечаток, модель, автор и время.

  @Get('ai/credentials')
  async listAiCredentials(@Ctx() ctx: RequestContext) {
    const items = await this.credentials.list(ctx);
    return { items: items.map((c) => AiProviderCredentialSchema.parse(c)) };
  }

  @Put('ai/credentials')
  async upsertAiCredential(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(UpsertAiProviderCredentialRequestSchema, rawBody);
    const view = await this.credentials.upsert(ctx, {
      provider: input.provider,
      apiKey: input.apiKey,
      modelName: input.modelName ?? null,
      reason: input.reason,
    });
    return AiProviderCredentialSchema.parse(view);
  }

  /**
   * Каталог моделей провайдера по ключу — до сохранения. Ключ приходит в теле,
   * уходит шлюзу на один вызов и не сохраняется; события аудита нет — это
   * чтение, состояние платформы не меняется.
   */
  @Post('ai/credentials/models')
  async listAiProviderModels(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(ListAiProviderModelsRequestSchema, rawBody);
    const result = await this.gateway.listProviderModels(input, ctx.traceId);
    return AiProviderModelsSchema.parse({ ...result, provider: input.provider });
  }

  @Post('ai/credentials/:provider/revoke')
  async revokeAiCredential(
    @Param('provider') rawProvider: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const provider = parseOrThrow(LlmProviderSchema, rawProvider);
    const input = parseOrThrow(z.object({ reason: z.string().min(3).max(500) }), rawBody);
    await this.credentials.revoke(ctx, provider, input.reason);
    return { revoked: true };
  }

  /**
   * Проверка ключа коротким вызовом провайдера через шлюз. Ключ читается из
   * хранилища и сразу уходит в шлюз; результат — да/нет и имя модели.
   */
  @Post('ai/credentials/:provider/check')
  async checkAiCredential(@Param('provider') rawProvider: string, @Ctx() ctx: RequestContext) {
    const provider = parseOrThrow(LlmProviderSchema, rawProvider);
    const credential = await this.credentials.forCheck(ctx, provider);
    if (!credential) throw errors.notFound({ subject: 'ai_provider_credential' });
    const result = await this.gateway.checkProvider(credential, ctx.traceId);
    await this.credentials.recordCheck(ctx, provider, result.ok);
    return AiProviderCheckResultSchema.parse({ ...result, provider });
  }

  // ---------------------------------------------------------------- тарифы

  @Get('plans')
  async listPlans(@Ctx() ctx: RequestContext) {
    const items = await this.admin.listPlans(ctx);
    return { items: items.map((p) => AdminPlanSchema.parse(p)) };
  }

  /** Публикация новой версии тарифа — в том числе с будущей датой. */
  @Post('plans')
  async publishPlan(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(PublishPlanRequestSchema, rawBody);
    return AdminPlanSchema.parse(await this.admin.publishPlan(ctx, input));
  }

  @Patch('plans/:id')
  async updateDraft(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(UpdateDraftPlanRequestSchema, rawBody);
    return AdminPlanSchema.parse(await this.admin.updateDraftPlan(ctx, id, input));
  }

  /** Отмена объявленного, но ещё не вступившего в силу изменения. */
  @Delete('plans/:id')
  async cancelScheduled(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return this.admin.cancelScheduledPlan(ctx, id);
  }

  /** Снятие тарифа с продажи. Действующие подписки продолжают работать. */
  @Post('plans/:id/close')
  async closePlan(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(ClosePlanRequestSchema, rawBody);
    return AdminPlanSchema.parse(await this.admin.closePlan(ctx, id, input));
  }

  // -------------------------------------------------------------- подписки

  @Get('subscriptions')
  async listSubscriptions(@Query('limit') rawLimit: unknown, @Ctx() ctx: RequestContext) {
    const limit = parseOrThrow(
      z.coerce.number().int().min(1).max(200).default(100),
      rawLimit ?? 100,
    );
    const items = await this.admin.listSubscriptions(ctx, limit);
    return { items: items.map((s) => AdminSubscriptionSchema.parse(s)) };
  }

  @Post('subscriptions/:id/activate')
  async activate(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(z.object({ reason: z.string().trim().min(3).max(500) }), rawBody);
    return AdminSubscriptionSchema.parse(
      await this.admin.activateSubscription(ctx, id, input.reason),
    );
  }

  // ------------------------------------------------------------- фичефлаги

  @Get('feature-flags')
  async listFlags(@Ctx() ctx: RequestContext) {
    const items = await this.admin.listFeatureFlags(ctx);
    return { items: items.map((f) => FeatureFlagSchema.parse(f)) };
  }

  @Patch('feature-flags/:key')
  async setFlag(
    @Param('key') rawKey: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const key = parseOrThrow(
      z
        .string()
        .min(2)
        .max(80)
        .regex(/^[a-z0-9_.]+$/, 'ключ флага: латиница, цифры, точка и подчёркивание'),
      rawKey,
    );
    const input = parseOrThrow(UpdateFeatureFlagRequestSchema, rawBody);
    return FeatureFlagSchema.parse(
      await this.admin.setFeatureFlag(ctx, key, input.enabled, input.reason),
    );
  }

  /** Скин всей платформы (M145). Только администратор — роль контроллера. */
  @Put('ui-skin')
  async setUiSkin(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(SetUiSkinRequestSchema, rawBody);
    return UiSkinSchema.parse(await this.admin.setUiSkin(ctx, input.skin, input.reason));
  }
}
