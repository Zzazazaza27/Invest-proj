import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import {
  RoundPurchaseViewSchema,
  RoundQuoteSelectionSchema,
  SetItemFulfillmentRequestSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { RoundPurchaseService } from './round-purchase.service';

/**
 * Покупка запуска раунда: выбор, оформление, состояние (5.9.7).
 *
 * Оплата здесь не принимается. Подтверждение оплаты — отдельное действие
 * администратора и только тестовое (см. `AdminRoundPurchasesController`).
 */
@Roles('founder', 'admin')
@Controller('rounds')
export class RoundPurchaseController {
  constructor(private readonly purchases: RoundPurchaseService) {}

  /** Сохранить выбор пакета и докупаемых услуг: черновик намерения. */
  @Put(':id/package-selection')
  async saveSelection(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(RoundQuoteSelectionSchema, rawBody ?? {});
    return this.purchases.saveSelection(ctx, id, input);
  }

  /** Оформить покупку по сохранённому выбору. Сумма берётся из расчёта. */
  @Post(':id/purchase')
  async create(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return RoundPurchaseViewSchema.parse(await this.purchases.createPurchase(ctx, id));
  }

  @Get(':id/purchase')
  async get(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const purchase = await this.purchases.forRound(ctx, id);
    return purchase === null ? { purchase: null } : RoundPurchaseViewSchema.parse(purchase);
  }
}

/**
 * Действия платформы по покупке: тестовое подтверждение оплаты и отметка
 * выполнения услуг.
 *
 * Тестовое подтверждение — не приём платежа: денег никто не переводит. Оно
 * закрыто ролью, флагом и окружением, и покупка навсегда помечается тестовой.
 */
@Roles('admin')
@Controller('admin/round-purchases')
export class AdminRoundPurchasesController {
  constructor(private readonly purchases: RoundPurchaseService) {}

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.purchases.listAll(ctx);
    return { items: items.map((p) => RoundPurchaseViewSchema.parse(p)) };
  }

  @Post(':id/test-payment')
  async confirmTest(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return RoundPurchaseViewSchema.parse(await this.purchases.confirmTestPayment(ctx, id));
  }

  /** Состояние услуги ставит человек и с основанием. */
  @Post('items/:id/fulfillment')
  async setFulfillment(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(SetItemFulfillmentRequestSchema, rawBody);
    return RoundPurchaseViewSchema.parse(await this.purchases.setItemFulfillment(ctx, id, input));
  }
}
