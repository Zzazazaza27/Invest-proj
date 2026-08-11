import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  AdvanceProjectStageRequestSchema,
  GoldenTicketSchema,
  GrantGoldenTicketRequestSchema,
  ProjectStageChangeSchema,
  RatingEntrySchema,
  SeasonFunnelConfigSchema,
  SeasonSchema,
  SeasonStageOccupancySchema,
  UpdateSeasonStatusRequestSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { z } from 'zod';
import { Ctx, Public, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { SeasonsService } from './seasons.service';

@Controller('seasons')
export class SeasonsController {
  constructor(private readonly seasons: SeasonsService) {}

  /** Метроном сезона публичен: по нему основатель понимает, открыт ли приём. */
  @Public()
  @Get('current')
  async current(@Ctx() ctx: RequestContext) {
    const season = await this.seasons.current(ctx.traceId);
    return { season: season === null ? null : SeasonSchema.parse(season) };
  }

  @Roles('admin', 'organizer')
  @Post(':id/status')
  async changeStatus(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(UpdateSeasonStatusRequestSchema, rawBody);
    return SeasonSchema.parse(await this.seasons.changeStatus(ctx, id, input.status));
  }

  /** Рейтинг публичен: закрытый рейтинг сезона не выполняет своей функции. */
  @Public()
  @Get(':id/rating')
  async rating(
    @Param('id') rawId: string,
    @Query('limit') rawLimit: string | undefined,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const limit = parseOrThrow(z.coerce.number().int().min(1).max(100).default(50), rawLimit ?? 50);
    const items = await this.seasons.rating(ctx.traceId, id, limit);
    return { items: items.map((item) => RatingEntrySchema.parse(item)) };
  }

  @Roles('admin', 'organizer')
  @Post(':id/rating/refresh')
  async refreshRating(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return this.seasons.refreshRating(ctx, id);
  }

  @Roles('admin', 'organizer')
  @Post(':id/golden-tickets')
  async grantGoldenTicket(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(GrantGoldenTicketRequestSchema, rawBody);
    return GoldenTicketSchema.parse(await this.seasons.grantGoldenTicket(ctx, id, input));
  }

  /**
   * Конфигурация воронки сезона: квоты этапов и расписание их открытия.
   * Это решение об отборе, поэтому оно доступно только организатору и админу.
   */
  @Roles('admin', 'organizer')
  @Post(':id/funnel')
  async setFunnel(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const config = parseOrThrow(SeasonFunnelConfigSchema, rawBody);
    return SeasonFunnelConfigSchema.parse(await this.seasons.setFunnelConfig(ctx, id, config));
  }

  @Roles('admin', 'organizer')
  @Get(':id/funnel')
  async funnelState(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const items = await this.seasons.funnelState(ctx, id);
    return { items: items.map((item) => SeasonStageOccupancySchema.parse(item)) };
  }

  /** Перевод проекта по этапам сезона — отбор, а не редактирование заявки. */
  @Roles('admin', 'organizer')
  @Post(':id/projects/:projectId/stage')
  async advanceStage(
    @Param('id') rawId: string,
    @Param('projectId') rawProjectId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const projectId = parseOrThrow(UuidSchema, rawProjectId);
    const input = parseOrThrow(AdvanceProjectStageRequestSchema, rawBody);
    return ProjectStageChangeSchema.parse(
      await this.seasons.advanceProjectStage(ctx, id, projectId, input),
    );
  }

  @Roles('admin', 'organizer')
  @Get(':id/golden-tickets')
  async listGoldenTickets(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const items = await this.seasons.listGoldenTickets(ctx, id);
    return { items: items.map((item) => GoldenTicketSchema.parse(item)) };
  }
}
