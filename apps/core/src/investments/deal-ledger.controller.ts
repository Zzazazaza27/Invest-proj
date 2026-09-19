import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  CancelTrancheReturnRequestSchema,
  CommissionAdjustmentSchema,
  DealLedgerSchema,
  DealSummarySchema,
  RecordCommissionAdjustmentRequestSchema,
  RecordTrancheReturnRequestSchema,
  TrancheReturnSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { DealLedgerService } from './deal-ledger.service';

/**
 * Ручные денежные записи по сделке (M097).
 *
 * Отдельный путь `investments/deals`, а не `agreements`: там живёт сделочный
 * контур со своими правилами, а здесь — ручные записи сотрудников.
 *
 * `@Roles` здесь пропускает сотрудников платформы, но НИЧЕГО не разрешает:
 * каждое действие отдельно проверяет функциональное полномочие и область
 * работы в сервисе. Роль — это «кто вы», а не «что вам можно».
 */
@Roles('admin', 'expert')
@Controller('investments/deals')
export class DealLedgerController {
  constructor(private readonly ledger: DealLedgerService) {}

  /** Сделки, доступные сотруднику: список для ручных записей. */
  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.ledger.list(ctx);
    return { items: items.map((d) => DealSummarySchema.parse(d)) };
  }

  @Get(':id/ledger')
  async get(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return DealLedgerSchema.parse(await this.ledger.ledger(ctx, id));
  }

  /** Запись о состоявшемся возврате, а не команда перечислить деньги. */
  @Post('tranche-returns')
  async recordReturn(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(RecordTrancheReturnRequestSchema, rawBody);
    return TrancheReturnSchema.parse(await this.ledger.recordReturn(ctx, input));
  }

  @Post('tranche-returns/:id/cancel')
  async cancelReturn(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(CancelTrancheReturnRequestSchema, rawBody);
    return TrancheReturnSchema.parse(await this.ledger.cancelReturn(ctx, id, input));
  }

  /** Уменьшение начисления и возврат уплаченного — разные полномочия. */
  @Post('commission-adjustments')
  async recordAdjustment(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(RecordCommissionAdjustmentRequestSchema, rawBody);
    return CommissionAdjustmentSchema.parse(await this.ledger.recordAdjustment(ctx, input));
  }
}
