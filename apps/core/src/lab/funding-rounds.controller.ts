import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import {
  ChangeFundingRoundBasisRequestSchema,
  CloseFundingRoundRequestSchema,
  CreateFundingRoundRequestSchema,
  FundingRoundBasisHistoryEntrySchema,
  FundingRoundDetailSchema,
  FundingRoundSchema,
  UpdateFundingRoundRequestSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { FundingRoundsService } from './funding-rounds.service';

/**
 * Раунды привлечения (план 0.2 §0г). Список и черновик — под проектом,
 * остальное — по идентификатору раунда. Ни один маршрут не публичен;
 * внешним ролям раунд до этапа 5.7 не виден (RLS M081).
 */
@Controller()
export class FundingRoundsController {
  constructor(private readonly rounds: FundingRoundsService) {}

  @Get('projects/:id/rounds')
  async list(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const projectId = parseOrThrow(UuidSchema, rawId);
    const items = await this.rounds.listForProject(ctx, projectId);
    return { items: items.map((r) => FundingRoundSchema.parse(r)) };
  }

  /** Черновик раунда; повторный вызов возвращает существующий черновик. */
  @Roles('founder', 'admin')
  @Post('projects/:id/rounds')
  async create(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const projectId = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(CreateFundingRoundRequestSchema, rawBody ?? {});
    return FundingRoundDetailSchema.parse(await this.rounds.createDraft(ctx, projectId, input));
  }

  @Get('rounds/:id')
  async get(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    return FundingRoundDetailSchema.parse(
      await this.rounds.get(ctx, parseOrThrow(UuidSchema, rawId)),
    );
  }

  @Roles('founder', 'admin')
  @Patch('rounds/:id')
  async update(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(UpdateFundingRoundRequestSchema, rawBody);
    return FundingRoundDetailSchema.parse(await this.rounds.update(ctx, id, input));
  }

  @Roles('founder', 'admin')
  @Post('rounds/:id/open')
  async open(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    return FundingRoundDetailSchema.parse(
      await this.rounds.open(ctx, parseOrThrow(UuidSchema, rawId)),
    );
  }

  @Roles('founder', 'admin')
  @Post('rounds/:id/pause')
  async pause(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    return FundingRoundDetailSchema.parse(
      await this.rounds.pause(ctx, parseOrThrow(UuidSchema, rawId)),
    );
  }

  @Roles('founder', 'admin')
  @Post('rounds/:id/resume')
  async resume(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    return FundingRoundDetailSchema.parse(
      await this.rounds.resume(ctx, parseOrThrow(UuidSchema, rawId)),
    );
  }

  @Roles('founder', 'admin')
  @Post('rounds/:id/close')
  async close(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(CloseFundingRoundRequestSchema, rawBody);
    return FundingRoundDetailSchema.parse(await this.rounds.close(ctx, id, input));
  }

  @Roles('founder', 'admin')
  @Post('rounds/:id/cancel')
  async cancel(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    return FundingRoundDetailSchema.parse(
      await this.rounds.cancel(ctx, parseOrThrow(UuidSchema, rawId)),
    );
  }

  /** Смена основания — тем же раундом, с историей. */
  @Roles('founder', 'admin')
  @Put('rounds/:id/basis')
  async changeBasis(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(ChangeFundingRoundBasisRequestSchema, rawBody);
    return FundingRoundDetailSchema.parse(await this.rounds.changeBasis(ctx, id, input));
  }

  @Get('rounds/:id/basis-history')
  async basisHistory(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const items = await this.rounds.basisHistory(ctx, parseOrThrow(UuidSchema, rawId));
    return { items: items.map((i) => FundingRoundBasisHistoryEntrySchema.parse(i)) };
  }
}
