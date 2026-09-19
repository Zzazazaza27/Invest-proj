import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type PaymentProviderStatus,
  type PaymentView,
  type ProviderNotification,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { getEnv } from '../config/env';
import { payloadDigest, resolveProvider } from './payment-provider';

/**
 * Оплата услуг платформы (5.9.9; структуры — M108/M109).
 *
 * Сервис знает ИНТЕРФЕЙС оператора платежей, а не конкретный сервис. Всё, что
 * зависит от провайдера, живёт в адаптере; здесь — правила, которые не должны
 * меняться вместе с провайдером:
 *
 *  • сумму и валюту назначает сервер по предмету оплаты. Клиент их не
 *    присылает и присылать не может — иначе он назначал бы себе цену;
 *  • возврат пользователя со страницы оплаты ничего не подтверждает. Деньги
 *    поступили только тогда, когда пришло проверяемое уведомление;
 *  • одно уведомление исполняется один раз. Повтор распознаётся по `eventId`
 *    и записывается как дубликат;
 *  • неуспех и отмена — такие же обычные исходы, как успех, и обрабатываются
 *    явно, а не молчанием.
 *
 * Денег платформа по-прежнему не двигает: подключён тестовый адаптер, платежи
 * помечаются `mode = 'test'`, и покупка, оплаченная таким платежом, в рабочем
 * окружении раунд не открывает (M107).
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  /** Что сейчас произойдёт при попытке оплатить — для админского экрана. */
  async providerStatus(ctx: RequestContext): Promise<PaymentProviderStatus> {
    const provider = resolveProvider();
    const env = getEnv();
    const accepting = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ enabled: boolean }>(
        `SELECT enabled FROM audit.feature_flags WHERE key = 'billing.payments.enabled'`,
      );
      return rows[0]?.enabled ?? false;
    });

    const explanation: string[] = [];
    if (provider.code === 'test') {
      explanation.push(
        'Подключён тестовый адаптер: настоящий оператор платежей ещё не выбран.',
        'Платежи помечаются тестовыми и денег не двигают.',
      );
    }
    explanation.push(
      accepting
        ? 'Приём настоящих платежей включён настройкой.'
        : 'Приём настоящих платежей выключен: платёж в рабочем режиме создать нельзя.',
    );
    explanation.push(
      provider.notificationsVerifiable
        ? 'Уведомления оператора проверяются подписью.'
        : 'Ключ проверки подписи не задан: уведомления отвергаются, оплату подтвердить нечем.',
    );
    if (env.NODE_ENV === 'production' && provider.mode === 'test') {
      explanation.push(
        'Рабочее окружение: тестовый платёж здесь создать нельзя, и покупка по нему раунд не откроет.',
      );
    }

    return {
      provider: provider.code,
      mode: env.PAYMENTS_MODE,
      acceptingRealPayments: accepting,
      notificationsVerifiable: provider.notificationsVerifiable,
      explanation,
    };
  }

  /**
   * Создать платёж за покупку запуска раунда.
   *
   * Сумма берётся из САМОЙ покупки — она уже снимок, посчитанный сервером при
   * оформлении. Повторное нажатие возвращает существующий незавершённый
   * платёж, а не создаёт второй: этого же требует уникальный индекс в базе.
   */
  async createForPurchase(
    ctx: RequestContext,
    purchaseId: string,
    input: { returnUrl?: string },
  ): Promise<PaymentView> {
    const provider = resolveProvider();
    const env = getEnv();

    // Тестовый платёж в рабочем окружении — это экран «оплачено» без денег.
    if (env.NODE_ENV === 'production' && provider.mode === 'test') {
      throw errors.forbidden(
        { purchaseId },
        'Тестовый оператор платежей недоступен в рабочем окружении',
      );
    }
    if (!provider.notificationsVerifiable) {
      // Платёж, подтверждение которого нечем проверить, создавать бессмысленно:
      // он навсегда останется в ожидании.
      throw errors.featureDisabled('payments.webhook_secret');
    }

    const purchase = await this.db.readOnly(ctx, async (tx) => this.loadPurchase(tx, purchaseId));
    if (purchase.status === 'paid') {
      throw errors.stateTransition('Покупка уже оплачена');
    }
    if (purchase.status !== 'pending_payment') {
      throw errors.stateTransition('Покупка не ожидает оплаты');
    }

    const existing = await this.db.readOnly(ctx, async (tx) =>
      this.activePaymentId(tx, purchaseId),
    );
    if (existing) return this.view(ctx, existing);

    const paymentId = uuidv7();
    const amountMinor = toMinor(purchase.total_amount);
    const created = await provider.createPayment({
      paymentId,
      amountMinor,
      currency: purchase.currency,
      description: `Запуск раунда: покупка ${purchaseId}`,
      returnUrl: input.returnUrl,
    });

    await this.db.asServiceRole('app_billing', { traceId: ctx.traceId }, async (tx) => {
      await tx.query(
        `INSERT INTO billing.payments
           (id, purchase_id, user_id, amount, currency, provider, provider_ref, status, mode,
            idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, 'pending', $8, $9, $10)`,
        [
          paymentId,
          purchaseId,
          purchase.buyer_user_id,
          purchase.total_amount,
          purchase.currency,
          provider.code,
          created.providerRef,
          provider.mode,
          `purchase:${purchaseId}:${paymentId}`,
          payloadDigest(`${purchaseId}:${purchase.total_amount}:${purchase.currency}`),
        ],
      );
    });

    await this.db.transaction(ctx, async (tx) => {
      await this.audit.emit(tx, {
        verb: 'billing.payment.created',
        actorId: ctx.userId,
        actorRole: ctx.roles?.includes('admin') ? 'admin' : 'founder',
        subjectType: 'payment',
        subjectId: paymentId,
        context: {
          purchaseId,
          amount: purchase.total_amount,
          currency: purchase.currency,
          provider: provider.code,
          mode: provider.mode,
        },
        traceId: ctx.traceId,
      });
    });

    return this.view(ctx, paymentId, created.redirectUrl);
  }

  /**
   * Обработать уведомление оператора.
   *
   * Порядок важен и обратному не подлежит: сперва ПРОВЕРИТЬ подпись, потом
   * записать событие, и только потом что-то менять. Событие записывается даже
   * тогда, когда применить его не удалось, — иначе разбираться потом будет не
   * с чем.
   */
  async handleNotification(
    body: unknown,
    headers: Record<string, string | undefined>,
    traceId: string,
  ): Promise<{ result: string }> {
    const provider = resolveProvider();
    // Бросает при плохой подписи: неподписанное уведомление — сообщение от
    // неизвестного, а не подтверждение оплаты.
    const notification = provider.parseNotification(body, headers);

    return this.db.asServiceRole('app_billing', { traceId }, async (tx) => {
      const payment = await this.findByProviderRef(tx, provider.code, notification.providerRef);

      const eventId = uuidv7();
      const inserted = await insertEventOnce(tx, {
        id: eventId,
        provider: provider.code,
        notification,
        paymentId: payment?.id ?? null,
        // Отпечаток разобранного уведомления, а не схемы конкретного
        // адаптера: как именно провайдер подписывает своё сообщение —
        // его дело и дело его адаптера.
        digest: payloadDigest(JSON.stringify(notification)),
      });
      if (!inserted) {
        // Тот же eventId уже приходил. Второй раз не исполняем — именно это и
        // называется защитой от повторного уведомления.
        return { result: 'duplicate' };
      }

      if (!payment) {
        await markEvent(tx, eventId, 'rejected');
        return { result: 'unknown_payment' };
      }

      // Сумма из уведомления обязана совпасть с нашей. Расхождение — повод
      // разбираться руками, а не считать покупку оплаченной.
      if (notification.amount !== null && notification.amount !== payment.amount) {
        await markEvent(tx, eventId, 'rejected');
        return { result: 'amount_mismatch' };
      }

      // Платёж уже завершён — значит решение по нему принято. Второе событие
      // о том же успехе (у операторов их бывает несколько: «оплачен», затем
      // «списан») и опоздавшее событие по отменённой попытке сюда и приходят.
      if (isFinal(payment.status)) {
        await markEvent(tx, eventId, 'ignored');
        return { result: 'already_final' };
      }

      // Покупка уже оплачена — другим платежом или вручную оператором. Тогда
      // это событие опоздало: активировать покупку второй раз нечем, и
      // отмечать успешным ещё один платёж по ней нельзя — за ней стоит одна
      // оплата, а не две.
      if (payment.purchase_id) {
        const { rows } = await tx.query<{ status: string }>(
          `SELECT status FROM billing.round_purchases WHERE id = $1 FOR UPDATE`,
          [payment.purchase_id],
        );
        if (rows[0]?.status === 'paid') {
          await tx.query(
            `UPDATE billing.payments
                SET status = 'canceled',
                    failure_reason = 'покупка уже оплачена: это подтверждение опоздало',
                    updated_at = now()
              WHERE id = $1`,
            [payment.id],
          );
          await markEvent(tx, eventId, 'ignored');
          return { result: 'purchase_already_paid' };
        }
      }

      const outcome = notification.outcome;
      if (outcome === 'pending') {
        await markEvent(tx, eventId, 'ignored');
        return { result: 'pending' };
      }

      if (outcome === 'succeeded') {
        await tx.query(
          `UPDATE billing.payments
              SET status = 'succeeded', confirmed_at = now(), updated_at = now()
            WHERE id = $1`,
          [payment.id],
        );
        if (payment.purchase_id) {
          await tx.query(
            `UPDATE billing.round_purchases
                SET status = 'paid', paid_at = now(),
                    is_test_payment = $2,
                    status_reason = $3
              WHERE id = $1 AND status = 'pending_payment'`,
            [
              payment.purchase_id,
              payment.mode === 'test',
              payment.mode === 'test'
                ? 'оплата подтверждена ТЕСТОВЫМ оператором платежей'
                : 'оплата подтверждена уведомлением оператора платежей',
            ],
          );
        }
        await markEvent(tx, eventId, 'applied');
        return { result: 'succeeded' };
      }

      await tx.query(
        `UPDATE billing.payments
            SET status = $2, failure_reason = $3, updated_at = now()
          WHERE id = $1`,
        [payment.id, outcome, notification.failureReason ?? 'оператор не сообщил причину'],
      );
      await markEvent(tx, eventId, 'applied');
      return { result: outcome };
    });
  }

  /** Состояние платежа по покупке. Читается, ничего не меняет. */
  async forPurchase(ctx: RequestContext, purchaseId: string): Promise<PaymentView | null> {
    const id = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM billing.payments WHERE purchase_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [purchaseId],
      );
      return rows[0]?.id ?? null;
    });
    return id ? this.view(ctx, id) : null;
  }

  // ------------------------------------------------------------------ helpers

  private async view(
    ctx: RequestContext,
    paymentId: string,
    redirectUrl: string | null = null,
  ): Promise<PaymentView> {
    const row = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<PaymentRow>(
        `SELECT id, purchase_id, invoice_id, amount::text AS amount, currency, provider,
                provider_ref, status, mode, failure_reason, created_at, confirmed_at
           FROM billing.payments WHERE id = $1`,
        [paymentId],
      );
      return rows[0] ?? null;
    });
    if (!row) throw errors.notFound({ subject: 'payment' });

    const explanation: string[] = [];
    switch (row.status) {
      case 'pending':
      case 'authorized':
        explanation.push('Платёж создан, поступление денег ещё не подтверждено.');
        explanation.push(
          'Возврат со страницы оплаты подтверждением не является: ждём уведомления оператора.',
        );
        break;
      case 'succeeded':
        explanation.push('Оператор подтвердил оплату.');
        if (row.mode === 'test') {
          explanation.push(
            'Это ТЕСТОВЫЙ платёж: денег не поступало, и в рабочем окружении раунд по нему не откроется.',
          );
        }
        break;
      case 'failed':
      case 'canceled':
        explanation.push(
          row.status === 'canceled' ? 'Оплата отменена.' : 'Оплата не прошла.',
          row.failure_reason ?? 'Причина не сообщена. Можно начать оплату заново.',
        );
        break;
      default:
        explanation.push('Состояние платежа изменено вручную оператором.');
    }

    return {
      id: row.id,
      subject: row.purchase_id ? 'round_purchase' : 'invoice',
      subjectId: (row.purchase_id ?? row.invoice_id)!,
      amount: row.amount,
      currency: row.currency as PaymentView['currency'],
      provider: row.provider,
      providerRef: row.provider_ref,
      status: row.status,
      mode: row.mode,
      redirectUrl: isFinal(row.status) ? null : redirectUrl,
      failureReason: row.failure_reason,
      createdAt: row.created_at.toISOString(),
      confirmedAt: row.confirmed_at?.toISOString() ?? null,
      explanation,
    };
  }

  private async loadPurchase(tx: Tx, purchaseId: string): Promise<PurchaseRow> {
    const { rows } = await tx.query<PurchaseRow>(
      `SELECT id, buyer_user_id, status, total_amount::text AS total_amount, currency
         FROM billing.round_purchases WHERE id = $1`,
      [purchaseId],
    );
    if (!rows[0]) throw errors.notFound({ subject: 'round_purchase' });
    return rows[0];
  }

  private async activePaymentId(tx: Tx, purchaseId: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM billing.payments
        WHERE purchase_id = $1 AND status IN ('pending','authorized','succeeded')`,
      [purchaseId],
    );
    return rows[0]?.id ?? null;
  }

  private async findByProviderRef(
    tx: Tx,
    provider: string,
    providerRef: string,
  ): Promise<PaymentRow | null> {
    const { rows } = await tx.query<PaymentRow>(
      `SELECT id, purchase_id, invoice_id, amount::text AS amount, currency, provider,
              provider_ref, status, mode, failure_reason, created_at, confirmed_at
         FROM billing.payments
        WHERE provider = $1 AND provider_ref = $2
        FOR UPDATE`,
      [provider, providerRef],
    );
    return rows[0] ?? null;
  }
}

/**
 * Записать событие, если такого ещё не было.
 *
 * `ON CONFLICT DO NOTHING` здесь не годится: он требует права SELECT на
 * конфликтующий индекс и молча скрывает разницу между «записали» и «уже
 * было». SAVEPOINT с ловлей 23505 отвечает на этот вопрос прямо — приём уже
 * используется в уведомлениях оператора и покупках.
 */
async function insertEventOnce(
  tx: Tx,
  input: {
    id: string;
    provider: string;
    notification: ProviderNotification;
    paymentId: string | null;
    digest: Buffer;
  },
): Promise<boolean> {
  await tx.query('SAVEPOINT payment_event');
  try {
    await tx.query(
      `INSERT INTO billing.payment_events
         (id, provider, event_id, event_type, payment_id, provider_ref, signature_ok,
          payload_sha256, payload_jsonb)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8::jsonb)`,
      [
        input.id,
        input.provider,
        input.notification.eventId,
        input.notification.eventType,
        input.paymentId,
        input.notification.providerRef,
        input.digest,
        JSON.stringify(input.notification),
      ],
    );
    await tx.query('RELEASE SAVEPOINT payment_event');
    return true;
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT payment_event');
    if ((error as { code?: string }).code === '23505') return false;
    throw error;
  }
}

async function markEvent(tx: Tx, eventId: string, result: string): Promise<void> {
  await tx.query(
    `UPDATE billing.payment_events SET result = $2, applied_at = now() WHERE id = $1`,
    [eventId, result],
  );
}

/** Окончательное состояние: переигрывать его уведомлением нельзя. */
function isFinal(status: string): boolean {
  return ['succeeded', 'failed', 'canceled', 'refunded', 'chargeback'].includes(status);
}

/** Копейки целым числом: денег с плавающей точкой в этом коде нет. */
function toMinor(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

interface PurchaseRow {
  id: string;
  buyer_user_id: string;
  status: string;
  total_amount: string;
  currency: string;
}

interface PaymentRow {
  id: string;
  purchase_id: string | null;
  invoice_id: string | null;
  amount: string;
  currency: string;
  provider: string;
  provider_ref: string | null;
  status: PaymentView['status'];
  mode: PaymentView['mode'];
  failure_reason: string | null;
  created_at: Date;
  confirmed_at: Date | null;
}
