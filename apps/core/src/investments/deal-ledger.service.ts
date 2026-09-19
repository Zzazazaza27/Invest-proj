import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type CancelTrancheReturnRequest,
  type CommissionAdjustment,
  type DealLedger,
  type DealSummary,
  type RecordCommissionAdjustmentRequest,
  type RecordTrancheReturnRequest,
  type TrancheReturn,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext } from '../db/unit-of-work';
import { assertAssignedToAgreement, assertCapability } from '../identity/capabilities.service';

/**
 * Ручные денежные записи по сделке (M097): фиксация возврата по траншу и
 * корректировка вознаграждения.
 *
 * Здесь НЕТ платёжных команд. «Зафиксировать возврат» — запись о состоявшемся
 * событии: платформа денег не перечисляет, а переговоры и урегулирование
 * проходят между людьми. По той же причине возврат инвестиции сам по себе не
 * отменяет комиссию: решение об этом принимает человек и фиксирует отдельно.
 *
 * Каждое действие требует ДВУХ независимых проверок:
 *
 *   1. функционального полномочия — вправе ли сотрудник делать такое вообще;
 *   2. области работы — вправе ли он работать с ЭТОЙ сделкой.
 *
 * Обсуждение возврата, фиксация факта и корректировка комиссии — разные
 * полномочия: тот, кто ведёт переговоры, не обязан уметь править деньги.
 */
