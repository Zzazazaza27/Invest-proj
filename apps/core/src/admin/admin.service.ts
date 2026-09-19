import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type AdminPlan,
  type AdminSubscription,
  type ClosePlanRequest,
  type FeatureFlag,
  type PublishPlanRequest,
  type UpdateDraftPlanRequest,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { mapDbErrors } from '../billing/billing.service';
import { llmModelVersion } from '../ai/provider-credentials.service';

/**
 * Административное управление платформой.
 *
 * Главное правило раздела тарифов: **цена не редактируется, цена публикуется**.
 * Администратор не «меняет число в поле», а объявляет новую версию условий — с
 * датой, с которой она вступает в силу. Прежняя версия закрывается ровно этим
 * моментом и остаётся в истории: под ней кто-то подписался, и переписать её
 * задним числом нельзя ни через API, ни напрямую в БД (ADR-005, триггер
 * `subscription_plans_history_immutable`).
 *
 * Отсюда естественно получается сценарий «объявляем: с 1-го числа следующего
 * месяца тариф стоит столько»: публикуется версия с будущей `validFrom`. До
 * этой даты продаётся старая цена, после — новая. Объявление можно отменить,
 * пока оно не вступило в силу.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  // ---------------------------------------------------------------- тарифы

  async listPlans(ctx: RequestContext): Promise<AdminPlan[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<PlanRow>(
        `SELECT p.id, p.code, p.version, p.name,
                p.price::text AS price, p.currency, p.billing_period,
                p.features_jsonb, p.valid_from, p.valid_to,
                (SELECT count(*) FROM billing.subscriptions s WHERE s.plan_id = p.id)::int
                  AS subscriptions_count
           FROM billing.subscription_plans p
          ORDER BY p.code, p.version DESC`,
      );
      return rows.map(mapPlan);
    });
  }

  async publishPlan(ctx: RequestContext, input: PublishPlanRequest): Promise<AdminPlan> {
    const validFrom = input.validFrom ? new Date(input.validFrom) : new Date();
    // Задним числом опубликовать цену нельзя: это означало бы пересчёт условий
    // за период, который уже прожит.
    if (validFrom.getTime() < Date.now() - 60_000) {
      throw errors.validation([
        { path: 'validFrom', message: 'дата вступления в силу не может быть в прошлом' },
      ]);
    }

    return mapDbErrors(async () =>
      this.db.transaction(ctx, async (tx) => {
        const scheduled = await tx.query<{ id: string; valid_from: Date }>(
          `SELECT id, valid_from FROM billing.subscription_plans
            WHERE code = $1 AND valid_from > now()`,
          [input.code],
        );
        if (scheduled.rows[0]) {
          // Два объявления на один тариф — источник спора о том, какая цена
          // действует. Сначала отменяется прежнее объявление.
          throw errors.conflict(
            'По этому тарифу уже объявлено изменение: отмените его или отредактируйте',
            { scheduledId: scheduled.rows[0].id },
          );
        }

        const current = await tx.query<{ id: string; valid_from: Date }>(
          `SELECT id, valid_from FROM billing.subscription_plans
            WHERE code = $1 AND valid_from <= now() AND (valid_to IS NULL OR valid_to > $2)
            ORDER BY version DESC LIMIT 1`,
          [input.code, validFrom.toISOString()],
        );

        // Действующая версия закрывается ровно тем моментом, с которого
        // начинает действовать новая: разрыва и наложения быть не должно.
        if (current.rows[0]) {
          await tx.query(`UPDATE billing.subscription_plans SET valid_to = $2 WHERE id = $1`, [
            current.rows[0].id,
            validFrom.toISOString(),
          ]);
        }

        const next = await tx.query<{ next_version: number }>(
          `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
             FROM billing.subscription_plans WHERE code = $1`,
          [input.code],
        );
        const version = Number(next.rows[0]?.next_version ?? 1);
        const id = uuidv7();

        await tx.query(
          `INSERT INTO billing.subscription_plans
             (id, code, version, name, price, currency, billing_period, features_jsonb, valid_from)
           VALUES ($1, $2, $3, $4, $5::numeric, 'RUB', $6, $7::jsonb, $8)`,
          [
            id,
            input.code,
            version,
            input.name,
            input.price,
            input.billingPeriod,
            JSON.stringify(input.features),
            validFrom.toISOString(),
          ],
        );

        await this.audit.emit(tx, {
          verb: 'billing.plan.published',
          actorId: ctx.userId,
          actorRole: 'admin',
          subjectType: 'subscription_plan',
          subjectId: id,
          context: {
            code: input.code,
            version,
            price: input.price,
            validFrom: validFrom.toISOString(),
            replacedPlanId: current.rows[0]?.id ?? null,
          },
          traceId: ctx.traceId,
        });

        return this.readPlan(tx, id);
      }),
    );
  }

  /** Правка объявления, которое ещё не вступило в силу. */
  async updateDraftPlan(
    ctx: RequestContext,
    planId: string,
    input: UpdateDraftPlanRequest,
  ): Promise<AdminPlan> {
    return mapDbErrors(async () =>
      this.db.transaction(ctx, async (tx) => {
        const plan = await this.requireScheduledPlan(tx, planId);

        await tx.query(
          `UPDATE billing.subscription_plans
              SET name           = COALESCE($2, name),
                  price          = COALESCE($3::numeric, price),
                  features_jsonb = COALESCE($4::jsonb, features_jsonb),
                  valid_from     = COALESCE($5::timestamptz, valid_from)
            WHERE id = $1`,
          [
            planId,
            input.name ?? null,
            input.price ?? null,
            input.features ? JSON.stringify(input.features) : null,
            input.validFrom ?? null,
          ],
        );

        // Если сдвинули дату вступления в силу — предыдущая версия должна
        // закрываться в тот же момент, иначе в тарифной сетке появится дыра.
        if (input.validFrom) {
          await tx.query(
            `UPDATE billing.subscription_plans
                SET valid_to = $2
              WHERE code = $1 AND id <> $3 AND valid_to IS NOT NULL AND valid_from <= now()`,
            [plan.code, input.validFrom, planId],
          );
        }

        await this.audit.emit(tx, {
          verb: 'billing.plan.draft_updated',
          actorId: ctx.userId,
          actorRole: 'admin',
          subjectType: 'subscription_plan',
          subjectId: planId,
          context: { fields: Object.keys(input) },
          traceId: ctx.traceId,
        });

        return this.readPlan(tx, planId);
      }),
    );
  }

  /** Отмена объявленного изменения до его вступления в силу. */
  async cancelScheduledPlan(ctx: RequestContext, planId: string): Promise<{ ok: true }> {
    return mapDbErrors(async () =>
      this.db.transaction(ctx, async (tx) => {
        const plan = await this.requireScheduledPlan(tx, planId);

        await tx.query('DELETE FROM billing.subscription_plans WHERE id = $1', [planId]);
        // Прежняя версия снова становится бессрочной: её закрывали именно под
        // это объявление.
        await tx.query(
          `UPDATE billing.subscription_plans
              SET valid_to = NULL
            WHERE code = $1 AND valid_to = $2`,
          [plan.code, plan.valid_from],
        );

        await this.audit.emit(tx, {
          verb: 'billing.plan.schedule_canceled',
          actorId: ctx.userId,
          actorRole: 'admin',
          subjectType: 'subscription_plan',
          subjectId: planId,
          context: { code: plan.code, plannedFrom: plan.valid_from.toISOString() },
          traceId: ctx.traceId,
        });

        return { ok: true as const };
      }),
    );
  }

  /** Снятие тарифа с продажи. Действующие подписки не трогаются. */
  async closePlan(
    ctx: RequestContext,
    planId: string,
    input: ClosePlanRequest,
  ): Promise<AdminPlan> {
    // Явно заданный момент берётся как есть; «сейчас» — НЕ часы приложения.
    // Раньше здесь стоял `new Date()`, и снятие с продажи получало метку на
    // несколько миллисекунд ПОЗЖЕ времени транзакции в БД. Витрина фильтрует
    // по `now()` базы, поэтому в это окно только что снятый тариф ещё
    // продавался — поймано прогоном smoke-billing, падение плавающее.
    const validTo = input.validTo ? new Date(input.validTo) : null;
    return mapDbErrors(async () =>
      this.db.transaction(ctx, async (tx) => {
        const { rows } = await tx.query<{ id: string; valid_from: Date; valid_to: Date | null }>(
          'SELECT id, valid_from, valid_to FROM billing.subscription_plans WHERE id = $1',
          [planId],
        );
        const plan = rows[0];
        if (!plan) throw errors.notFound({ subject: 'subscription_plan' });
        if (plan.valid_to && plan.valid_to.getTime() <= Date.now()) {
          throw errors.stateTransition('Эта версия тарифа уже закрыта');
        }
        if (validTo && validTo.getTime() <= plan.valid_from.getTime()) {
          throw errors.validation([
            { path: 'validTo', message: 'закрытие раньше начала действия версии' },
          ]);
        }

        // `coalesce($2, now())`: момент закрытия берётся из ТОЙ ЖЕ базы, по
        // часам которой его потом читает витрина. Никакого окна между «часами
        // приложения» и «часами БД» не остаётся.
        const { rows: closed } = await tx.query<{ valid_to: Date }>(
          `UPDATE billing.subscription_plans
              SET valid_to = coalesce($2::timestamptz, now())
            WHERE id = $1
        RETURNING valid_to`,
          [planId, validTo ? validTo.toISOString() : null],
        );
        const effectiveValidTo = closed[0]!.valid_to;

        await this.audit.emit(tx, {
          verb: 'billing.plan.closed',
          actorId: ctx.userId,
          actorRole: 'admin',
          subjectType: 'subscription_plan',
          subjectId: planId,
          context: { validTo: effectiveValidTo.toISOString(), reason: input.reason },
          traceId: ctx.traceId,
        });

        return this.readPlan(tx, planId);
      }),
    );
  }

  // ------------------------------------------------------------- подписки

  async listSubscriptions(ctx: RequestContext, limit: number): Promise<AdminSubscription[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<AdminSubscriptionRow>(
        `SELECT s.id, s.plan_id, sp.code AS plan_code,
                s.price_snapshot::text AS price_snapshot, s.currency_snapshot,
                s.status, s.current_period_end, s.grace_until, s.created_at,
                s.user_id, u.display_name
           FROM billing.subscriptions s
           JOIN billing.subscription_plans sp ON sp.id = s.plan_id
           JOIN identity.users u ON u.id = s.user_id
          ORDER BY s.created_at DESC
          LIMIT $1`,
        [limit],
      );
      return rows.map(mapAdminSubscription);
    });
  }

  /**
   * Активация подписки администратором.
   *
   * Временная мера на период отсутствия платёжного провайдера: оплата
   * подтверждается человеком, а не системой. Каждое такое действие попадает в
   * журнал с указанием, кто и на каком основании активировал — иначе платный
   * доступ выдавался бы без следа.
   */
  async activateSubscription(
    ctx: RequestContext,
    subscriptionId: string,
    reason: string,
  ): Promise<AdminSubscription> {
    return mapDbErrors(async () =>
      this.db.transaction(ctx, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `UPDATE billing.subscriptions
              SET status = 'active',
                  current_period_end = COALESCE(current_period_end, now() + interval '30 days')
            WHERE id = $1 AND status IN ('pending_payment','past_due')
            RETURNING id`,
          [subscriptionId],
        );
        if (!rows[0]) {
          throw errors.stateTransition('Подписку в этом статусе активировать нельзя');
        }

        await this.audit.emit(tx, {
          verb: 'lab.subscription.activated',
          actorId: ctx.userId,
          actorRole: 'system',
          subjectType: 'subscription',
          subjectId: subscriptionId,
          context: { activatedBy: ctx.userId, reason, mode: 'manual' },
          traceId: ctx.traceId,
        });

        return this.readAdminSubscription(tx, subscriptionId);
      }),
    );
  }

  // --------------------------------------------------------- фичефлаги

  async listFeatureFlags(ctx: RequestContext): Promise<FeatureFlag[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<FlagRow>(
        'SELECT key, enabled, rules_jsonb, updated_at FROM audit.feature_flags ORDER BY key',
      );
      return rows.map((r) => ({
        key: r.key,
        enabled: r.enabled,
        rules: r.rules_jsonb,
        updatedAt: r.updated_at.toISOString(),
      }));
    });
  }

  private async switchScoringModel(tx: Tx, enableLlm: boolean): Promise<void> {
    if (!enableLlm) {
      await tx.query(
        `UPDATE scoring.score_models SET is_active = false WHERE name = 'ai_score' AND is_active`,
      );
      await tx.query(
        `UPDATE scoring.score_models SET is_active = true
          WHERE name = 'ai_score' AND version = 'v0.1-heuristic'`,
      );
      return;
    }
    const credential = await tx.query<{ provider: string; model_name: string | null }>(
      `SELECT provider, model_name FROM scoring.ai_provider_credentials WHERE is_active`,
    );
    const active = credential.rows[0];
    if (!active) {
      throw errors.stateTransition(
        'LLM-скоринг нельзя включить без активного ключа провайдера — задайте его в разделе «ИИ-скоринг»',
      );
    }
    const version = llmModelVersion(active.provider, active.model_name);
    const model = await tx.query<{ id: string; passed: boolean | null }>(
      `SELECT id, (eval_metrics_jsonb->>'passed')::boolean AS passed
         FROM scoring.score_models WHERE name = 'ai_score' AND version = $1`,
      [version],
    );
    if (!model.rows[0]?.passed) {
      throw errors.stateTransition(
        `LLM-скоринг нельзя включить без зелёного eval-гейта для ${version}: ` +
          'прогоните node scripts/eval-ai-scoring.mjs',
      );
    }
    await tx.query(
      `UPDATE scoring.score_models SET is_active = false WHERE name = 'ai_score' AND is_active`,
    );
    await tx.query(`UPDATE scoring.score_models SET is_active = true WHERE id = $1`, [
      model.rows[0].id,
    ]);
  }

  async setFeatureFlag(
    ctx: RequestContext,
    key: string,
    enabled: boolean,
    reason: string,
  ): Promise<FeatureFlag> {
    return mapDbErrors(async () =>
      this.db.transaction(ctx, async (tx) => {
        // Включение LLM-скоринга — состояние продукта, а не переключатель
        // (ADR-008 §6): без активного ключа и зелёного eval-гейта под текущую
        // версию промпта сервер отказывает. Активная модель `ai_score`
        // переключается той же транзакцией, чтобы паспорт ссылался на ту
        // модель, которой посчитан.
        if (key === 'ai.scoring.llm.enabled') {
          await this.switchScoringModel(tx, enabled);
        }
        const { rows } = await tx.query<FlagRow>(
          `UPDATE audit.feature_flags
              SET enabled = $2, updated_by = $3, updated_at = now()
            WHERE key = $1
            RETURNING key, enabled, rules_jsonb, updated_at`,
          [key, enabled, ctx.userId],
        );
        const row = rows[0];
        if (!row) throw errors.notFound({ subject: 'feature_flag' });

        await this.audit.emit(tx, {
          verb: 'admin.feature_flag.changed',
          actorId: ctx.userId,
          actorRole: 'admin',
          subjectType: 'feature_flag',
          subjectId: null,
          context: { key, enabled, reason },
          traceId: ctx.traceId,
        });

        return {
          key: row.key,
          enabled: row.enabled,
          rules: row.rules_jsonb,
          updatedAt: row.updated_at.toISOString(),
        };
      }),
    );
  }

  // ------------------------------------------------------------------ private

  private async requireScheduledPlan(
    tx: Tx,
    planId: string,
  ): Promise<{ code: string; valid_from: Date }> {
    const { rows } = await tx.query<{ code: string; valid_from: Date }>(
      'SELECT code, valid_from FROM billing.subscription_plans WHERE id = $1',
      [planId],
    );
    const plan = rows[0];
    if (!plan) throw errors.notFound({ subject: 'subscription_plan' });
    if (plan.valid_from.getTime() <= Date.now()) {
      throw errors.stateTransition(
        'Версия уже вступила в силу: её условия неизменяемы. Опубликуйте новую версию',
      );
    }
    return plan;
  }

  private async readPlan(tx: Tx, planId: string): Promise<AdminPlan> {
    const { rows } = await tx.query<PlanRow>(
      `SELECT p.id, p.code, p.version, p.name,
              p.price::text AS price, p.currency, p.billing_period,
              p.features_jsonb, p.valid_from, p.valid_to,
              (SELECT count(*) FROM billing.subscriptions s WHERE s.plan_id = p.id)::int
                AS subscriptions_count
         FROM billing.subscription_plans p WHERE p.id = $1`,
      [planId],
    );
    const row = rows[0];
    if (!row) throw errors.notFound({ subject: 'subscription_plan' });
    return mapPlan(row);
  }

  private async readAdminSubscription(tx: Tx, id: string): Promise<AdminSubscription> {
    const { rows } = await tx.query<AdminSubscriptionRow>(
      `SELECT s.id, s.plan_id, sp.code AS plan_code,
              s.price_snapshot::text AS price_snapshot, s.currency_snapshot,
              s.status, s.current_period_end, s.grace_until, s.created_at,
              s.user_id, u.display_name
         FROM billing.subscriptions s
         JOIN billing.subscription_plans sp ON sp.id = s.plan_id
         JOIN identity.users u ON u.id = s.user_id
        WHERE s.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw errors.notFound({ subject: 'subscription' });
    return mapAdminSubscription(row);
  }
}

interface PlanRow {
  id: string;
  code: AdminPlan['code'];
  version: number;
  name: string;
  price: string;
  currency: string;
  billing_period: AdminPlan['billingPeriod'];
  features_jsonb: Record<string, unknown>;
  valid_from: Date;
  valid_to: Date | null;
  subscriptions_count: number;
}

interface FlagRow {
  key: string;
  enabled: boolean;
  rules_jsonb: Record<string, unknown>;
  updated_at: Date;
}

interface AdminSubscriptionRow {
  id: string;
  plan_id: string;
  plan_code: AdminSubscription['planCode'];
  price_snapshot: string;
  currency_snapshot: string;
  status: AdminSubscription['status'];
  current_period_end: Date | null;
  grace_until: Date | null;
  created_at: Date;
  user_id: string;
  display_name: string;
}

function mapPlan(row: PlanRow): AdminPlan {
  const now = Date.now();
  const from = row.valid_from.getTime();
  const to = row.valid_to?.getTime() ?? null;
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    name: row.name,
    price: row.price,
    currency: row.currency as 'RUB',
    billingPeriod: row.billing_period,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to?.toISOString() ?? null,
    features: row.features_jsonb,
    // Версия «заперта», как только начала действовать: с этого момента её
    // денежные условия — исторический факт, а не настройка.
    isLocked: from <= now,
    isActive: from <= now && (to === null || to > now),
    subscriptionsCount: row.subscriptions_count,
  };
}

function mapAdminSubscription(row: AdminSubscriptionRow): AdminSubscription {
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
    userId: row.user_id,
    userDisplayName: row.display_name,
  };
}
