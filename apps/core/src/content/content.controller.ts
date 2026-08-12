import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  LandingContentSchema,
  LandingBlockSchema,
  LandingLocaleSchema,
  LandingBlockKeySchema,
  PublishLandingBlockSchema,
  UuidSchema,
  WithdrawLandingBlockSchema,
} from '@unicorn/contracts';
import { Ctx, Public, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { ContentService } from './content.service';

/**
 * Публичная витрина: тексты и баннеры.
 *
 * Читается без авторизации — как и цены. Пишется только администратором, и
 * каждая правка попадает в журнал с основанием: тексты витрины являются
 * публичными утверждениями оператора, а не оформлением.
 */
@Controller()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Public()
  @Get('content/landing')
  async landing(@Query('locale') rawLocale: unknown) {
    const locale = parseOrThrow(LandingLocaleSchema.default('ru-RU'), rawLocale ?? 'ru-RU');
    const blocks = await this.content.landing(locale);
    return LandingContentSchema.parse({ locale, blocks });
  }
}

@Controller('admin/content')
export class AdminContentController {
  constructor(private readonly content: ContentService) {}

  @Roles('admin')
  @Post('landing')
  async publish(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(PublishLandingBlockSchema, rawBody);
    return LandingBlockSchema.parse(await this.content.publish(ctx, input));
  }

  @Roles('admin')
  @Post('landing/:id/withdraw')
  async withdraw(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(WithdrawLandingBlockSchema, rawBody);
    await this.content.withdraw(ctx, id, input.reason);
    return { withdrawn: true };
  }

  /** История версий блока: чем и когда заменялся текст на витрине. */
  @Roles('admin')
  @Get('landing/history')
  async history(
    @Query('key') rawKey: unknown,
    @Query('locale') rawLocale: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const key = parseOrThrow(LandingBlockKeySchema, rawKey);
    const locale = parseOrThrow(LandingLocaleSchema.default('ru-RU'), rawLocale ?? 'ru-RU');
    const items = await this.content.history(ctx, key, locale);
    return { items: items.map((b) => LandingBlockSchema.parse(b)) };
  }
}
