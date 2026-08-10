import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  CreateSubscriptionRequestSchema,
  SubscriptionSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { BillingService } from './billing.service';

/**
 * Подписки пользователя.
 *
 * Клиент выбирает ПРОЕКТ (или просто оформляет подписку инвестора), но не план
 * и не цену: тариф резолвит сервер. Иначе цену можно было бы занизить, подставив
 * чужой `planId` — а снапшот цены попадает в подписку и определяет, сколько
 * человек платит.
 *
 * Пути `/v1/billing/subscriptions` отнесены к денежному классу ограничения
 * частоты (10/мин) — см. `main.ts`.
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post('subscriptions')
  async create(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(CreateSubscriptionRequestSchema, rawBody);
    return SubscriptionSchema.parse(await this.billing.createSubscription(ctx, input));
  }

  @Get('subscriptions')
  async listMine(@Ctx() ctx: RequestContext) {
    const items = await this.billing.listMine(ctx);
    return { items: items.map((s) => SubscriptionSchema.parse(s)) };
  }

  @Post('subscriptions/:id/cancel')
  async cancel(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return SubscriptionSchema.parse(await this.billing.cancel(ctx, id));
  }
}
