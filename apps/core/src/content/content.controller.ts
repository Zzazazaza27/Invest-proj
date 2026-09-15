import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import {
  LandingContentSchema,
  LandingBlockSchema,
  LandingLocaleSchema,
  LandingBlockKeySchema,
  LanguageSchema,
  PublishLandingBlockSchema,
  TextEntrySchema,
  TextKeySchema,
  TextLocaleSchema,
  TextNamespaceSchema,
  TextVersionSchema,
  TextsResponseSchema,
  UpsertTextEntrySchema,
  UuidSchema,
  WithdrawLandingBlockSchema,
} from '@unicorn/contracts';
import { z } from 'zod';
import { Ctx, Public, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { ContentService } from './content.service';
import { TextsService } from './texts.service';

/**
 * Публичная витрина: тексты и баннеры.
 *
 * Читается без авторизации — как и цены. Пишется только администратором, и
 * каждая правка попадает в журнал с основанием: тексты витрины являются
 * публичными утверждениями оператора, а не оформлением.
 */
const TextsQuerySchema = z.object({
  namespace: TextNamespaceSchema,
  locale: TextLocaleSchema.optional(),
});

@Controller()
export class ContentController {
  constructor(
    private readonly content: ContentService,
    private readonly textsService: TextsService,
  ) {}

  @Public()
  @Get('content/landing')
  async landing(@Query('locale') rawLocale: unknown) {
    const locale = parseOrThrow(LandingLocaleSchema.default('ru-RU'), rawLocale ?? 'ru-RU');
    const blocks = await this.content.landing(locale);
    return LandingContentSchema.parse({ locale, blocks });
  }

  /** Словарь и ЧАВО на языке с fallback на ru-RU (план 0.2 §2.6). Публично. */
  @Public()
  @Get('content/texts')
  async texts(@Query() rawQuery: unknown, @Ctx() ctx: RequestContext) {
    const query = parseOrThrow(TextsQuerySchema, rawQuery ?? {});
    return TextsResponseSchema.parse(
      await this.textsService.texts(ctx.traceId, query.namespace, query.locale ?? 'ru-RU'),
    );
  }

  @Public()
  @Get('content/languages')
  async languages(@Ctx() ctx: RequestContext) {
    const items = await this.textsService.languages(ctx.traceId);
    return { items: items.map((l) => LanguageSchema.parse(l)) };
  }
}

/** Редактор словаря и ЧАВО: записи, версии с основанием, история (этап 5.3). */
@Roles('admin')
@Controller('admin/content/texts')
export class AdminTextsController {
  constructor(private readonly texts: TextsService) {}

  @Get()
  async list(@Query('namespace') rawNamespace: unknown, @Ctx() ctx: RequestContext) {
    const namespace = parseOrThrow(TextNamespaceSchema, rawNamespace);
    const items = await this.texts.list(ctx, namespace);
    return { items: items.map((e) => TextEntrySchema.parse(e)) };
  }

  @Put(':namespace/:key')
  async upsert(
    @Param('namespace') rawNamespace: string,
    @Param('key') rawKey: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const namespace = parseOrThrow(TextNamespaceSchema, rawNamespace);
    const key = parseOrThrow(TextKeySchema, rawKey);
    const input = parseOrThrow(UpsertTextEntrySchema, rawBody);
    return TextEntrySchema.parse(await this.texts.upsert(ctx, namespace, key, input));
  }

  @Get(':namespace/:key/history')
  async history(
    @Param('namespace') rawNamespace: string,
    @Param('key') rawKey: string,
    @Ctx() ctx: RequestContext,
  ) {
    const namespace = parseOrThrow(TextNamespaceSchema, rawNamespace);
    const key = parseOrThrow(TextKeySchema, rawKey);
    const items = await this.texts.history(ctx, namespace, key);
    return { items: items.map((v) => TextVersionSchema.parse(v)) };
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
