import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SeasonSchema, UpdateSeasonStatusRequestSchema, UuidSchema } from '@unicorn/contracts';
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
}
