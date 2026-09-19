import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type CommissionAccrual,
  type CreateSubscriptionRequest,
  type Invoice,
  type Subscription,
} from '@unicorn/contracts';
import { AppError, errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Подписки.
 *
 * Цена НЕ приходит от клиента. Для основателя сервер резолвит тариф из
 * `investment_ask` проекта, для инвестора берёт действующую версию
 * `investor_membership`; в подписку кладётся снапшот цены на момент оформления.
 * Дальнейшее изменение тарифной сетки этот снапшот не трогает — человек платит
 * ту цену, на которую подписался, пока подписка жива.
 *
 * Активация подписки в этой фазе выполняется администратором вручную:
 * платёжного провайдера ещё нет, и делать вид, что оплата произошла, нельзя.
 * Подписка живёт в `pending_payment`, а активация — отдельное административное
 * действие с обязательным следом в журнале.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * Оформление подписки инвестора (M094: подписка основателя отменена —
   * запуск раунда оплачивается разово покупкой пакета, 5.9).
   *
   * Тариф выбирает сервер: действующая версия, цена из неё. Повторное
   * нажатие возвращает уже созданную подписку, а не вторую.
   */
  async createSubscription(
    ctx: RequestContext,
    _input: CreateSubscriptionRequest,
  ): Promise<Subscription> {
    return mapDbErrors(async () =>
      this.db.transaction(ctx, async (tx) => {
        const plan = await this.resolveInvestorPlan(tx);

        const existing = await tx.query<{ id: string; status: string }>(
          `SELECT id, status FROM billing.subscriptions
            WHERE user_id = $1 AND status IN ('pending_payment','active','past_due')`,
          [ctx.userId],
        );
        if (existing.rows[0]) {
          return this.readSubscription(tx, existing.rows[0].id);
        }

        const id = uuidv7();
        await tx.query(
          `INSERT INTO billing.subscriptions
             (id, user_id, plan_id, price_snapshot, currency_snapshot, terms_version, status)
           VALUES ($1, $2, $3, $4::numeric, 'RUB', $5, 'pending_payment')`,
          [id, ctx.userId, plan.id, plan.price, plan.terms_version],
        );

        await this.audit.emit(tx, {
          verb: 'billing.subscription.created',
          actorId: ctx.userId,
          actorRole: 'investor',
          subjectType: 'subscription',
          subjectId: id,
          context: { planCode: plan.code, price: plan.price },
          traceId: ctx.traceId,
        });

        return this.readSubscription(tx, id);
      }),
    );
  }

  async listMine(ctx: RequestContext): Promise<Subscription[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<SubscriptionRow>(
        `${SUBSCRIPTION_SELECT} WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 100`,
        [ctx.userId],
      );
      return rows.map(mapSubscription);
    });
  }

  /**
   * Счета, выставленные пользователю.
   *
   * Фильтра по пользователю в запросе нет намеренно: отбор делает RLS
   * (`invoices_party`, M009) — по плательщику-физлицу или по членству в
   * компании-плательщике. Продублировать это условие в SQL значило бы завести
   * второй, расходящийся источник правды о том, чей это счёт.
   *
   * Пустой список — законный ответ: счета выставляются вместе с PDF-документом,
   * а генератора PDF пока нет (TODO, гейт A). Маршрут существует, чтобы
   * клиент имел настоящий контракт, а не 404.
   */
  async listInvoices(ctx: RequestContext): Promise<Invoice[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<InvoiceRow>(
        `SELECT id, number, payer_role, subscription_id, accrual_id,
                amount_due::text AS amount_due, currency, status, issued_at, due_at
           FROM billing.invoices
          ORDER BY issued_at DESC
          LIMIT 200`,
      );
      return rows.map(mapInvoice);
    });
  }

  /**
   * Начисления вознаграждения по своим сделкам.
   *
   * Видимость — стороны договора и админ (`accruals_party`, M009). Суммы
   * отдаются строками: NUMERIC(14,2) в double превращается в деньги с ошибкой.
   */
  async listAccruals(ctx: RequestContext): Promise<CommissionAccrual[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<AccrualRow>(
        `SELECT id, agreement_id, base_amount::text AS base_amount, currency,
                total_pct::text AS total_pct,
                investor_fee_pct::text AS investor_fee_pct,
                issuer_fee_pct::text AS issuer_fee_pct,
                investor_fee_amount::text AS investor_fee_amount,
                issuer_fee_amount::text AS issuer_fee_amount,
                status, accrued_at
           FROM billing.commission_accruals
          ORDER BY accrued_at DESC
          LIMIT 200`,
      );
      return rows.map(mapAccrual);
    });
  }

  async cancel(ctx: RequestContext, subscriptionId: string): Promise<Subscription> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE billing.subscriptions
            SET status = 'canceled', canceled_at = now()
          WHERE id = $1 AND status IN ('pending_payment','active','past_due')
          RETURNING id`,
        [subscriptionId],
      );
      if (!rows[0]) throw errors.notFound({ subject: 'subscription' });

      await this.audit.emit(tx, {
        verb: 'billing.subscription.canceled',
        actorId: ctx.userId,
        actorRole: ctx.roles.includes('admin') ? 'admin' : (ctx.roles[0] ?? 'system'),
        subjectType: 'subscription',
        subjectId: subscriptionId,
        context: {},
        traceId: ctx.traceId,
      });

      return this.readSubscription(tx, subscriptionId);
    });
  }

  // ------------------------------------------------------------------ private

  /**
   * Приём платежей включён?
   *
   * Флаг живёт в `audit.feature_flags` — там же, где выключен регулируемый
   * контур. Отсутствие строки трактуется как «выключено»: неизвестное
   * состояние денежной функции обязано означать отказ, а не приём.
   */
  async assertPaymentsEnabled(ctx: RequestContext): Promise<void> {
    const enabled = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ enabled: boolean }>(
        `SELECT enabled FROM audit.feature_flags WHERE key = 'billing.payments.enabled'`,
      );
      return rows[0]?.enabled ?? false;
    });
    if (!enabled) throw errors.featureDisabled('billing.payments.enabled');
  }

  private async resolveInvestorPlan(tx: Tx): Promise<PlanRow> {
    const { rows } = await tx.query<PlanRow>(
      `SELECT id, code, price::text AS price, 'v1'::text AS terms_version
         FROM billing.subscription_plans
        WHERE code = 'investor_membership'
          AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
        ORDER BY version DESC LIMIT 1`,
    );
    const found = rows[0];
    if (!found) throw errors.internal({ reason: 'no active investor plan' });
    return found;
  }

  private async readSubscription(tx: Tx, id: string): Promise<Subscription> {
    const { rows } = await tx.query<SubscriptionRow>(`${SUBSCRIPTION_SELECT} WHERE s.id = $1`, [
      id,
    ]);
    const row = rows[0];
    if (!row) throw errors.notFound({ subject: 'subscription' });
    return mapSubscription(row);
  }
}

export const SUBSCRIPTION_SELECT = `
  SELECT s.id, s.plan_id, sp.code AS plan_code,
         s.price_snapshot::text AS price_snapshot, s.currency_snapshot,
         s.status, s.current_period_end, s.grace_until, s.created_at
    FROM billing.subscriptions s
    JOIN billing.subscription_plans sp ON sp.id = s.plan_id
