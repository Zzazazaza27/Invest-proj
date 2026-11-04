import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  InvestorViewSchema,
  UuidSchema,
  ViewPreviewQuerySchema,
  ViewPreviewSchema,
} from '@fifth/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { ProjectViewsService } from './project-views.service';

/**
 * Представления проекта (5.7.2). Public View живёт в `GET /catalog/:id`
 * (публичный маршрут каталога); здесь — представления по сессии:
 * Investor View для любого вошедшего (состав решает предикат), предпросмотры
 * — команде проекта.
 */
@Controller()
export class ProjectViewsController {
  constructor(private readonly views: ProjectViewsService) {}

  @Get('projects/:id/investor-view')
  async investorView(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return InvestorViewSchema.parse(
      await this.views.investorView(ctx.traceId, id, { userId: ctx.userId, roles: ctx.roles }),
    );
  }

  @Roles('founder', 'admin')
  @Get('projects/:id/view-preview')
  async viewPreview(
    @Param('id') rawId: string,
    @Query() rawQuery: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const query = parseOrThrow(ViewPreviewQuerySchema, rawQuery ?? {});
    return ViewPreviewSchema.parse(
      await this.views.viewPreview(ctx, id, query.audience ?? 'investors'),
    );
  }
}
