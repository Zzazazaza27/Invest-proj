import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import {
  NotificationTemplateSchema,
  UpsertNotificationTemplateSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { z } from 'zod';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { TemplatesService } from './templates.service';

/**
 * Тексты уведомлений в админке.
 *
 * До этого они правились только миграцией: изменить формулировку означало
 * выкатить релиз базы. Правка текста — операционное действие, а не изменение
 * схемы, и место ему в административном контуре под журналом.
 */
@Roles('admin')
@Controller('admin/notification-templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  async list(@Query('code') rawCode: string | undefined, @Ctx() ctx: RequestContext) {
    const code = rawCode === undefined ? undefined : parseOrThrow(z.string().max(100), rawCode);
    const items = await this.templates.list(ctx, code);
    return { items: items.map((item) => NotificationTemplateSchema.parse(item)) };
  }

  @Post()
  async upsert(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(UpsertNotificationTemplateSchema, rawBody);
    return NotificationTemplateSchema.parse(await this.templates.upsert(ctx, input));
  }

  @Delete(':id')
  async deactivate(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return NotificationTemplateSchema.parse(await this.templates.deactivate(ctx, id));
  }
}
