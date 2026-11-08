import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import {
  AdminGroupStatusSchema,
  ClearRestrictionRequestSchema,
  SetRestrictionRequestSchema,
} from '@fifth/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { AvailabilityService } from './availability.service';

/**
 * Доступность групп функций для эксплуатации (4.11). Ручное ограничение вводит и снимает
 * только сотрудник с полномочием `ops.availability.update` (проверка в службе, RLS —
 * последняя защита). Автоматическое восстановление его не снимает.
 */
@Roles('admin')
@Controller('admin/availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  async status() {
    return { items: [AdminGroupStatusSchema.parse(await this.availability.adminStatus())] };
  }

  @Put('files')
  async restrict(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(SetRestrictionRequestSchema, rawBody);
    await this.availability.setRestriction(ctx, input);
    return AdminGroupStatusSchema.parse(await this.availability.adminStatus());
  }

  @Post('files/clear')
  @HttpCode(200)
  async clear(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(ClearRestrictionRequestSchema, rawBody);
    await this.availability.clearRestriction(ctx, input.note);
    return AdminGroupStatusSchema.parse(await this.availability.adminStatus());
  }
}
