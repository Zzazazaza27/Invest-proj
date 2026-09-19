import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type GrantCapabilityRequest,
  type RevokeCapabilityRequest,
  type StaffCapability,
  type StaffCapabilityGrant,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Функциональные полномочия сотрудников (M097).
 *
 * ЕДИНОЕ место проверки — `assertCapability`. Интерфейс может прятать
 * недоступные действия, но решает сервер: скрытая кнопка защитой не является.
 *
 * Полномочие отвечает на вопрос «что сотрудник вправе делать вообще».
 * Отдельный вопрос — «с какими объектами»: его решает назначение на проект
 * (`experts.is_assigned_reviewer`). Оба нужны одновременно, поэтому проверки
 * нельзя объединить в одну: право фиксировать возврат не открывает все
 * сделки платформы, а назначение на проект не даёт права трогать комиссию.
 *
 * Пока полноценного управления правами нет, все полномочия держит
 * администратор (решение владельца 2026-09-19). Экспертам ничего не выдаётся
 * автоматически — ни по роли, ни по назначению.
 */
@Injectable()
export class CapabilitiesService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  /** Каталог реализованных полномочий по разделам платформы. */
  async catalog(ctx: RequestContext): Promise<StaffCapability[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<CapabilityRow>(
        `SELECT code, section, action, title, description, is_implemented, requires_assignment
           FROM identity.staff_capabilities
          ORDER BY section, sort_order, code`,
      );
      return rows.map(mapCapability);
    });
  }

  async grantsOf(ctx: RequestContext, userId: string): Promise<StaffCapabilityGrant[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<GrantRow>(
        `SELECT id, user_id, capability, reason, granted_at, revoked_at
           FROM identity.staff_capability_grants
          WHERE user_id = $1
          ORDER BY granted_at DESC`,
        [userId],
      );
      return rows.map(mapGrant);
    });
  }

  /** Полномочия текущего пользователя — чтобы кабинет знал, что показывать. */
  async mine(ctx: RequestContext): Promise<string[]> {
    if (!ctx.userId) return [];
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ capability: string }>(
        `SELECT capability FROM identity.staff_capability_grants
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY capability`,
        [ctx.userId],
      );
      return rows.map((r) => r.capability);
    });
  }

  async grant(ctx: RequestContext, input: GrantCapabilityRequest): Promise<StaffCapabilityGrant> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows: known } = await tx.query<{ is_implemented: boolean }>(
        `SELECT is_implemented FROM identity.staff_capabilities WHERE code = $1`,
        [input.capability],
      );
      if (!known[0]) {
        throw errors.validation([
          { path: 'capability', message: 'такого полномочия нет в каталоге' },
        ]);
      }
      if (!known[0].is_implemented) {
        throw errors.validation([
          {
            path: 'capability',
            message: 'полномочие не реализовано: выдавать его — обещать несуществующее действие',
          },
        ]);
      }

      const id = uuidv7();
      const { rows } = await tx.query<GrantRow>(
        `INSERT INTO identity.staff_capability_grants (id, user_id, capability, reason, granted_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, capability) WHERE revoked_at IS NULL DO NOTHING
         RETURNING id, user_id, capability, reason, granted_at, revoked_at`,
        [id, input.userId, input.capability, input.reason, ctx.userId],
      );
      if (!rows[0]) {
        // Повторная выдача действующего полномочия — не ошибка и не дубликат.
        const { rows: existing } = await tx.query<GrantRow>(
          `SELECT id, user_id, capability, reason, granted_at, revoked_at
             FROM identity.staff_capability_grants
            WHERE user_id = $1 AND capability = $2 AND revoked_at IS NULL`,
          [input.userId, input.capability],
        );
        return mapGrant(existing[0]!);
      }

      await this.audit.emit(tx, {
        verb: 'identity.capability.granted',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'user',
        subjectId: input.userId,
        context: { capability: input.capability, reason: input.reason },
        traceId: ctx.traceId,
      });
      return mapGrant(rows[0]);
    });
  }

  /** Отзыв закрывает доступ на следующем запросе: проверка идёт по факту. */
  async revoke(ctx: RequestContext, input: RevokeCapabilityRequest): Promise<void> {
    return this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE identity.staff_capability_grants
            SET revoked_at = now(), revoked_by = $3, revoke_reason = $4
          WHERE user_id = $1 AND capability = $2 AND revoked_at IS NULL`,
        [input.userId, input.capability, ctx.userId, input.reason],
      );
      if (rowCount === 0) throw errors.notFound({ subject: 'staff_capability_grant' });
      await this.audit.emit(tx, {
        verb: 'identity.capability.revoked',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'user',
        subjectId: input.userId,
        context: { capability: input.capability, reason: input.reason },
        traceId: ctx.traceId,
      });
    });
  }
}

/**
 * Проверка полномочия в уже открытой транзакции.
 *
 * Спрашивает ту же функцию БД, что и RLS (`app.has_capability`): один
 * источник истины вместо двух расходящихся правил. Сервис проверяет ПЕРВЫМ,
 * чтобы отказ был понятным, а RLS остаётся последней защитой.
 */
export async function assertCapability(tx: Tx, code: string, action: string): Promise<void> {
  const { rows } = await tx.query<{ allowed: boolean }>(
    `SELECT app.has_capability($1) AS allowed`,
    [code],
  );
  if (!rows[0]?.allowed) {
    throw errors.forbidden(
      { missingCapability: code, action },
      `Недостаточно полномочий: «${action}» требует «${code}»`,
    );
  }
}

/**
 * Проверка ОБЛАСТИ РАБОТЫ: сотрудник назначен на проект этой сделки.
 *
 * Администратор работает со всеми сделками. Остальным полномочие само по
 * себе сделок не открывает — иначе право фиксировать возврат означало бы
 * доступ ко всей платформе.
 */
export async function assertAssignedToAgreement(tx: Tx, agreementId: string): Promise<void> {
  const { rows } = await tx.query<{ allowed: boolean }>(
    `SELECT app.has_role('admin')
            OR experts.is_assigned_reviewer(o.project_id, app.current_user_id()) AS allowed
       FROM investments.investment_agreements a
       JOIN investments.investment_offers o ON o.id = a.offer_id
      WHERE a.id = $1`,
    [agreementId],
  );
  if (!rows[0]) throw errors.notFound({ subject: 'investment_agreement' });
  if (!rows[0].allowed) {
    throw errors.forbidden(
      { agreementId },
      'Сделка вне вашей области работы: нужно назначение на проект этой сделки',
    );
  }
}

interface CapabilityRow {
  code: string;
  section: string;
  action: StaffCapability['action'];
  title: string;
  description: string;
  is_implemented: boolean;
  requires_assignment: boolean;
}

interface GrantRow {
  id: string;
  user_id: string;
  capability: string;
  reason: string;
  granted_at: Date;
  revoked_at: Date | null;
}

function mapCapability(row: CapabilityRow): StaffCapability {
  return {
    code: row.code,
    section: row.section,
    action: row.action,
    title: row.title,
    description: row.description,
    isImplemented: row.is_implemented,
    requiresAssignment: row.requires_assignment,
  };
}

function mapGrant(row: GrantRow): StaffCapabilityGrant {
  return {
    id: row.id,
    userId: row.user_id,
    capability: row.capability,
    reason: row.reason,
    grantedAt: row.granted_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}
