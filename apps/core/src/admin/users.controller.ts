import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  AdminUserCardSchema,
  AdminUserContactsSchema,
  AdminUserListQuerySchema,
  AdminUserPageSchema,
  AdminUserProfileUpdateSchema,
  AdminUserStatusChangeSchema,
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

  /**
   * Блокировка и снятие блокировки.
   *
   * Обе — одно действие с двумя значениями, а не две разные кнопки в API:
   * у них общие проверки (не себе, не последнему администратору), общий
   * обязательный повод и общее последствие для живых сессий.
   */
  @Roles('admin')
  @Patch(':id/status')
  async changeStatus(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(AdminUserStatusChangeSchema, rawBody);
    return AdminUserCardSchema.parse(await this.users.changeStatus(ctx, id, input));
  }

  @Roles('admin')
  @Patch(':id/profile')
  async updateProfile(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(AdminUserProfileUpdateSchema, rawBody);
    return AdminUserCardSchema.parse(await this.users.updateProfile(ctx, id, input));
  }
}
