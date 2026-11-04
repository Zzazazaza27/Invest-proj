import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  OperationKindSchema,
  OperationNoticeResultSchema,
  UserOperationSchema,
  UserOperationsResponseSchema,
  UuidSchema,
} from '@fifth/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { UploadOperationsService } from './upload-operations.service';

/**
 * Длительные операции текущего пользователя (блок 1, 1.5).
 *
 * Чьи операции — не параметр: пользователь берётся из контекста
 * аутентификации, граница — RLS и условие инициатора в сервисе.
 *
 * Клиент вызывает проверку при загрузке кабинета и возвращении на вкладку
 * (не чаще раза в минуту), опрос одной операции — пока её состояние показано.
 * Это запросы состояния, а не повтор действия.
 */
@Controller('me/operations')
export class OperationsController {
  constructor(private readonly operations: UploadOperationsService) {}

  @Roles('founder', 'admin')
  @Get()
  async pending(@Ctx() ctx: RequestContext) {
    return UserOperationsResponseSchema.parse({ items: await this.operations.pending(ctx) });
  }

  @Roles('founder', 'admin')
  @Get(':kind/:id')
  async one(
    @Param('kind') rawKind: string,
    @Param('id') rawId: string,
    @Ctx() ctx: RequestContext,
  ) {
    const kind = parseOrThrow(OperationKindSchema, rawKind);
    const id = parseOrThrow(UuidSchema, rawId);
    return UserOperationSchema.parse(await this.operations.one(ctx, kind, id));
  }

  /**
   * Итог показан. Клиент вызывает, когда сообщение появилось на ВИДИМОЙ
   * вкладке: скрытая вкладка ничего не подтверждает. После отметки сообщение
   * не повторяется ни здесь, ни на другом устройстве.
   */
  @Roles('founder', 'admin')
  @Post(':kind/:id/notice')
  @HttpCode(200)
  async notice(
    @Param('kind') rawKind: string,
    @Param('id') rawId: string,
    @Ctx() ctx: RequestContext,
  ) {
    const kind = parseOrThrow(OperationKindSchema, rawKind);
    const id = parseOrThrow(UuidSchema, rawId);
    await this.operations.notice(ctx, kind, id);
    return OperationNoticeResultSchema.parse({ noticed: true });
  }
}
