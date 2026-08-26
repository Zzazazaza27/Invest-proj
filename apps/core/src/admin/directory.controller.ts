import { Controller, Get, Query } from '@nestjs/common';
import { AdminProjectSummarySchema, AdminUserSummarySchema } from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import type { RequestContext } from '../db/unit-of-work';
import { DirectoryService } from './directory.service';

/**
 * Поиск людей и проектов для административных экранов.
 *
 * Зачем нужен. Три экрана админки — выдача роли, снятие роли и перевод проекта
 * по воронке — просили ввести UUID «из базы». Взять его оператору было негде:
 * ни поиска, ни списка. То есть работать без служебной консоли и прямого
 * доступа к БД было нельзя, хотя ровно это админка и должна закрывать.
 *
 * Почему поиск по имени, а не по почте: адрес хранится зашифрованным, и
 * подбирать по нему означало бы расшифровывать всю таблицу на каждый запрос.
 * Точный поиск по адресу возможен через слепой индекс — он появится вместе с
 * задачей, где это действительно нужно.
 */
@Roles('admin', 'organizer')
@Controller('admin')
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get('users')
  async users(@Query('q') q: string | undefined, @Ctx() ctx: RequestContext) {
    const items = await this.directory.findUsers(ctx, (q ?? '').trim());
    return { items: items.map((item) => AdminUserSummarySchema.parse(item)) };
  }

  @Get('projects')
  async projects(@Query('q') q: string | undefined, @Ctx() ctx: RequestContext) {
    const items = await this.directory.findProjects(ctx, (q ?? '').trim());
    return { items: items.map((item) => AdminProjectSummarySchema.parse(item)) };
  }
}
