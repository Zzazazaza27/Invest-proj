import { Body, Controller, Get, Param, Patch, Put } from '@nestjs/common';
import {
  FeatureFlagSchema,
  SetUiSkinRequestSchema,
  UiSkinSchema,
  UpdateFeatureFlagRequestSchema,
} from '@fifth/contracts';
import { z } from 'zod';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { AdminService } from './admin.service';

/**
 * Административный кабинет: флаги функций и скин платформы.
 *
 * Весь контроллер закрыт ролью `admin` на уровне класса: забыть пометить
 * отдельный метод нельзя.
 */
@Roles('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ------------------------------------------------------------- фичефлаги

  @Get('feature-flags')
  async listFlags(@Ctx() ctx: RequestContext) {
    const items = await this.admin.listFeatureFlags(ctx);
    return { items: items.map((f) => FeatureFlagSchema.parse(f)) };
  }

  @Patch('feature-flags/:key')
  async setFlag(
    @Param('key') rawKey: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const key = parseOrThrow(
      z
        .string()
        .min(2)
        .max(80)
        .regex(/^[a-z0-9_.]+$/, 'ключ флага: латиница, цифры, точка и подчёркивание'),
      rawKey,
    );
    const input = parseOrThrow(UpdateFeatureFlagRequestSchema, rawBody);
    return FeatureFlagSchema.parse(
      await this.admin.setFeatureFlag(ctx, key, input.enabled, input.reason),
    );
  }

  /** Скин всей платформы (M145). Только администратор — роль контроллера. */
  @Put('ui-skin')
  async setUiSkin(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(SetUiSkinRequestSchema, rawBody);
    return UiSkinSchema.parse(await this.admin.setUiSkin(ctx, input.skin, input.reason));
  }
}
