import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, Roles } from '../auth/guards';
import type { RequestContext } from '../db/unit-of-work';
import { ENTITY_STATUSES, ENTITY_TYPES, IntelligenceService } from './intelligence.service';

/**
 * Market Intelligence (M137) — внутренний раздел админки.
 *
 * Только администратор: ни организатору, ни персоналу эти сведения не нужны,
 * а отдельной системы ролей ТЗ прямо не просит (§13).
 */

/** Пустая строка из формы — это «нет значения», а не значение. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), 'нужен адрес http или https');

const EntityFieldsSchema = z.object({
  type: z.enum(ENTITY_TYPES),
  name: z.string().trim().min(1).max(300),
  organizationName: optionalText(300),
  description: optionalText(20000),
  websiteUrl: optionalText(2000),
  email: optionalText(320),
  telegram: optionalText(300),
  linkedin: optionalText(2000),
  status: z.enum(ENTITY_STATUSES).default('raw'),
  notes: optionalText(20000),
});

const CreateSchema = EntityFieldsSchema.extend({
  sourceUrl: httpUrl
    .nullish()
    .or(z.literal(''))
    .transform((v) => (v ? v : null)),
});

const UpdateSchema = EntityFieldsSchema.partial();

const AddSourceSchema = z.object({
  url: httpUrl,
  title: optionalText(1000),
  notes: optionalText(20000),
});

const ImportUrlSchema = z.object({
  url: httpUrl,
  entityId: z
    .string()
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
});

const ListQuerySchema = z.object({
  q: z.string().max(200).optional().default(''),
  type: z.enum(ENTITY_TYPES).optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
});

@Roles('admin')
@Controller('admin/intelligence')
export class IntelligenceController {
  constructor(private readonly intelligence: IntelligenceService) {}

  @Get('entities')
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const filter = ListQuerySchema.parse(query);
    return { items: await this.intelligence.list(ctx, { ...filter, q: filter.q.trim() }) };
  }

  @Get('entities/:id')
  async card(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.intelligence.card(ctx, z.string().uuid().parse(id));
  }

  @Post('entities')
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.intelligence.create(ctx, CreateSchema.parse(body));
  }

  @Patch('entities/:id')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.update(ctx, z.string().uuid().parse(id), UpdateSchema.parse(body));
  }

  @Post('entities/:id/sources')
  async addSource(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.addSource(
      ctx,
      z.string().uuid().parse(id),
      AddSourceSchema.parse(body),
    );
  }

  @Get('sources')
  async sources(@Ctx() ctx: RequestContext, @Query('loose') loose: string | undefined) {
    return { items: await this.intelligence.sources(ctx, loose === '1') };
  }

  @Delete('sources/:id')
  @HttpCode(200)
  async removeSource(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.intelligence.removeSource(ctx, z.string().uuid().parse(id));
    return { ok: true };
  }

  @Post('sources/import')
  async importUrl(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.intelligence.importUrl(ctx, ImportUrlSchema.parse(body));
  }

  @Post('import/get-investor')
  @HttpCode(200)
  async importGetInvestor(@Ctx() ctx: RequestContext) {
    return this.intelligence.importGetInvestor(ctx);
  }
}
