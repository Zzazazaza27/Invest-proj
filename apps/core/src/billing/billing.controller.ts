import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  CommissionAccrualSchema,
  CreatePaymentRequestSchema,
  CreateSubscriptionRequestSchema,
  InvoiceSchema,
  SubscriptionSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx } from '../auth/guards';
import { errors } from '../common/errors';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { BillingService } from './billing.service';

/**
 * Подписки пользователя.
 *
 * Клиент выбирает ПРОЕКТ (или просто оформляет подписку инвестора), но не план
 * и не цену: тариф резолвит сервер. Иначе цену можно было бы занизить, подставив
 * чужой `planId` — а снапшот цены попадает в подписку и определяет, сколько
 * человек платит.
 *
 * Пути `/v1/billing/subscriptions` отнесены к денежному классу ограничения
 * частоты (10/мин) — см. `main.ts`.
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post('subscriptions')
  async create(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(CreateSubscriptionRequestSchema, rawBody);
    return SubscriptionSchema.parse(await this.billing.createSubscription(ctx, input));
  }

  /**
   * Оплата счёта.
   *
   * Маршрут существует и отвечает отказом, а не отсутствием. Клиент звал его с
   * самого начала и получал 404 — то есть метод клиента был ловушкой: вызов
   * выглядел как «оплата не удалась», хотя сервер о такой операции не знал
   * вовсе (найдено прогоном в Ф52, тот же класс, что и согласия в Ф50).
   *
   * Приём платежей выключен флагом `billing.payments.enabled`: платёжный
   * провайдер не выбран, договора нет, обработчика вебхука подтверждения нет.
   * Создавать при этом строку в `billing.payments` было бы хуже 404 — в
   * денежной таблице появились бы записи, за которыми не стоит ни одного
   * перевода.
   *
   * Тело всё равно разбирается схемой ДО проверки флага: невалидный запрос
   * обязан отвечать «проверьте поля», а не «функция выключена», иначе клиент
   * узнает о своей ошибке только после включения провайдера.
   */
  @Post('payments')
  async pay(@Body() rawBody: unknown, @Ctx() ctx: RequestContext): Promise<never> {
    parseOrThrow(CreatePaymentRequestSchema, rawBody);
    // Флаг читается, а не игнорируется. Два разных отказа различают два разных
    // состояния: «приём платежей выключен» и «флаг включили, а провайдера нет».
    // Второй случай обязан быть громким — иначе деньги «принимались» бы в
    // никуда.
    await this.billing.assertPaymentsEnabled(ctx);
    throw errors.featureDisabled('payments.provider');
  }

  @Get('subscriptions')
  async listMine(@Ctx() ctx: RequestContext) {
    const items = await this.billing.listMine(ctx);
    return { items: items.map((s) => SubscriptionSchema.parse(s)) };
  }

  /**
   * Счета пользователя. Кто и что видит — решает RLS, поэтому роль в декораторе
   * не указана: любой авторизованный получает СВОИ счета и только их.
   */
  @Get('invoices')
  async listInvoices(@Ctx() ctx: RequestContext) {
    const items = await this.billing.listInvoices(ctx);
    return { items: items.map((invoice) => InvoiceSchema.parse(invoice)) };
  }

  /** Начисления вознаграждения по сделкам, стороной которых человек является. */
  @Get('accruals')
  async listAccruals(@Ctx() ctx: RequestContext) {
    const items = await this.billing.listAccruals(ctx);
    return { items: items.map((accrual) => CommissionAccrualSchema.parse(accrual)) };
  }

  @Post('subscriptions/:id/cancel')
  async cancel(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return SubscriptionSchema.parse(await this.billing.cancel(ctx, id));
  }
}
