import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import {
  AdminGroupStatusSchema,
  ClearRestrictionRequestSchema,
  FunctionGroupSchema,
  SetRestrictionRequestSchema,
  type FunctionGroup,
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
    return { items: await this.items() };
  }

  @Put(':group')
  async restrict(
    @Param('group') rawGroup: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const group = parseOrThrow(FunctionGroupSchema, rawGroup);
    const input = parseOrThrow(SetRestrictionRequestSchema, rawBody);
    await this.availability.setRestriction(ctx, group, input);
    return this.one(group);
  }

  @Post(':group/clear')
  @HttpCode(200)
  async clear(
    @Param('group') rawGroup: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const group = parseOrThrow(FunctionGroupSchema, rawGroup);
    const input = parseOrThrow(ClearRestrictionRequestSchema, rawBody);
    await this.availability.clearRestriction(ctx, group, input.note);
    return this.one(group);
  }

  private async items() {
    return (await this.availability.adminStatus()).map((g) => AdminGroupStatusSchema.parse(g));
  }

  private async one(group: FunctionGroup) {
    return (await this.items()).find((g) => g.group === group)!;
  }
}