@Injectable()
export class DealLedgerService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * Сделки, с которыми сотрудник вправе работать.
   *
   * Список нужен, чтобы ручную запись можно было пройти в интерфейсе, а не
   * подставлять идентификаторы руками. Контур сделок может быть выключен —
   * фиксация СОСТОЯВШЕГОСЯ события от этого не зависит: запись о прошлом не
   * создаёт новых сделок.
   */
  async list(ctx: RequestContext): Promise<DealSummary[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<DealSummaryRow>(
        `SELECT a.id, a.status, a.contract_amount::text AS contract_amount, a.currency,
                a.created_at, o.project_id, p.title AS project_title,
                (SELECT count(*)::int FROM investments.investment_tranches t
                  WHERE t.agreement_id = a.id AND t.status = 'confirmed') AS confirmed_tranches
           FROM investments.investment_agreements a
           JOIN investments.investment_offers o ON o.id = a.offer_id
           JOIN lab.projects p ON p.id = o.project_id
          ORDER BY a.created_at DESC
          LIMIT 50`,
      );
      return rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        projectTitle: row.project_title,
        status: row.status,
        contractAmount: row.contract_amount,
        currency: row.currency as DealSummary['currency'],
        confirmedTranches: row.confirmed_tranches,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  /** Денежная картина сделки: транши с возвратами, начисления с корректировками. */
  async ledger(ctx: RequestContext, agreementId: string): Promise<DealLedger> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows: deal } = await tx.query<{
        project_id: string;
        contract_amount: string;
        currency: string;
      }>(
        `SELECT o.project_id, a.contract_amount::text AS contract_amount, a.currency
           FROM investments.investment_agreements a
           JOIN investments.investment_offers o ON o.id = a.offer_id
          WHERE a.id = $1`,
        [agreementId],
      );
      if (!deal[0]) throw errors.notFound({ subject: 'investment_agreement' });

      const { rows: tranches } = await tx.query<TrancheRow>(
        `SELECT id, tranche_no, amount::text AS amount, status, confirmed_at
           FROM investments.investment_tranches
          WHERE agreement_id = $1
          ORDER BY tranche_no`,
        [agreementId],
      );
      const { rows: returns } = await tx.query<ReturnRow>(
        `SELECT r.id, r.tranche_id, r.amount::text AS amount, r.currency, r.occurred_on,
                r.reason, r.evidence_ref, r.recorded_by, r.created_at,
                r.cancelled_at, r.cancel_reason
           FROM investments.tranche_returns r
           JOIN investments.investment_tranches t ON t.id = r.tranche_id
          WHERE t.agreement_id = $1
          ORDER BY r.created_at`,
        [agreementId],
      );
      const { rows: accruals } = await tx.query<AccrualRow>(
        `SELECT id, trigger_tranche_id, base_amount::text AS base_amount,
                total_pct::text AS total_pct,
                investor_fee_amount::text AS investor_fee_amount,
                issuer_fee_amount::text AS issuer_fee_amount,
                accrued_at
           FROM billing.commission_accruals
          WHERE agreement_id = $1
          ORDER BY accrued_at`,
        [agreementId],
      );
      const { rows: adjustments } = await tx.query<AdjustmentRow>(
        `SELECT j.id, j.accrual_id, j.kind, j.party, j.amount::text AS amount, j.currency,
                j.reason, j.recorded_by, j.created_at
           FROM billing.commission_adjustments j
           JOIN billing.commission_accruals a ON a.id = j.accrual_id
          WHERE a.agreement_id = $1
          ORDER BY j.created_at`,
        [agreementId],
      );

      return {
        agreementId,
        projectId: deal[0].project_id,
        contractAmount: deal[0].contract_amount,
        currency: deal[0].currency as DealLedger['currency'],
        tranches: tranches.map((t) => {
          const own = returns.filter((r) => r.tranche_id === t.id);
          const returned = own
            .filter((r) => r.cancelled_at === null)
            .reduce((sum, r) => sum + minor(r.amount), 0n);
          return {
            id: t.id,
            trancheNo: t.tranche_no,
            amount: t.amount,
            status: t.status,
            confirmedAt: t.confirmed_at?.toISOString() ?? null,
            returnedAmount: fromMinor(returned),
            returns: own.map(mapReturn),
          };
        }),
        accruals: accruals.map((a) => ({
          id: a.id,
          trancheId: a.trigger_tranche_id,
          baseAmount: a.base_amount,
          totalPct: a.total_pct,
          investorFeeAmount: a.investor_fee_amount,
          issuerFeeAmount: a.issuer_fee_amount,
          accruedAt: a.accrued_at.toISOString(),
          adjustments: adjustments.filter((j) => j.accrual_id === a.id).map(mapAdjustment),
        })),
      };
    });
  }

  /**
   * Зафиксировать фактически состоявшийся возврат по траншу.
   *
   * Повторная отправка с тем же ключом возвращает прежнюю запись: человек
   * нажал дважды — это не два возврата. Размер и валюту проверяет БД: сумма
   * действующих записей не превышает подтверждённую сумму транша.
   */
  async recordReturn(
    ctx: RequestContext,
    input: RecordTrancheReturnRequest,
  ): Promise<TrancheReturn> {
    return this.db.transaction(ctx, async (tx) => {
      await assertCapability(tx, 'finance.tranche_return.record', 'зафиксировать возврат');

      const { rows: owner } = await tx.query<{ agreement_id: string }>(
        `SELECT agreement_id FROM investments.investment_tranches WHERE id = $1`,
        [input.trancheId],
      );
      if (!owner[0]) throw errors.notFound({ subject: 'investment_tranche' });
      await assertAssignedToAgreement(tx, owner[0].agreement_id);

      const { rows: existing } = await tx.query<ReturnRow>(
        `${RETURN_SELECT} WHERE r.idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (existing[0]) return mapReturn(existing[0]);

      const id = uuidv7();
      // Правила размера и валюты держит БД: она видит все записи разом и не
      // зависит от порядка запросов. Наружу её отказ идёт как ошибка ввода, а
      // не как сбой сервера — человек ошибся в сумме, а не сломал систему.
      await asValidationError(
        'amount',
        tx.query(
          `INSERT INTO investments.tranche_returns
           (id, tranche_id, amount, currency, occurred_on, reason, evidence_ref,
            recorded_by, idempotency_key)
         VALUES ($1, $2, $3::numeric, $4, $5::date, $6, $7, $8, $9)`,
          [
            id,
            input.trancheId,
            input.amount,
            input.currency,
            input.occurredOn,
            input.reason,
            input.evidenceRef ?? null,
            ctx.userId,
            input.idempotencyKey,
          ],
        ),
      );

      await this.audit.emit(tx, {
        verb: 'investments.tranche_return.recorded',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'investment_tranche',
        subjectId: input.trancheId,
        context: {
          amount: input.amount,
          currency: input.currency,
          occurredOn: input.occurredOn,
          reason: input.reason,
          hasEvidence: Boolean(input.evidenceRef),
        },
        traceId: ctx.traceId,
      });

      const { rows } = await tx.query<ReturnRow>(`${RETURN_SELECT} WHERE r.id = $1`, [id]);
      return mapReturn(rows[0]!);
    });
  }

  /** Аннулировать ошибочную запись: удалять её нельзя, история остаётся. */
  async cancelReturn(
    ctx: RequestContext,
    returnId: string,
    input: CancelTrancheReturnRequest,
  ): Promise<TrancheReturn> {
    return this.db.transaction(ctx, async (tx) => {
      await assertCapability(tx, 'finance.tranche_return.record', 'аннулировать запись о возврате');

      const { rows: owner } = await tx.query<{ agreement_id: string }>(
        `SELECT t.agreement_id
           FROM investments.tranche_returns r
           JOIN investments.investment_tranches t ON t.id = r.tranche_id
          WHERE r.id = $1`,
        [returnId],
      );
      if (!owner[0]) throw errors.notFound({ subject: 'tranche_return' });
      await assertAssignedToAgreement(tx, owner[0].agreement_id);

      const { rowCount } = await tx.query(
        `UPDATE investments.tranche_returns
            SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
          WHERE id = $1 AND cancelled_at IS NULL`,
        [returnId, ctx.userId, input.reason],
      );
      if (rowCount === 0) {
        throw errors.stateTransition('Запись о возврате уже аннулирована');
      }

      await this.audit.emit(tx, {
        verb: 'investments.tranche_return.cancelled',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'tranche_return',
        subjectId: returnId,
        context: { reason: input.reason },
        traceId: ctx.traceId,
      });

      const { rows } = await tx.query<ReturnRow>(`${RETURN_SELECT} WHERE r.id = $1`, [returnId]);
      return mapReturn(rows[0]!);
    });
  }

  /**
   * Зафиксировать корректировку вознаграждения.
   *
   * Уменьшение начисления и возврат уже уплаченного — РАЗНЫЕ полномочия и
   * разные записи: уменьшив начисление, нельзя объявить деньги возвращёнными.
   * Перечислений не происходит.
   */
  async recordAdjustment(
    ctx: RequestContext,
    input: RecordCommissionAdjustmentRequest,
  ): Promise<CommissionAdjustment> {
    const capability =
      input.kind === 'accrual_reduction'
        ? 'finance.commission.reduce'
        : 'finance.commission.refund_paid';
    const action =
      input.kind === 'accrual_reduction'
        ? 'уменьшить начисленную комиссию'
        : 'зафиксировать возврат уплаченной комиссии';

    return this.db.transaction(ctx, async (tx) => {
      await assertCapability(tx, capability, action);

      const { rows: owner } = await tx.query<{ agreement_id: string }>(
        `SELECT agreement_id FROM billing.commission_accruals WHERE id = $1`,
        [input.accrualId],
      );
      if (!owner[0]) throw errors.notFound({ subject: 'commission_accrual' });
      await assertAssignedToAgreement(tx, owner[0].agreement_id);

      const { rows: existing } = await tx.query<AdjustmentRow>(
        `${ADJUSTMENT_SELECT} WHERE j.idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (existing[0]) return mapAdjustment(existing[0]);

      const id = uuidv7();
      await asValidationError(
        'amount',
        tx.query(
          `INSERT INTO billing.commission_adjustments
           (id, accrual_id, kind, party, amount, currency, reason, recorded_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9)`,
          [
            id,
            input.accrualId,
            input.kind,
            input.party,
            input.amount,
            input.currency,
            input.reason,
            ctx.userId,
            input.idempotencyKey,
          ],
        ),
      );

      await this.audit.emit(tx, {
        verb: 'billing.commission.adjusted',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'commission_accrual',
        subjectId: input.accrualId,
        context: {
          kind: input.kind,
          party: input.party,
          amount: input.amount,
          currency: input.currency,
          reason: input.reason,
        },
        traceId: ctx.traceId,
      });

      const { rows } = await tx.query<AdjustmentRow>(`${ADJUSTMENT_SELECT} WHERE j.id = $1`, [id]);
      return mapAdjustment(rows[0]!);
    });
  }
}

