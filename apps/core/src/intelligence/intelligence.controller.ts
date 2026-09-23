import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, Roles } from '../auth/guards';
import type { RequestContext } from '../db/unit-of-work';
import {
  ALIVE,
  CONTACTS,
  DISCOVERY,
  ENTITY_STATUSES,
  ENTITY_TYPES,
  IntelligenceService,
  LEVELS,
  PARSEABLE,
  RELIABILITY,
  REVIEW,
  SOURCE_VERIFICATION,
  SOURCE_TYPES,
  VERIFICATION,
} from './intelligence.service';

/**
 * Market Intelligence — внутренний раздел админки.
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

/** Пустой выбор в форме — «не указано». */
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .enum(values)
    .nullish()
    .or(z.literal(''))
    .transform((v) => (v ? v : null));

const optionalUuid = z
  .string()
  .uuid()
  .nullish()
  .or(z.literal(''))
  .transform((v) => (v ? v : null));

/** Да / нет / не знаю: пусто — «не знаю», а не «нет». */
const optionalBool = z
  .union([z.boolean(), z.literal('true'), z.literal('false'), z.literal('')])
  .nullish()
  .transform((v) =>
    v === true || v === 'true' ? true : v === false || v === 'false' ? false : null,
  );

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

const FactFieldsSchema = z.object({
  role: optionalText(300),
  action: optionalText(4000),
  happenedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'дата в виде ГГГГ-ММ-ДД')
    .nullish()
    .or(z.literal(''))
    .transform((v) => (v ? v : null)),
  happenedPrecision: optionalEnum(['day', 'month', 'year'] as const),
  organizationId: optionalUuid,
  eventId: optionalUuid,
  verification: z.enum(VERIFICATION).optional(),
  evidence: optionalText(2000),
  notes: optionalText(20000),
});

const FactSchema = FactFieldsSchema.extend({ url: httpUrl });

const SourceFieldsSchema = z.object({
  url: httpUrl,
  name: optionalText(300),
  kind: optionalText(200),
  description: optionalText(20000),
  obtainable: optionalText(2000),
  structure: optionalEnum(LEVELS),
  publicContacts: optionalEnum(CONTACTS),
  alive: optionalEnum(ALIVE),
  parserPriority: optionalEnum(LEVELS),
  discovery: z.enum(DISCOVERY).default('manual'),
  viaEntityId: optionalUuid,
  representsEntityId: optionalUuid,
  notes: optionalText(20000),
  isProfile: optionalBool,
  sourceType: optionalEnum(SOURCE_TYPES),
  hasEvents: optionalBool,
  hasParticipantLists: optionalBool,
  parseable: optionalEnum(PARSEABLE),
  reviewStatus: z.enum(REVIEW).default('unchecked'),
  verification: z.enum(SOURCE_VERIFICATION).default('candidate'),
  reliability: z.enum(RELIABILITY).default('unassessed'),
});

const AsSourceSchema = z.object({
  url: httpUrl
    .nullish()
    .or(z.literal(''))
    .transform((v) => (v ? v : null)),
});

const ListQuerySchema = z.object({
  q: z.string().max(200).optional().default(''),
  type: z.enum(ENTITY_TYPES).optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
});

const uuid = (value: string) => z.string().uuid().parse(value);

@Roles('admin')
@Controller('admin/intelligence')
export class IntelligenceController {
  constructor(private readonly intelligence: IntelligenceService) {}

  // ------------------------------------------------------------ сущности

  @Get('entities')
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const filter = ListQuerySchema.parse(query);
    return { items: await this.intelligence.list(ctx, { ...filter, q: filter.q.trim() }) };
  }

  @Get('lookup')
  async lookup(@Ctx() ctx: RequestContext, @Query('q') q: string | undefined) {
    return { items: await this.intelligence.lookup(ctx, (q ?? '').trim().slice(0, 200)) };
  }

  @Get('entities/:id')
  async card(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.intelligence.card(ctx, uuid(id));
  }

  @Post('entities')
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.intelligence.create(ctx, CreateSchema.parse(body));
  }

  @Patch('entities/:id')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.update(ctx, uuid(id), UpdateSchema.parse(body));
  }

  @Post('entities/:id/merge')
  @HttpCode(200)
  async merge(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    const { dropId } = z.object({ dropId: z.string().uuid() }).parse(body);
    return this.intelligence.merge(ctx, uuid(id), dropId);
  }

  @Post('entities/:id/facts')
  async addFact(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.addFact(ctx, uuid(id), FactSchema.parse(body));
  }

  @Post('entities/:id/as-source')
  async asSource(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.entityAsSource(ctx, uuid(id), AsSourceSchema.parse(body ?? {}).url);
  }

  @Patch('facts/:id')
  async updateFact(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.updateFact(ctx, uuid(id), FactFieldsSchema.parse(body));
  }

  @Delete('facts/:id')
  @HttpCode(200)
  async removeFact(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.intelligence.removeFact(ctx, uuid(id));
    return { ok: true };
  }

  // ----------------------------------------------------------- источники

  @Get('sources')
  async sources(@Ctx() ctx: RequestContext) {
    return { items: await this.intelligence.sources(ctx) };
  }

  @Get('sources/:id')
  async sourceCard(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.intelligence.sourceCard(ctx, uuid(id));
  }

  @Post('sources')
  async createSource(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.intelligence.importUrl(ctx, SourceFieldsSchema.parse(body));
  }

  @Patch('sources/:id')
  async updateSource(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.updateSource(ctx, uuid(id), SourceFieldsSchema.partial().parse(body));
  }

  @Delete('sources/:id')
  @HttpCode(200)
  async removeSource(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.intelligence.removeSource(ctx, uuid(id));
    return { ok: true };
  }

  @Post('import/get-investor')
  @HttpCode(200)
  async importGetInvestor(@Ctx() ctx: RequestContext) {
    return this.intelligence.importGetInvestor(ctx);
  }
}
