import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type RoundPurchaseView,
  type RoundQuote,
  type RoundQuoteSelection,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { getEnv } from '../config/env';
import { ServiceCountriesService } from './service-countries.service';
import { RoundPricingService, roundPurchaseBlocker } from './round-pricing.service';

/**
 * Покупка запуска раунда (5.9.7; структуры M095, поток M103).
 *
 * Порядок, утверждённый владельцем: бесплатная проверка готовности → оплата →
 * выполнение услуг → окончательный допуск → открытие раунда. Каждый шаг
 * отдельный и виден: «оплачено» не означает «услуги сделаны», а «услуги
 * сделаны» не означает «раунд открыт».
 *
 * Покупка относится к ОДНОМУ раунду. Пауза и возобновление повторной оплаты
 * не требуют; после закрытия или отмены новое привлечение — новая покупка.
 *
 * Денег платформа не двигает: подтверждение оплаты здесь — тестовое, оно
 * помечено в самой покупке и закрыто флагом и окружением.
 */
@Injectable()
export class RoundPurchaseService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly countries: ServiceCountriesService,
    private readonly pricing: RoundPricingService,
  ) {}

  /** Сохранённый выбор переживает перезагрузку страницы; денег не фиксирует. */
  async saveSelection(
    ctx: RequestContext,
    roundId: string,
    selection: RoundQuoteSelection,
  ): Promise<RoundQuoteSelection> {
    return this.db.transaction(ctx, async (tx) => {
      await this.assertRoundVisible(tx, roundId);
      const { rows } = await tx.query<SelectionRow>(
        `INSERT INTO billing.round_package_selections
           (round_id, package_code, service_codes, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (round_id) DO UPDATE
           SET package_code = EXCLUDED.package_code,
               service_codes = EXCLUDED.service_codes,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()
         RETURNING package_code, service_codes`,
        [roundId, selection.packageCode ?? null, selection.serviceCodes, ctx.userId],
      );
      return {
        packageCode: rows[0]?.package_code ?? undefined,
        serviceCodes: rows[0]?.service_codes ?? [],
      };
    });
  }

  async selection(tx: Tx, roundId: string): Promise<RoundQuoteSelection> {
    const { rows } = await tx.query<SelectionRow>(
      `SELECT package_code, service_codes FROM billing.round_package_selections
        WHERE round_id = $1`,
      [roundId],
    );
    return {
      packageCode: rows[0]?.package_code ?? undefined,
      serviceCodes: rows[0]?.service_codes ?? [],
    };
  }

  /**
   * Оформить покупку по сохранённому выбору.
   *
   * Сумма берётся из расчёта, а не из тела запроса: иначе клиент назначал бы
   * себе цену. Расчёт выполняется ЗДЕСЬ И СЕЙЧАС — если предложение успели
   * изменить, покупка оформится по новой цене или не оформится вовсе.
   */
  async createPurchase(ctx: RequestContext, roundId: string): Promise<RoundPurchaseView> {
    return this.db.transaction(ctx, async (tx) => {
      const round = await this.loadRound(tx, roundId);
      const { quote, country, policy } = await this.quoteFor(tx, ctx, round);

      if (quote.mode === 'free') {
        throw errors.stateTransition(
          'Запуск этого раунда бесплатен: покупка не нужна и не оформляется',
        );
      }
      if (quote.mode === 'blocked') {
        throw errors.validation(quote.blockers);
      }

      const existing = await this.activePurchase(tx, roundId);
      if (existing) {
        // Повторное нажатие не создаёт вторую покупку: одна действующая на
        // раунд — это и есть защита от двойной оплаты.
        return this.view(tx, existing.id);
      }

      const effective = quote.chosenPackage ?? quote.requiredPackage;
      if (!effective) throw errors.internal({ reason: 'priced quote without package' });

      const { rows: pkg } = await tx.query<{ id: string; validity_days: number }>(
        `SELECT id, validity_days FROM billing.round_packages
          WHERE code = $1 AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
        [effective.code],
      );
      if (!pkg[0]) {
        throw errors.stateTransition('Пакет больше не продаётся: обновите расчёт');
      }

      const purchaseId = uuidv7();
      await tx.query(
        `INSERT INTO billing.round_purchases
           (id, round_id, project_id, buyer_user_id, package_id, package_snapshot,
            country_code, policy_version, total_amount, currency, status, validity_days)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::numeric, $10,
                 'pending_payment', $11)`,
        [
          purchaseId,
          roundId,
          round.project_id,
          ctx.userId,
          pkg[0].id,
          JSON.stringify({
            quote,
            takenAt: new Date().toISOString(),
          }),
          country,
          policy.version,
          quote.total,
          quote.currency,
          pkg[0].validity_days,
        ],
      );

      for (const line of quote.lines) {
        await tx.query(
          `INSERT INTO billing.round_purchase_items
             (id, purchase_id, kind, service_code, title, amount, currency)
           VALUES ($1, $2, $3, $4, $5, $6::numeric, $7)`,
          [
            uuidv7(),
            purchaseId,
            line.kind,
            line.kind === 'service' ? line.code : null,
            line.title,
            line.amount,
            line.currency,
          ],
        );
      }
      // Услуги, входящие в пакет, тоже надо выполнить — но денежной базы у
      // них нет: оплачен пакет целиком. Поэтому они заводятся позициями с
      // нулевой суммой, а не прячутся внутри строки пакета.
      for (const service of effective.services) {
        await tx.query(
          `INSERT INTO billing.round_purchase_items
             (id, purchase_id, kind, service_code, title, amount, currency)
           VALUES ($1, $2, 'service', $3, $4, 0, $5)`,
          [
            uuidv7(),
            purchaseId,
            service.code,
            `${service.name} (в составе пакета)`,
            quote.currency,
          ],
        );
      }

      await this.audit.emit(tx, {
        verb: 'billing.round_purchase.created',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'round_purchase',
        subjectId: purchaseId,
        context: {
          roundId,
          package: effective.code,
          total: quote.total,
          currency: quote.currency,
        },
        traceId: ctx.traceId,
      });

      return this.view(tx, purchaseId);
    });
  }

  /**
   * Тестовое подтверждение оплаты.
   *
   * Это НЕ приём платежа: денег никто не переводит. Действие существует, чтобы
   * сквозной сценарий можно было пройти локально, и поэтому закрыто трижды:
   * ролью администратора, флагом платформы и окружением. В рабочем окружении
   * оно недоступно, даже если флаг кто-то включит, — иначе получился бы обход
   * оплаты. Покупка навсегда помечается как оплаченная тестом.
   */
  async confirmTestPayment(ctx: RequestContext, purchaseId: string): Promise<RoundPurchaseView> {
    if (getEnv().NODE_ENV === 'production') {
      throw errors.forbidden(
        { purchaseId },
        'Тестовое подтверждение оплаты недоступно в рабочем окружении',
      );
    }
    const view = await this.db.transaction(ctx, async (tx) => {
      const { rows: flag } = await tx.query<{ enabled: boolean }>(
        `SELECT enabled FROM audit.feature_flags WHERE key = 'billing.test_payment_confirmation'`,
      );
      if (!flag[0]?.enabled) {
        throw errors.featureDisabled('billing.test_payment_confirmation');
      }

      const { rowCount } = await tx.query(
        `UPDATE billing.round_purchases
            SET status = 'paid', paid_at = now(), is_test_payment = true,
                status_reason = 'тестовое подтверждение оплаты'
          WHERE id = $1 AND status = 'pending_payment'`,
        [purchaseId],
      );
      if (rowCount === 0) {
        throw errors.stateTransition('Покупка не ожидает оплаты');
      }

      await this.audit.emit(tx, {
        verb: 'billing.round_purchase.paid',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'round_purchase',
        subjectId: purchaseId,
        context: { test: true },
        traceId: ctx.traceId,
      });
      return this.view(tx, purchaseId);
    });

    // Только ПОСЛЕ успешного подтверждения: отменять чужой платёж из-за
    // запроса, который сам был отвергнут флагом или состоянием, нельзя.
    await this.cancelPendingPayments(ctx.traceId, purchaseId);
    return view;
  }

  /**
   * Снять незавершённый платёж у покупки, оплаченной другим путём.
   *
   * Ручное подтверждение оператора и оплата через провайдера — два разных
   * пути к одной покупке, и они могут пересечься: основатель нажал «оплатить»,
   * а платформа тем временем отметила поступление сама. Без этого у оплаченной
   * покупки навсегда оставался бы платёж «в ожидании» — состояние, которое
   * никто уже не закроет и которое мешает понять, чем именно заплачено.
   */
  private async cancelPendingPayments(traceId: string, purchaseId: string): Promise<void> {
    await this.db.asServiceRole('app_billing', { traceId }, async (tx) => {
      await tx.query(
        `UPDATE billing.payments
            SET status = 'canceled',
                failure_reason = 'покупка оплачена другим путём: платёж не понадобился',
                updated_at = now()
          WHERE purchase_id = $1 AND status IN ('pending', 'authorized')`,
        [purchaseId],
      );
    });
  }

  /**
   * Отметить состояние услуги по покупке.
   *
   * Ставит ЧЕЛОВЕК и с основанием. Автоматической отметки «выполнено» здесь
   * нет и не будет: разбор с экспертом и работа ИИ не становятся сделанными
   * оттого, что покупка оплачена.
   */
  async setItemFulfillment(
    ctx: RequestContext,
    itemId: string,
    input: { status: 'planned' | 'in_progress' | 'fulfilled' | 'not_fulfilled'; note: string },
  ): Promise<RoundPurchaseView> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{ purchase_id: string }>(
        `UPDATE billing.round_purchase_items
            SET fulfillment_status = $2, fulfillment_note = $3,
                fulfilled_by = $4,
                fulfilled_at = CASE WHEN $2 = 'fulfilled' THEN now() ELSE NULL END
          WHERE id = $1
          RETURNING purchase_id`,
        [itemId, input.status, input.note, ctx.userId],
      );
      if (!rows[0]) throw errors.notFound({ subject: 'round_purchase_item' });

      await this.audit.emit(tx, {
        verb: 'billing.round_purchase.item_fulfilled',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'round_purchase',
        subjectId: rows[0].purchase_id,
        context: { itemId, status: input.status, note: input.note },
        traceId: ctx.traceId,
      });
      return this.view(tx, rows[0].purchase_id);
    });
  }

  /** Все покупки — для экрана платформы: что оплатить и что выполнить. */
  async listAll(ctx: RequestContext): Promise<RoundPurchaseView[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM billing.round_purchases ORDER BY created_at DESC LIMIT 50`,
      );
      const views: RoundPurchaseView[] = [];
      for (const row of rows) views.push(await this.view(tx, row.id));
      return views;
    });
  }

  /** Покупка по раунду — для экрана основателя и администратора. */
  async forRound(ctx: RequestContext, roundId: string): Promise<RoundPurchaseView | null> {
    return this.db.readOnly(ctx, async (tx) => {
      const active = await this.activePurchase(tx, roundId);
      return active ? this.view(tx, active.id) : null;
    });
  }

  // ------------------------------------------------------------------ helpers

  private async quoteFor(
    tx: Tx,
    ctx: RequestContext,
    round: RoundRow,
  ): Promise<{ quote: RoundQuote; country: string; policy: { version: number; config: never } }> {
    const country = round.service_country ?? (await this.countries.userCountry(tx, ctx.userId!));
    if (!country) {
      throw errors.validation([
        { path: 'serviceCountry', message: 'у аккаунта не выбрана страна обслуживания' },
      ]);
    }
    const policy = round.policy_version
      ? await this.countries.policyVersion(tx, country, round.policy_version)
      : await this.countries.activePolicy(tx, country);
    if (!policy) {
      throw errors.validation([
        { path: 'serviceCountry', message: 'для страны нет действующих условий' },
      ]);
    }
    const selection = await this.selection(tx, round.id);
    const quote = await this.pricing.quote(tx, {
      countryCode: country,
      policy,
      target: round.target,
      currency: round.currency,
      selection,
    });
    return { quote, country, policy: policy as never };
  }

  private async loadRound(tx: Tx, roundId: string): Promise<RoundRow> {
    const { rows } = await tx.query<RoundRow>(
      `SELECT id, project_id, target::text AS target, currency, service_country, policy_version,
              status
         FROM lab.funding_rounds WHERE id = $1`,
      [roundId],
    );
    if (!rows[0]) throw errors.notFound({ subject: 'funding_round' });
    return rows[0];
  }

  private async assertRoundVisible(tx: Tx, roundId: string): Promise<void> {
    await this.loadRound(tx, roundId);
  }

  private async activePurchase(tx: Tx, roundId: string): Promise<{ id: string } | null> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM billing.round_purchases
        WHERE round_id = $1 AND status IN ('pending_payment','paid')`,
      [roundId],
    );
    return rows[0] ?? null;
  }

  private async view(tx: Tx, purchaseId: string): Promise<RoundPurchaseView> {
    const { rows } = await tx.query<PurchaseRow>(
      `SELECT p.id, p.round_id, p.project_id, p.status, p.total_amount::text AS total_amount,
              p.currency, p.is_test_payment, p.validity_days, p.created_at, p.paid_at,
              p.package_snapshot
         FROM billing.round_purchases p WHERE p.id = $1`,
      [purchaseId],
    );
    if (!rows[0]) throw errors.notFound({ subject: 'round_purchase' });
    const { rows: items } = await tx.query<ItemRow>(
      `SELECT id, kind, service_code, title, amount::text AS amount, currency,
              fulfillment_status, fulfillment_note, fulfilled_at
         FROM billing.round_purchase_items WHERE purchase_id = $1 ORDER BY kind DESC, title`,
      [purchaseId],
    );
    // Тот же ответ, что увидит гейт: экран не должен обещать открытие там,
    // где допуск откажет.
    const blocker = await roundPurchaseBlocker(tx, rows[0].round_id);
    return {
      id: rows[0].id,
      roundId: rows[0].round_id,
      projectId: rows[0].project_id,
      status: rows[0].status,
      totalAmount: rows[0].total_amount,
      currency: rows[0].currency as RoundPurchaseView['currency'],
      isTestPayment: rows[0].is_test_payment,
      validityDays: rows[0].validity_days,
      createdAt: rows[0].created_at.toISOString(),
      paidAt: rows[0].paid_at?.toISOString() ?? null,
      packageCode: rows[0].package_snapshot?.quote?.chosenPackage?.code
        ? rows[0].package_snapshot.quote.chosenPackage.code
        : (rows[0].package_snapshot?.quote?.requiredPackage?.code ?? null),
      items: items.map((item) => ({
        id: item.id,
        kind: item.kind,
        serviceCode: item.service_code,
        title: item.title,
        amount: item.amount,
        currency: item.currency as RoundPurchaseView['currency'],
        fulfillmentStatus: item.fulfillment_status,
        fulfillmentNote: item.fulfillment_note,
        fulfilledAt: item.fulfilled_at?.toISOString() ?? null,
      })),
      openBlocker: blocker,
    };
  }
}

function actorRole(ctx: RequestContext): string {
  return ctx.roles?.includes('admin') ? 'admin' : 'founder';
}

interface SelectionRow {
  package_code: string | null;
  service_codes: string[];
}

interface RoundRow {
  id: string;
  project_id: string;
  target: string | null;
  currency: string | null;
  service_country: string | null;
  policy_version: number | null;
  status: string;
}

interface PurchaseRow {
  id: string;
  round_id: string;
  project_id: string;
  status: RoundPurchaseView['status'];
  total_amount: string;
  currency: string;
  is_test_payment: boolean;
  validity_days: number;
  created_at: Date;
  paid_at: Date | null;
  package_snapshot: { quote?: RoundQuote } | null;
}

interface ItemRow {
  id: string;
  kind: 'package' | 'service';
  service_code: string | null;
  title: string;
  amount: string;
  currency: string;
  fulfillment_status: RoundPurchaseView['items'][number]['fulfillmentStatus'];
  fulfillment_note: string | null;
  fulfilled_at: Date | null;
}
