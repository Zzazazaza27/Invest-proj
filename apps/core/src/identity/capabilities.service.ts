import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type AssignDealSupportRequest,
  type DealSupportAssignment,
  type DealSupportAssignmentRow,
  type GrantCapabilityRequest,
  type RevokeDealSupportRequest,
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

  /**
   * Действующие назначения на сопровождение сделок.
   *
   * Без фильтра — все: назначений на платформе единицы, а администратору
   * нужна картина целиком, чтобы снять лишнее. Фильтры сужают до одного
   * проекта или одного человека.
   */
  async listDealSupport(
    ctx: RequestContext,
    filter: { projectId?: string; userId?: string } = {},
  ): Promise<DealSupportAssignmentRow[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<DealSupportRow>(
        `SELECT a.id, a.project_id, a.expert_id, a.status, a.created_at,
                p.title AS project_title,
                COALESCE(u.display_name, '—') AS user_name
           FROM experts.expert_assignments a
           JOIN lab.projects p ON p.id = a.project_id
           LEFT JOIN identity.users u ON u.id = a.expert_id
          WHERE a.purpose = 'deal_support'
            AND a.status IN ('assigned', 'accepted')
            AND a.access_revoked_at IS NULL
            AND ($1::uuid IS NULL OR a.project_id = $1)
            AND ($2::uuid IS NULL OR a.expert_id = $2)
          ORDER BY a.created_at DESC
          LIMIT 200`,
        [filter.projectId ?? null, filter.userId ?? null],
      );
      return rows.map((row) => ({
        ...mapAssignment(row),
        projectTitle: row.project_title,
        userName: row.user_name,
      }));
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

  /**
   * Назначить сотрудника на сопровождение сделок проекта (M099).
   *
   * Это ОБЛАСТЬ РАБОТЫ, а не права: без отдельно выданного финансового
   * полномочия назначение ничего не позволяет. И наоборот — оно НЕ делает
   * сотрудника рецензентом: анкета, внутренние оценки и материалы проекта
   * им не открываются, для этого нужна другая цель назначения.
   */
  async assignDealSupport(
    ctx: RequestContext,
    input: AssignDealSupportRequest,
  ): Promise<DealSupportAssignment> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows: project } = await tx.query<{ id: string }>(
        `SELECT id FROM lab.projects WHERE id = $1`,
        [input.projectId],
      );
      if (!project[0]) throw errors.notFound({ subject: 'project' });

      // Строка в каталоге экспертов нужна ссылочной целостностью; профиль
      // рецензента она не создаёт и в публичный список не выводит.
      await tx.query(`INSERT INTO experts.experts (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
        input.userId,
      ]);

      const id = uuidv7();
      const { rows } = await tx.query<AssignmentRow>(
        `INSERT INTO experts.expert_assignments
           (id, project_id, expert_id, assigned_reason, purpose, status, due_at, assigned_by)
         VALUES ($1, $2, $3, 'manual', 'deal_support', 'accepted',
                 now() + interval '365 days', $4)
         ON CONFLICT (project_id, expert_id, purpose)
           WHERE status IN ('assigned','accepted') DO NOTHING
         RETURNING id, project_id, expert_id, status, created_at`,
        [id, input.projectId, input.userId, ctx.userId],
      );
      if (!rows[0]) {
        const { rows: existing } = await tx.query<AssignmentRow>(
          `SELECT id, project_id, expert_id, status, created_at
             FROM experts.expert_assignments
            WHERE project_id = $1 AND expert_id = $2 AND purpose = 'deal_support'
              AND status IN ('assigned','accepted')`,
          [input.projectId, input.userId],
        );
        return mapAssignment(existing[0]!);
      }

      await this.audit.emit(tx, {
        verb: 'experts.deal_support.assigned',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'project',
        subjectId: input.projectId,
        context: { userId: input.userId, reason: input.reason },
        traceId: ctx.traceId,
      });
      return mapAssignment(rows[0]);
    });
  }

  /**
   * Снятие области работы закрывает денежные действия по этим сделкам.
   *
   * Записывается тем же способом, что и прекращение доступа рецензента
   * (M120): отдельным полем с временем, автором и основанием. Состояние
   * работы закрывается здесь заодно — сопровождение, в отличие от рецензии, не
   * оставляет после себя сданного документа, и «выполненным» ему становиться
   * не от чего.
   */
  async revokeDealSupport(ctx: RequestContext, input: RevokeDealSupportRequest): Promise<void> {
    return this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE experts.expert_assignments
            SET status = 'expired',
                access_revoked_at = now(),
                access_revoked_by = $3,
                access_revoke_reason = $4
          WHERE project_id = $1 AND expert_id = $2 AND purpose = 'deal_support'
            AND status IN ('assigned','accepted')
            AND access_revoked_at IS NULL`,
        [input.projectId, input.userId, ctx.userId, input.reason],
      );
      if (rowCount === 0) throw errors.notFound({ subject: 'deal_support_assignment' });
      await this.audit.emit(tx, {
        verb: 'experts.deal_support.assigned',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'project',
        subjectId: input.projectId,
        context: { userId: input.userId, revoked: true, reason: input.reason },
        traceId: ctx.traceId,
      });
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
 * Проверка ОБЛАСТИ РАБОТЫ: сотрудник сопровождает сделки этого проекта.
 *
 * Область — назначение с целью `deal_support` (M099), а НЕ рецензентское:
 * сопровождение сделки не делает человека оценщиком проекта, а рецензент не
 * получает доступа к деньгам. Администратор работает со всеми сделками.
 */
export async function assertAssignedToAgreement(tx: Tx, agreementId: string): Promise<void> {
  const { rows } = await tx.query<{ allowed: boolean }>(
    `SELECT app.has_role('admin')
            OR experts.is_assigned_deal_supporter(o.project_id, app.current_user_id()) AS allowed
       FROM investments.investment_agreements a
       JOIN investments.investment_offers o ON o.id = a.offer_id
      WHERE a.id = $1`,
    [agreementId],
  );
  if (!rows[0]) throw errors.notFound({ subject: 'investment_agreement' });
  if (!rows[0].allowed) {
    throw errors.forbidden(
      { agreementId },
      'Сделка вне вашей области работы: нужно назначение на сопровождение сделок этого проекта',
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

interface AssignmentRow {
  id: string;
  project_id: string;
  expert_id: string;
  status: string;
  created_at: Date;
}

interface DealSupportRow extends AssignmentRow {
  project_title: string;
  user_name: string;
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

function mapAssignment(row: AssignmentRow): DealSupportAssignment {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.expert_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
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
