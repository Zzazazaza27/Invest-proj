import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import {
  NotificationSchema,
  NotificationPreferenceSchema,
  RegisterDeviceRequestSchema,
  UpdatePreferencesRequestSchema,
  UserDeviceSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { z } from 'zod';
import { Ctx } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { NotificationsService } from './notifications.service';

/**
 * Кабинет уведомлений: свои устройства, свои настройки, своя лента.
 *
 * Ни один маршрут здесь не принимает идентификатор пользователя из запроса —
 * он всегда берётся из контекста аутентификации. Параметр `userId` в теле был
 * бы прямым IDOR: настройки чужих уведомлений меняются одной подменой поля.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(@Query('limit') rawLimit: string | undefined, @Ctx() ctx: RequestContext) {
    const limit = parseOrThrow(z.coerce.number().int().min(1).max(100).default(50), rawLimit ?? 50);
    const items = await this.notifications.list(ctx, limit);
    return { items: items.map((item) => NotificationSchema.parse(item)) };
  }

  @Post('devices')
  async registerDevice(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(RegisterDeviceRequestSchema, rawBody);
    return UserDeviceSchema.parse(await this.notifications.registerDevice(ctx, input));
  }

  @Get('devices')
  async listDevices(@Ctx() ctx: RequestContext) {
    const items = await this.notifications.listDevices(ctx);
    return { items: items.map((item) => UserDeviceSchema.parse(item)) };
  }

  @Delete('devices/:id')
  async revokeDevice(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    await this.notifications.revokeDevice(ctx, id);
    return { revoked: true };
  }

  @Get('preferences')
  async preferences(@Ctx() ctx: RequestContext) {
    const items = await this.notifications.getPreferences(ctx);
    return { items: items.map((item) => NotificationPreferenceSchema.parse(item)) };
  }

  @Put('preferences')
  async updatePreferences(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(UpdatePreferencesRequestSchema, rawBody);
    const items = await this.notifications.updatePreferences(ctx, input.items);
    return { items: items.map((item) => NotificationPreferenceSchema.parse(item)) };
  }
}
