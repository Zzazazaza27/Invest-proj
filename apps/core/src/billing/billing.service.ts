import { Injectable } from '@nestjs/common';
import { uuidv7, type CreateSubscriptionRequest, type Subscription } from '@unicorn/contracts';
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

  async createSubscription(
    ctx: RequestContext,
    input: CreateSubscriptionRequest,
  ): Promise<Subscription> {
    return mapDbErrors(async () =>
      this.db.transaction(ctx, async (tx) => {
        const plan =
          input.audience === 'founder'
            ? await this.resolveFounderPlanForProject(tx, input.projectId, ctx.userId!)
            : await this.resolveInvestorPlan(tx);

        if (plan.individual_pricing) {
          // Индивидуальный тариф не оформляется самообслуживанием: цена
          // назначается администратором и утверждается вторым (4-eyes).
          throw errors.planUpgradeRequired(
            'Этот тариф оформляется через менеджера: цена согласуется индивидуально',
          );
        }

        const existing = await tx.query<{ id: string; status: string }>(
          input.audience === 'founder'
            ? `SELECT id, status FROM billing.subscriptions
                WHERE project_id = $1 AND status IN ('pending_payment','active','past_due')`
            : `SELECT id, status FROM billing.subscriptions
                WHERE user_id = $1 AND project_id IS NULL
                  AND status IN ('pending_payment','active','past_due')`,
          [input.audience === 'founder' ? input.projectId : ctx.userId],
        );
        if (existing.rows[0]) {
          // Повторное оформление — не ошибка пользователя, а повторное нажатие.
          return this.readSubscription(tx, existing.rows[0].id);
        }

        const id = uuidv7();
        await tx.query(
          `INSERT INTO billing.subscriptions
             (id, user_id, plan_id, project_id, price_snapshot, currency_snapshot,
              terms_version, status)
           VALUES ($1, $2, $3, $4, $5::numeric, 'RUB', $6, 'pending_payment')`,
          [
            id,
            ctx.userId,
            plan.id,
            input.audience === 'founder' ? input.projectId : null,
            plan.price,
            plan.terms_version,
          ],
        );

        await this.audit.emit(tx, {
          verb: 'billing.subscription.created',
          actorId: ctx.userId,
          actorRole: input.audience,
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

  private async resolveFounderPlanForProject(
    tx: Tx,
    projectId: string,
    userId: string,
  ): Promise<PlanRow> {
    const project = await tx.query<{ investment_ask: string; owner: string | null }>(
      `SELECT p.investment_ask::text AS investment_ask,
              (SELECT fp.user_id FROM lab.founders_projects fp
                WHERE fp.project_id = p.id AND fp.role = 'owner') AS owner
         FROM lab.projects p
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [projectId],
    );
    const row = project.rows[0];
    if (!row) throw errors.notFound({ subject: 'project' });
    if (row.owner !== userId) {
      // Подписку оплачивает владелец проекта. Иначе один основатель мог бы
      // «подписать» чужой проект и получить влияние на его публикацию.
      throw errors.forbidden({ stage: 'not-project-owner' });
    }

    const plan = await tx.query<PlanRow>(
      `SELECT id, code, price::text AS price, individual_pricing,
              'v1'::text AS terms_version
         FROM billing.subscription_plans
        WHERE id = billing.resolve_founder_plan($1::numeric)`,
      [row.investment_ask],
    );
    const found = plan.rows[0];
    if (!found)
      throw errors.internal({ reason: 'no active founder plan', ask: row.investment_ask });
    return found;
  }

  private async resolveInvestorPlan(tx: Tx): Promise<PlanRow> {
    const { rows } = await tx.query<PlanRow>(
      `SELECT id, code, price::text AS price, individual_pricing,
              'v1'::text AS terms_version
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
  SELECT s.id, s.plan_id, sp.code AS plan_code, s.project_id,
         s.price_snapshot::text AS price_snapshot, s.currency_snapshot,
         s.status, s.current_period_end, s.grace_until, s.created_at
    FROM billing.subscriptions s
    JOIN billing.subscription_plans sp ON sp.id = s.plan_id
`;

interface PlanRow {
  id: string;
  code: string;
  price: string | null;
  individual_pricing: boolean;
  terms_version: string;
}

export interface SubscriptionRow {
  id: string;
  plan_id: string;
  plan_code: Subscription['planCode'];
  project_id: string | null;
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
    projectId: row.project_id,
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
    if (pg.code === '23514' && message.includes('requires an approved custom_price')) {
      throw errors.planUpgradeRequired('Тариф требует утверждённой индивидуальной цены');
    }
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
