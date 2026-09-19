import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  AssignDealSupportRequestSchema,
  DealSupportAssignmentRowSchema,
  DealSupportAssignmentSchema,
  GrantCapabilityRequestSchema,
  RevokeDealSupportRequestSchema,
  RevokeCapabilityRequestSchema,
  StaffCapabilityGrantSchema,
  StaffCapabilitySchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { CapabilitiesService } from './capabilities.service';

/**
 * Каталог функциональных полномочий и их выдача (M097).
 *
 * Каталог перечисляет РЕАЛИЗОВАННЫЕ функции: администратор выбирает из него,
 * а не придумывает строки. Выдаёт и отзывает только администратор —
 * сотрудник не может расширить собственные права.
 *
 * Полноценный экран с блоками разделов и галочками — отдельная задача; здесь
 * готова модель данных и API, на которых он соберётся без переделки.
 */
@Roles('admin')
@Controller('admin/capabilities')
export class AdminCapabilitiesController {
  constructor(private readonly capabilities: CapabilitiesService) {}

  @Get()
  async catalog(@Ctx() ctx: RequestContext) {
    const items = await this.capabilities.catalog(ctx);
    return { items: items.map((c) => StaffCapabilitySchema.parse(c)) };
  }

  @Get('users/:id')
  async grantsOf(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const userId = parseOrThrow(UuidSchema, rawId);
    const items = await this.capabilities.grantsOf(ctx, userId);
    return { items: items.map((g) => StaffCapabilityGrantSchema.parse(g)) };
  }

  /** Действующие назначения на сопровождение: кого и на какой проект. */
  @Get('deal-support')
  async dealSupport(
    @Query('projectId') rawProject: string | undefined,
    @Query('userId') rawUser: string | undefined,
    @Ctx() ctx: RequestContext,
  ) {
    const filter = {
      ...(rawProject ? { projectId: parseOrThrow(UuidSchema, rawProject) } : {}),
      ...(rawUser ? { userId: parseOrThrow(UuidSchema, rawUser) } : {}),
    };
    const items = await this.capabilities.listDealSupport(ctx, filter);
    return { items: items.map((a) => DealSupportAssignmentRowSchema.parse(a)) };
  }

  @Post('grant')
  async grant(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(GrantCapabilityRequestSchema, rawBody);
    return StaffCapabilityGrantSchema.parse(await this.capabilities.grant(ctx, input));
  }

  /**
   * Назначение на сопровождение сделок проекта — ОБЛАСТЬ работы, не права.
   * Рецензентом от этого не становятся: данные проекта не открываются.
   */
  @Post('deal-support')
  async assignDealSupport(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(AssignDealSupportRequestSchema, rawBody);
    return DealSupportAssignmentSchema.parse(await this.capabilities.assignDealSupport(ctx, input));
  }

  @Post('deal-support/revoke')
  async revokeDealSupport(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(RevokeDealSupportRequestSchema, rawBody);
    await this.capabilities.revokeDealSupport(ctx, input);
    return { revoked: true };
  }

  /** Отзыв закрывает доступ на следующем запросе. */
  @Post('revoke')
  async revoke(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(RevokeCapabilityRequestSchema, rawBody);
    await this.capabilities.revoke(ctx, input);
    return { revoked: true };
  }
}

/** Свои полномочия видит сам сотрудник: кабинет прячет недоступные действия. */
@Roles('admin', 'expert', 'organizer')
@Controller('me')
export class MyCapabilitiesController {
  constructor(private readonly capabilities: CapabilitiesService) {}

  @Get('capabilities')
  async mine(@Ctx() ctx: RequestContext) {
    return { items: await this.capabilities.mine(ctx) };
  }
}
