import { Controller, Get, Query } from '@nestjs/common';
import { AdminProjectSummarySchema } from '@fifth/contracts';
import { Ctx, Roles } from '../auth/guards';
import type { RequestContext } from '../db/unit-of-work';
import { DirectoryService } from './directory.service';

/**
 * Поиск проектов для административных экранов.
 *
 * Зачем нужен. Перевод проекта по воронке работает по идентификатору — он
 * однозначен и попадает в журнал. Но набирать UUID руками оператору неоткуда:
 * он знает название, а не идентификатор.
 *
 * Поиск людей переехал в раздел «Пользователи» (этап 6): у него появились
 * свои фильтры, страницы и права, и держать две разные выдачи по одной
 * таблице в одном контроллере стало неправдой про назначение файла.
 */
@Roles('admin')
@Controller('admin')
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get('projects')
  async projects(@Query('q') q: string | undefined, @Ctx() ctx: RequestContext) {
    const items = await this.directory.findProjects(ctx, (q ?? '').trim());
    return { items: items.map((item) => AdminProjectSummarySchema.parse(item)) };
  }
}