const RETURN_SELECT = `
  SELECT r.id, r.tranche_id, r.amount::text AS amount, r.currency, r.occurred_on,
         r.reason, r.evidence_ref, r.recorded_by, r.created_at, r.cancelled_at, r.cancel_reason
    FROM investments.tranche_returns r
`;

const ADJUSTMENT_SELECT = `
  SELECT j.id, j.accrual_id, j.kind, j.party, j.amount::text AS amount, j.currency,
         j.reason, j.recorded_by, j.created_at
    FROM billing.commission_adjustments j
`;

/**
 * Отказ правила целостности — это ошибка ввода, а не сбой.
 *
 * Сумма сверх транша или сверх доли стороны приходит из БД кодом 23514.
 * Возвращать на это 500 значило бы прятать понятную причину за «обратитесь
 * в поддержку».
 */
async function asValidationError<T>(path: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '23514') {
      const message = (error as { message?: string }).message ?? 'значение недопустимо';
      throw errors.validation([{ path, message }]);
    }
    throw error;
  }
}

function actorRole(ctx: RequestContext): string {
  return ctx.roles?.includes('admin') ? 'admin' : 'expert';
}

interface DealSummaryRow {
  id: string;
  project_id: string;
  project_title: string;
  status: string;
  contract_amount: string;
  currency: string;
  confirmed_tranches: number;
  created_at: Date;
}

