import { Controller, Get, Param } from '@nestjs/common';
import { GuardedOperationSchema, RequestKeyStateSchema } from '@fifth/contracts';
import { Ctx } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import { requestKeyFrom, requestKeyState } from '../db/request-keys';
import { Database, type RequestContext } from '../db/unit-of-work';

/**
 * Состояние своей защищённой отправки по ключу (блок 2, 2.6).
 *
 * Нужна вкладке, где после повторного входа или перезагрузки осталась только метка
 * «отправка не выяснена»: содержимое формы в хранилище браузера не пишется, поэтому
 * повторить запрос нечем, а узнать исход — можно. Маршрут только читает: ни работы, ни
 * изменения он не выполняет. Видны только свои ключи.
 */
@Controller('me/requests')
export class RequestKeysController {
  constructor(private readonly db: Database) {}

  @Get(':operation/:key')
  async state(
    @Param('operation') rawOperation: string,
    @Param('key') rawKey: string,
    @Ctx() ctx: RequestContext,
  ) {
    const operation = parseOrThrow(GuardedOperationSchema, rawOperation);
    const key = requestKeyFrom(rawKey) as string;
    return RequestKeyStateSchema.parse(await requestKeyState(this.db, ctx, operation, key));
  }
}
