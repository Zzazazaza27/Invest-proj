import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  AdminPlanSchema,
  AdminSubscriptionSchema,
  ClosePlanRequestSchema,
  FeatureFlagSchema,
  ProposeCustomPriceRequestSchema,
  PublishPlanRequestSchema,
  UpdateDraftPlanRequestSchema,
  UpdateFeatureFlagRequestSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { z } from 'zod';
import { Ctx, Roles } from '../auth/guards';
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
  constructor(private readonly admin: AdminService) {}

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

  @Post('subscriptions/:id/custom-price')
  async proposeCustomPrice(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(ProposeCustomPriceRequestSchema, rawBody);
    return AdminSubscriptionSchema.parse(await this.admin.proposeCustomPrice(ctx, id, input));
  }

  @Post('subscriptions/:id/custom-price/approve')
  async approveCustomPrice(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return AdminSubscriptionSchema.parse(await this.admin.approveCustomPrice(ctx, id));
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
}