interface TrancheRow {
  id: string;
  tranche_no: number;
  amount: string;
  status: string;
  confirmed_at: Date | null;
}

interface ReturnRow {
  id: string;
  tranche_id: string;
  amount: string;
  currency: string;
  occurred_on: Date;
  reason: string;
  evidence_ref: string | null;
  recorded_by: string;
  created_at: Date;
  cancelled_at: Date | null;
  cancel_reason: string | null;
}

interface AccrualRow {
  id: string;
  trigger_tranche_id: string;
  base_amount: string;
  total_pct: string;
  investor_fee_amount: string;
  issuer_fee_amount: string;
  accrued_at: Date;
}

interface AdjustmentRow {
  id: string;
  accrual_id: string;
  kind: CommissionAdjustment['kind'];
  party: CommissionAdjustment['party'];
  amount: string;
  currency: string;
  reason: string;
  recorded_by: string;
  created_at: Date;
}

function mapReturn(row: ReturnRow): TrancheReturn {
  return {
    id: row.id,
    trancheId: row.tranche_id,
    amount: row.amount,
    currency: row.currency as TrancheReturn['currency'],
    occurredOn:
      row.occurred_on instanceof Date
        ? row.occurred_on.toISOString().slice(0, 10)
        : String(row.occurred_on),
    reason: row.reason,
    evidenceRef: row.evidence_ref,
    recordedBy: row.recorded_by,
    createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    cancelReason: row.cancel_reason,
  };
}

function mapAdjustment(row: AdjustmentRow): CommissionAdjustment {
  return {
    id: row.id,
    accrualId: row.accrual_id,
    kind: row.kind,
    party: row.party,
    amount: row.amount,
    currency: row.currency as CommissionAdjustment['currency'],
    reason: row.reason,
    recordedBy: row.recorded_by,
    createdAt: row.created_at.toISOString(),
  };
}

/** Копейки целым: деньги не проходят через плавающую точку. */
function minor(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

function fromMinor(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