`;

interface PlanRow {
  id: string;
  code: string;
  price: string;
  terms_version: string;
}

export interface SubscriptionRow {
  id: string;
  plan_id: string;
  plan_code: Subscription['planCode'];
  price_snapshot: string;
  currency_snapshot: string;
  status: Subscription['status'];
  current_period_end: Date | null;
  grace_until: Date | null;
  created_at: Date;
}

export function mapSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    planId: row.plan_id,
    planCode: row.plan_code,
    priceSnapshot: row.price_snapshot,
    currency: row.currency_snapshot as 'RUB',
    status: row.status,
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
    graceUntil: row.grace_until?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Перевод отказов БД в доменные ошибки. Инварианты формы подписки живут в
 * триггере, поэтому наружу без этого ушла бы 500 с текстом PostgreSQL.
 */
export async function mapDbErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const pg = error as { code?: string; message?: string };
    const message = pg.message ?? '';
    if (pg.code === '23514' && message.includes('price_snapshot')) {
      throw errors.conflict('Цена тарифа изменилась, оформите подписку заново', {
        reason: 'price-drift',
      });
    }
    if (pg.code === '23505') {
      throw errors.conflict('Такая подписка уже существует', { reason: 'duplicate' });
    }
    if (pg.code === '42501') {
      throw errors.forbidden({ stage: 'db-policy' });
    }
    throw error;
  }
}

interface InvoiceRow {
  id: string;
  number: string;
  payer_role: Invoice['payerRole'];
  subscription_id: string | null;
  accrual_id: string | null;
  amount_due: string;
  currency: string;
  status: Invoice['status'];
  issued_at: Date;
  due_at: Date;
}

function mapInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    number: row.number,
    payerRole: row.payer_role,
    subscriptionId: row.subscription_id,
    accrualId: row.accrual_id,
    amountDue: row.amount_due,
    currency: row.currency as 'RUB',
    status: row.status,
    issuedAt: row.issued_at.toISOString(),
    dueAt: row.due_at.toISOString(),
  };
}

interface AccrualRow {
  id: string;
  agreement_id: string;
  base_amount: string;
  currency: string;
  total_pct: string;
  investor_fee_pct: string;
  issuer_fee_pct: string;
  investor_fee_amount: string;
  issuer_fee_amount: string;
  status: CommissionAccrual['status'];
  accrued_at: Date;
}

function mapAccrual(row: AccrualRow): CommissionAccrual {
  return {
    id: row.id,
    agreementId: row.agreement_id,
    baseAmount: row.base_amount,
    currency: row.currency as 'RUB',
    totalPct: row.total_pct,
    investorFeePct: row.investor_fee_pct,
    issuerFeePct: row.issuer_fee_pct,
    investorFeeAmount: row.investor_fee_amount,
    issuerFeeAmount: row.issuer_fee_amount,
    status: row.status,
    accruedAt: row.accrued_at.toISOString(),
  };
}
