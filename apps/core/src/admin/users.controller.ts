import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  AdminUserCardSchema,
  AdminUserContactsSchema,
  AdminUserListQuerySchema,
  AdminUserPageSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { AdminUsersService } from './users.service';

/**
 * Раздел «Пользователи» административного кабинета.
 *
 * Разделение прав внутри одного раздела намеренное:
 *
 *  * **список** виден администратору и организатору — это рабочий справочник,
 *    и он же питает выбор человека на экране «Доступ»;
 *  * **карточка** — только администратору: в ней состояние учётной записи,
 *    полномочия, связанные объекты и история действий;
 *  * **раскрытие контактов** — ещё уже: нужно полномочие
 *    `identity.user_contacts.view`, и каждое раскрытие попадает в журнал.
 *
 * Раскрытие сделано POST, а не GET, хотя по сути это чтение. Причина в том,
 * что у операции есть след: она пишет событие в журнал и должна быть защищена
 * от межсайтовой подделки наравне с изменениями. GET такой защиты не имеет по
 * определению.
 */
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Roles('admin', 'organizer')
  @Get()
  async list(@Query() rawQuery: unknown, @Ctx() ctx: RequestContext) {
    const query = parseOrThrow(AdminUserListQuerySchema, rawQuery ?? {});
    return AdminUserPageSchema.parse(await this.users.list(ctx, query));
  }

  @Roles('admin')
  @Get(':id')
  async card(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return AdminUserCardSchema.parse(await this.users.card(ctx, id));
  }

  @Roles('admin')
  // Ничего не создаётся — это чтение, защищённое как изменение. 201 обещал бы
  // клиенту новый ресурс, которого нет.
  @HttpCode(200)
  @Post(':id/contacts/reveal')
  async revealContacts(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return AdminUserContactsSchema.parse(await this.users.revealContacts(ctx, id));
  }
}
