import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  GrantCapabilityRequestSchema,
  RevokeCapabilityRequestSchema,
  StaffCapabilityGrantSchema,
  StaffCapabilitySchema,
  UuidSchema,
} from '@fifth/contracts';
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

  @Post('grant')
  async grant(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(GrantCapabilityRequestSchema, rawBody);
    return StaffCapabilityGrantSchema.parse(await this.capabilities.grant(ctx, input));
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
@Roles('admin')
@Controller('me')
export class MyCapabilitiesController {
  constructor(private readonly capabilities: CapabilitiesService) {}

  @Get('capabilities')
  async mine(@Ctx() ctx: RequestContext) {
    return { items: await this.capabilities.mine(ctx) };
  }
}
