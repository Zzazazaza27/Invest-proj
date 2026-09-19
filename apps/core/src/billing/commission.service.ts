import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type ActivateFeeOffsetRuleRequest,
  type FeeOffsetRule,
  type FeeTerms,
  type PublishFeeTermsRequest,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext } from '../db/unit-of-work';

/**
 * Условия вознаграждения платформы и правило зачёта услуг (5.9.3; M096).
 *
 * Здесь настраивается ТО, ПО ЧЕМУ считает база: общая ставка и её
 * распределение между сторонами. Сам расчёт живёт в команде
 * `billing.confirm_tranche` и начисляет с каждого подтверждённого транша —
 * второго места, где считаются те же деньги, нет намеренно.
 *
 * Зачёт услуг: версии правила заводятся, но включить зачёт нельзя — правило
 * владельцем не утверждено, и запись зачёта запрещена триггером в базе.
 * Настройка существует, чтобы решение было видно, а не чтобы его подменить.
 */
@Injectable()
export class CommissionService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  async listTerms(ctx: RequestContext): Promise<FeeTerms[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<TermsRow>(`${TERMS_SELECT} ORDER BY code, version DESC`);
      return rows.map(mapTerms);
    });
  }

  /**
   * Новая версия условий. Действующая не переписывается — она закрывается тем
   * же моментом, с которого начинает действовать новая: в истории не должно
   * быть ни разрыва, ни двух ставок одновременно.
   */
  async publishTerms(ctx: RequestContext, input: PublishFeeTermsRequest): Promise<FeeTerms> {
    return this.db.transaction(ctx, async (tx) => {
      const validFrom = input.validFrom ? new Date(input.validFrom) : new Date();
      if (validFrom.getTime() < Date.now() - 60_000) {
        throw errors.validation([
          { path: 'validFrom', message: 'условия не публикуются задним числом' },
        ]);
      }

      const { rows: next } = await tx.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
           FROM billing.fee_schedules WHERE code = $1`,
        [input.code],
      );
      const version = Number(next[0]?.next_version ?? 1);

      await tx.query(
        `UPDATE billing.fee_schedules
            SET valid_to = $2
          WHERE code = $1 AND valid_to IS NULL AND valid_from < $2`,
        [input.code, validFrom.toISOString()],
      );

      const id = uuidv7();
      await tx.query(
        `INSERT INTO billing.fee_schedules
           (id, code, version, total_pct, investor_fee_pct, issuer_fee_pct,
            rules_version, reason, valid_from)
         VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7, $8, $9)`,
        [
          id,
          input.code,
          version,
          input.totalPct,
          input.investorFeePct,
          input.issuerFeePct,
          input.rulesVersion,
          input.reason,
          validFrom.toISOString(),
        ],
      );

      await this.audit.emit(tx, {
        verb: 'billing.fee_schedule.published',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'fee_schedule',
        subjectId: id,
        context: {
          code: input.code,
          version,
          totalPct: input.totalPct,
          investorFeePct: input.investorFeePct,
          issuerFeePct: input.issuerFeePct,
          reason: input.reason,
        },
        traceId: ctx.traceId,
      });

      const { rows } = await tx.query<TermsRow>(`${TERMS_SELECT} WHERE f.id = $1`, [id]);
      return mapTerms(rows[0]!);
    });
  }

  async listOffsetRules(ctx: RequestContext): Promise<FeeOffsetRule[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<OffsetRuleRow>(
        `SELECT id, version, is_enabled, is_active, reason, created_at
           FROM billing.fee_offset_rules ORDER BY version DESC`,
      );
      return rows.map(mapOffsetRule);
    });
  }

  /**
   * Новая версия правила зачёта.
   *
   * Включение отклоняется: правило зачёта (получатель, полное или частичное
   * покрытие, распределение по траншам, остаток, возвраты) владельцем не
   * утверждено. Включить настройку, за которой нет расчёта, значило бы
   * пообещать зачёт и не сделать его — отказ честнее.
   */
  async activateOffsetRule(
    ctx: RequestContext,
    input: ActivateFeeOffsetRuleRequest,
  ): Promise<FeeOffsetRule> {
    if (input.isEnabled) {
      throw errors.validation([
        {
          path: 'isEnabled',
          message:
            'зачёт услуг нельзя включить: правило расчёта не утверждено владельцем ' +
            '(получатель, полное или частичное покрытие, распределение по траншам, ' +
            'остаток, возвраты)',
        },
      ]);
    }
    return this.db.transaction(ctx, async (tx) => {
      await tx.query(`UPDATE billing.fee_offset_rules SET is_active = false WHERE is_active`);
      const id = uuidv7();
      const { rows } = await tx.query<OffsetRuleRow>(
        `INSERT INTO billing.fee_offset_rules (id, version, is_enabled, is_active, reason, created_by)
         VALUES ($1,
                 (SELECT COALESCE(MAX(version), 0) + 1 FROM billing.fee_offset_rules),
                 false, true, $2, $3)
         RETURNING id, version, is_enabled, is_active, reason, created_at`,
        [id, input.reason, ctx.userId],
      );
      await this.audit.emit(tx, {
        verb: 'billing.fee_offset_rule.activated',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'fee_offset_rule',
        subjectId: id,
        context: { version: rows[0]!.version, isEnabled: false, reason: input.reason },
        traceId: ctx.traceId,
      });
      return mapOffsetRule(rows[0]!);
    });
  }
}

const TERMS_SELECT = `
  SELECT f.id, f.code, f.version,
         f.total_pct::text AS total_pct,
         f.investor_fee_pct::text AS investor_fee_pct,
         f.issuer_fee_pct::text AS issuer_fee_pct,
         f.rules_version, f.reason, f.valid_from, f.valid_to
    FROM billing.fee_schedules f
`;

interface TermsRow {
  id: string;
  code: string;
  version: number;
  total_pct: string;
  investor_fee_pct: string;
  issuer_fee_pct: string;
  rules_version: string;
  reason: string;
  valid_from: Date;
  valid_to: Date | null;
}

interface OffsetRuleRow {
  id: string;
  version: number;
  is_enabled: boolean;
  is_active: boolean;
  reason: string;
  created_at: Date;
}

function mapTerms(row: TermsRow): FeeTerms {
  const now = Date.now();
  const from = row.valid_from.getTime();
  const to = row.valid_to?.getTime() ?? null;
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    totalPct: row.total_pct,
    investorFeePct: row.investor_fee_pct,
    issuerFeePct: row.issuer_fee_pct,
    rulesVersion: row.rules_version,
    reason: row.reason,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to?.toISOString() ?? null,
    isActive: from <= now && (to === null || to > now),
    isLocked: from <= now,
  };
}

function mapOffsetRule(row: OffsetRuleRow): FeeOffsetRule {
  return {
    id: row.id,
    version: row.version,
    isEnabled: row.is_enabled,
    isActive: row.is_active,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  };
}
