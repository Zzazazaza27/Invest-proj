import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  CatalogQuerySchema,
  ProjectTeaserSchema,
  PublicViewSchema,
  TaxonomyNodeSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx, Public } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { CatalogService } from './catalog.service';
import { ProjectViewsService } from './project-views.service';

/**
 * Публичная витрина.
 *
 * Маршруты помечены `@Public()` осознанно: каталог тизеров и справочник
 * направлений — это то, что платформа показывает до регистрации (принцип
 * радикальной прозрачности, Architect_Launch §1.1). Полная карточка сюда не
 * попадает ни при каких параметрах запроса — она живёт за `/v1/projects/:id` и
 * требует подписки.
 */
@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly views: ProjectViewsService,
  ) {}

  @Public()
  @Get('taxonomy')
  async taxonomy(@Ctx() ctx: RequestContext) {
    const items = await this.catalog.taxonomy(ctx.traceId);
    return { items: items.map((n) => TaxonomyNodeSchema.parse(n)) };
  }

  @Public()
  @Get('catalog')
  async list(@Query() rawQuery: unknown, @Ctx() ctx: RequestContext) {
    const query = parseOrThrow(CatalogQuerySchema, rawQuery ?? {});
    const page = await this.catalog.list(ctx.traceId, query, viewerOf(ctx));
    return {
      items: page.items.map((t) => ProjectTeaserSchema.parse(t)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Public View (5.7.2): тизер плюс ответы согласованного владельцем снимка с
   * эффективной видимостью для аудитории зрителя. Совместим с тизером:
   * прежние поля на месте. Доступ решает предикат `lab.project_audience`
   * (режим проекта, исключения, блокировка) — не сам маршрут.
   */
  @Public()
  @Get('catalog/:id')
  async getOne(
    @Param('id') rawId: string,
    @Query('locale') locale: string | undefined,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    return PublicViewSchema.parse(await this.views.publicView(ctx.traceId, id, viewerOf(ctx)));
  }
}

/** Публичный маршрут, но зритель может быть вошедшим: аудитория проекции раунда — по сессии. */
function viewerOf(ctx: RequestContext): { userId: string | null; roles: readonly string[] } | null {
  return ctx.userId ? { userId: ctx.userId, roles: ctx.roles } : null;
}
