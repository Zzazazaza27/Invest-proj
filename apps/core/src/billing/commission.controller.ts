import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ActivateFeeOffsetRuleRequestSchema,
  FeeOffsetRuleSchema,
  FeeTermsSchema,
  PublishFeeTermsRequestSchema,
} from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { CommissionService } from './commission.service';

/**
 * Условия вознаграждения и правило зачёта (5.9.3). Только администратор.
 *
 * Сами начисления здесь не создаются и не правятся: они возникают только в
 * команде подтверждения транша. Экран настраивает условия, а не деньги.
 */
@Roles('admin')
@Controller('admin/fee-schedules')
export class AdminFeeTermsController {
  constructor(private readonly commission: CommissionService) {}

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.commission.listTerms(ctx);
    return { items: items.map((t) => FeeTermsSchema.parse(t)) };
  }

  @Post()
  async publish(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(PublishFeeTermsRequestSchema, rawBody);
    return FeeTermsSchema.parse(await this.commission.publishTerms(ctx, input));
  }
}

@Roles('admin')
@Controller('admin/fee-offset-rules')
export class AdminFeeOffsetRulesController {
  constructor(private readonly commission: CommissionService) {}

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.commission.listOffsetRules(ctx);
    return { items: items.map((r) => FeeOffsetRuleSchema.parse(r)) };
  }

  /** Включение отклоняется, пока правило зачёта не утверждено владельцем. */
  @Post()
  async activate(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(ActivateFeeOffsetRuleRequestSchema, rawBody);
    return FeeOffsetRuleSchema.parse(await this.commission.activateOffsetRule(ctx, input));
  }
}
