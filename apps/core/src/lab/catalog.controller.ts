import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  CatalogQuerySchema,
  ProjectTeaserSchema,
  TaxonomyNodeSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx, Public } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { CatalogService } from './catalog.service';

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
  constructor(private readonly catalog: CatalogService) {}

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
    const page = await this.catalog.list(ctx.traceId, query);
    return {
      items: page.items.map((t) => ProjectTeaserSchema.parse(t)),
      nextCursor: page.nextCursor,
    };
  }

  @Public()
  @Get('catalog/:id')
  async getOne(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return ProjectTeaserSchema.parse(await this.catalog.getTeaser(ctx.traceId, id));
  }
}
