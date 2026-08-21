import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import {
  PublicationConsentRequestSchema,
  PublicationConsentSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { PublicationConsentsService } from './publication-consents.service';

/**
 * Согласия на публичный контур.
 *
 * Маршрут `/v1/publication-consents` был в клиенте с самого начала и отвечал
 * 404: контроллера не существовало (LOW отчёта Ф48, подтверждён вызовом).
 *
 * Роль `founder` обязательна: согласие на съёмку и публичный показ даёт
 * участник проекта о СЕБЕ. Администратор такого согласия выдать не может — не
 * потому, что ему не хватает прав, а потому, что согласие, проставленное за
 * человека, согласием не является.
 */
@Controller('publication-consents')
@Roles('founder')
export class PublicationConsentsController {
  constructor(private readonly consents: PublicationConsentsService) {}

  @Get()
  async list(@Query('projectId') rawProjectId: unknown, @Ctx() ctx: RequestContext) {
    const projectId =
      rawProjectId === undefined || rawProjectId === ''
        ? undefined
        : parseOrThrow(UuidSchema, rawProjectId);
    return { items: await this.consents.list(ctx, projectId) };
  }

  @Post()
  async grant(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(PublicationConsentRequestSchema, rawBody);
    return PublicationConsentSchema.parse(await this.consents.grant(ctx, input));
  }

  /**
   * Отзыв. Метод DELETE, а строка при этом остаётся: удаляется не запись, а
   * разрешение. Юридический факт акцепта неизменяем — отмена выражается полем
   * `revoked_at` и событием с крайним сроком удаления публичной проекции.
   */
  @Delete(':id')
  async revoke(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return PublicationConsentSchema.parse(await this.consents.revoke(ctx, id));
  }
}
