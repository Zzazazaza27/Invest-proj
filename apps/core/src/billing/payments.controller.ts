import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import {
  PaymentProviderStatusSchema,
  PaymentViewSchema,
  ServiceRunAvailabilitySchema,
  ServiceRunViewSchema,
  StartPaymentRequestSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx, Public, Roles } from '../auth/guards';
import { errors } from '../common/errors';
import { parseOrThrow } from '../common/validation';
import { getEnv } from '../config/env';
import type { RequestContext } from '../db/unit-of-work';
import { PaymentsService } from './payments.service';
import { ServiceExecutionService } from './service-execution.service';

/**
 * Оплата покупки запуска раунда (5.9.9).
 *
 * Сумму клиент не присылает: сервер берёт её из покупки. Тело запроса несёт
 * только адрес возврата — и возврат по нему оплату НЕ подтверждает.
 */
@Controller('billing/purchases')
export class PurchasePaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':id/payment')
  async start(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(StartPaymentRequestSchema, rawBody ?? {});
    return PaymentViewSchema.parse(await this.payments.createForPurchase(ctx, id, input));
  }

  /**
   * Состояние платежа.
   *
   * Сюда же возвращается пользователь со страницы оплаты. Метод ничего не
   * меняет намеренно: если бы возврат подтверждал оплату, подтвердить её мог
   * бы кто угодно, просто открыв адрес.
   */
  @Get(':id/payment')
  async status(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const view = await this.payments.forPurchase(ctx, id);
    return view === null ? { payment: null } : { payment: PaymentViewSchema.parse(view) };
  }
}

/**
 * Приём уведомлений оператора платежей.
 *
 * Маршрут публичный по необходимости: провайдер приходит без нашей сессии.
 * Поэтому доверие здесь держится не на входе, а на подписи — неподписанное
 * или подделанное уведомление отвергается адаптером до единой записи в
 * денежных таблицах.
 *
 * Ответ намеренно скупой: внешней стороне сообщается, что уведомление принято
 * к обработке, и не сообщается, что происходит внутри.
 */
@Controller('billing/payments')
export class PaymentNotificationsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * Заглушка страницы оплаты тестового адаптера.
   *
   * У настоящего оператора здесь была бы его форма. Страница намеренно ничего
   * не делает: она существует, чтобы показать главное правило — оказаться на
   * странице оплаты и вернуться с неё не значит заплатить. Подтверждением
   * будет только уведомление оператора.
   *
   * В рабочем окружении страницы нет: тестового адаптера там быть не должно.
   */
  @Public()
  @Get('test-checkout/:ref')
  async testCheckout(@Param('ref') ref: string) {
    if (getEnv().NODE_ENV === 'production') {
      throw errors.notFound({ subject: 'test_checkout' });
    }
    return {
      checkout: 'test',
      providerRef: ref,
      note:
        'Тестовая страница оплаты: денег не списывается. Оплата будет подтверждена только ' +
        'подписанным уведомлением оператора — возврат с этой страницы ничего не подтверждает.',
    };
  }

  @Public()
  @Post('notify')
  async notify(
    @Body() rawBody: unknown,
    @Headers() headers: Record<string, string | undefined>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.payments.handleNotification(rawBody, headers, ctx.traceId);
  }
}

/** Состояние подключения оператора — административный экран. */
@Roles('admin')
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('provider')
  async provider(@Ctx() ctx: RequestContext) {
    return PaymentProviderStatusSchema.parse(await this.payments.providerStatus(ctx));
  }
}

/**
 * Исполнение услуг, которые выполняет платформа (6.1).
 *
 * Запуск доступен команде проекта по ОПЛАЧЕННОЙ позиции покупки. Отдельного
 * пути выдачи отчёта здесь нет: сам отчёт живёт там же, где жил, и
 * раскрывается существующими правилами видимости.
 */
@Controller('billing/purchases')
export class ServiceExecutionController {
  constructor(private readonly runs: ServiceExecutionService) {}

  /** Что по этой покупке можно запустить и что мешает. */
  @Get(':id/service-runs')
  async list(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const items = await this.runs.availability(ctx, id);
    return { items: items.map((item) => ServiceRunAvailabilitySchema.parse(item)) };
  }

  /**
   * Запустить разбор по позиции.
   *
   * Повторный запрос не создаёт второго исполнения: идущий прогон вернётся
   * как есть, уже выполненный — тоже.
   */
  @Post('items/:itemId/run')
  async start(@Param('itemId') rawId: string, @Ctx() ctx: RequestContext) {
    const itemId = parseOrThrow(UuidSchema, rawId);
    return ServiceRunViewSchema.parse(await this.runs.start(ctx, itemId));
  }
}
