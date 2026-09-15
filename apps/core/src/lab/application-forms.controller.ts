import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import {
  ActivateApplicationFormRequestSchema,
  ApplicationFormPreviewQuerySchema,
  ApplicationFormQuerySchema,
  ApplicationFormVersionSchema,
  ApplicationFormVersionsSchema,
  ApplicationFormViewSchema,
  DEFAULT_FORM_LOCALE,
  PublishApplicationFormRequestSchema,
  SaveApplicationFormDraftRequestSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { z } from 'zod';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { ApplicationFormsService } from './application-forms.service';

/**
 * Форма заявки для основателя: разделы, вопросы, состояния и тексты по
 * версии, записанной в заявке. Маршрут не публичен; RLS отдаёт форму только
 * тому, кто видит саму заявку.
 */
@Controller()
export class ApplicationFormController {
  constructor(private readonly forms: ApplicationFormsService) {}

  @Get('applications/:id/form')
  async form(@Param('id') rawId: string, @Query() rawQuery: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const query = parseOrThrow(ApplicationFormQuerySchema, rawQuery ?? {});
    return ApplicationFormViewSchema.parse(
      await this.forms.formForApplication(ctx, id, query.locale ?? DEFAULT_FORM_LOCALE),
    );
  }
}

const VersionParamSchema = z.coerce.number().int().positive();

/**
 * Конфигурация вопросов в админке (план 0.2 §0в.4): черновик, предпросмотр,
 * публикация, история, откат. Экран — этап 5; API — здесь, чтобы этап 4 мог
 * проверить форму на опубликованной версии, а не на константе в коде.
 */
@Roles('admin')
@Controller('admin/application-forms')
export class AdminApplicationFormsController {
  constructor(private readonly forms: ApplicationFormsService) {}

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    return ApplicationFormVersionsSchema.parse(await this.forms.listVersions(ctx));
  }

  /** Черновик целиком; создаётся из активной версии, если его ещё нет. */
  @Get('draft')
  async draft(@Ctx() ctx: RequestContext) {
    return ApplicationFormVersionSchema.parse(await this.forms.getDraft(ctx));
  }

  /** Сохранить черновик: документ целиком, с проверками схемы и эволюции. */
  @Put('draft')
  async save(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(SaveApplicationFormDraftRequestSchema, rawBody);
    return ApplicationFormVersionSchema.parse(await this.forms.saveDraft(ctx, input.config));
  }

  /** Форма для стадии и языка из черновика — как увидит основатель. */
  @Get('draft/preview')
  async preview(@Query() rawQuery: unknown, @Ctx() ctx: RequestContext) {
    const query = parseOrThrow(ApplicationFormPreviewQuerySchema, rawQuery ?? {});
    return ApplicationFormViewSchema.parse(
      await this.forms.preview(ctx, query.stage, query.locale ?? DEFAULT_FORM_LOCALE),
    );
  }

  @Post('draft/publish')
  async publish(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(PublishApplicationFormRequestSchema, rawBody);
    return ApplicationFormVersionSchema.parse(await this.forms.publish(ctx, input.reason));
  }

  /** Откат или возврат: активировать ранее опубликованную версию. */
  @Post(':version/activate')
  async activate(
    @Param('version') rawVersion: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const version = parseOrThrow(VersionParamSchema, rawVersion);
    const input = parseOrThrow(ActivateApplicationFormRequestSchema, rawBody);
    return ApplicationFormVersionSchema.parse(
      await this.forms.activate(ctx, version, input.reason),
    );
  }
}
