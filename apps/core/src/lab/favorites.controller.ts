import { Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { FavoriteProjectSchema, UuidSchema } from '@fifth/contracts';
import { Ctx } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { FavoritesService } from './favorites.service';

/**
 * Избранные проекты инвестора.
 *
 * Чьё избранное — не параметр: пользователь всегда берётся из контекста
 * аутентификации, а границу держит политика RLS. Маршрута вида
 * `/favorites?userId=…` здесь нет и быть не может.
 *
 * PUT и DELETE, а не один «переключить»: обе операции идемпотентны, и двойное
 * нажатие или повтор запроса при обрыве связи приводят к тому же состоянию.
 * «Переключить» на повторе давал бы противоположный результат — ровно та
 * ошибка, которую видно как «отметка мигает».
 */
@Controller('investor/favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.favorites.list(ctx);
    return { items: items.map((item) => FavoriteProjectSchema.parse(item)) };
  }

  /** Только идентификаторы — чтобы каталог отметил карточки одним запросом. */
  @Get('ids')
  async ids(@Ctx() ctx: RequestContext) {
    return { items: await this.favorites.listIds(ctx) };
  }

  @Put(':projectId')
  async add(@Param('projectId') rawId: string, @Ctx() ctx: RequestContext) {
    const projectId = parseOrThrow(UuidSchema, rawId);
    await this.favorites.add(ctx, projectId);
    return { favorited: true };
  }

  @Delete(':projectId')
  async remove(@Param('projectId') rawId: string, @Ctx() ctx: RequestContext) {
    const projectId = parseOrThrow(UuidSchema, rawId);
    await this.favorites.remove(ctx, projectId);
    return { favorited: false };
  }
}
