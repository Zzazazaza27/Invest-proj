import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ActivateFeeOffsetRuleRequestSchema,
  FeeOffsetRuleSchema,
  FeeTermsSchema,
  InvestorCapabilityStateSchema,
  LinkPlanCapabilityRequestSchema,
  PlanCapabilitySchema,
  SetCapabilityBaselineRequestSchema,
  UnlinkPlanCapabilityRequestSchema,
  PublishFeeTermsRequestSchema,
} from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { CommissionService, PlanCapabilitiesService } from './commission.service';

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

/**
 * Возможности тарифов инвестора (5.9.4). Только администратор.
 *
 * Настраивается СОСТАВ тарифа. Платные ограничения не включаются: базовый
 * просмотр к тарифу не привязывается, а включение проверки отклоняет БД —
 * матрица бесплатного и платного не утверждена владельцем.
 */
@Roles('admin')
@Controller('admin/plan-capabilities')
export class AdminPlanCapabilitiesController {
  constructor(private readonly capabilities: PlanCapabilitiesService) {}

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.capabilities.list(ctx);
    return { items: items.map((c) => PlanCapabilitySchema.parse(c)) };
  }

  @Post('link')
  async link(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(LinkPlanCapabilityRequestSchema, rawBody);
    const items = await this.capabilities.link(ctx, input);
    return { items: items.map((c) => PlanCapabilitySchema.parse(c)) };
  }

  @Post('unlink')
  async unlink(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(UnlinkPlanCapabilityRequestSchema, rawBody);
    const items = await this.capabilities.unlink(ctx, input);
    return { items: items.map((c) => PlanCapabilitySchema.parse(c)) };
  }

  /**
   * Сменить стартовую пометку «доступно всем».
   *
   * Список бесплатных возможностей — настройка администратора, а не правило,
   * зашитое в код: после согласования матрицы состав меняется здесь.
   */
  @Post('baseline')
  async setBaseline(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(SetCapabilityBaselineRequestSchema, rawBody);
    const items = await this.capabilities.setBaseline(ctx, input);
    return { items: items.map((c) => PlanCapabilitySchema.parse(c)) };
  }
}

/** Свои возможности видит сам инвестор: кабинет должен знать, что показывать. */
@Roles('investor', 'admin')
@Controller('me')
export class MyPlanCapabilitiesController {
  constructor(private readonly capabilities: PlanCapabilitiesService) {}

  @Get('plan-capabilities')
  async mine(@Ctx() ctx: RequestContext) {
    const items = await this.capabilities.investorState(ctx, ctx.userId!);
    return { items: items.map((c) => InvestorCapabilityStateSchema.parse(c)) };
  }
}
