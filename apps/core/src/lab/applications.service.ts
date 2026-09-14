import { Injectable } from '@nestjs/common';
import {
  ApplicationPolicySchema,
  uuidv7,
  type ApplicationLimits,
  type ApplicationPolicy,
  type ApplicationPolicyVersion,
  type ApplicationSubmissionCheck,
  type ActivateApplicationPolicyRequest,
  type CreateApplicationRequest,
  type InvestmentApplication,
  type UpdateApplicationRequest,
  toMinorUnits,
  fromMinorUnits,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Инвестиционные заявки основателя (план 0.2 §2.2–§2.4, §2.8).
 *
 * Три правила, ради которых сервис существует отдельно от проектов:
 *
 *  1. ЧЕРНОВИК СВОБОДЕН. Создать заявку можно без суммы и без уточнения
 *     направления; `PATCH` никогда не отвергает сохранение из-за пустого
 *     обязательного поля. Обязательность — условие подачи, и она отдаётся
 *     заранее как `submission.missing`, чтобы мастер показывал, чего не
 *     хватает, а не узнавал об этом отказом.
 *
 *  2. ОГРАНИЧЕНИЯ — ПОЛИТИКА, НЕ ТАРИФ. Сколько заявок и какую сумму может
 *     просить основатель, задаёт активная версия `lab.application_policies`;
 *     подписка и тариф в этом не участвуют (решение владельца, §0а). Остаток
 *     отдаётся до создания, чтобы отказ не был первым известием о лимите.
 *
 *  3. ПРОЕКТ — ПРОИЗВОДНЫЙ КЕШ. Колонки stage, investment_ask, required_plan_id
 *     проекта пересчитываются из ОТКРЫТЫХ заявок одной функцией
 *     (`recomputeProjectProjection`) после подачи и архивации. Источник истины
 *     по истории — заявки и их снимки; проекцию никто не редактирует руками.
 *
 * Границу «своё/чужое» держит RLS (M071): SELECT ниже не фильтрует по
 * пользователю и всё равно возвращает только доступное.
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  async list(
    ctx: RequestContext,
    projectId: string,
  ): Promise<{ items: InvestmentApplication[]; limits: ApplicationLimits }> {
    return this.db.readOnly(ctx, async (tx) => {
      await assertProjectVisible(tx, projectId);
      const { rows } = await tx.query<ApplicationRow>(
        `SELECT ${APPLICATION_COLUMNS} FROM lab.investment_applications
          WHERE project_id = $1
          ORDER BY created_at DESC`,
        [projectId],
      );
      const limits = await this.limits(tx, ctx, projectId);
      return { items: rows.map(mapApplication), limits };
    });
  }

  async create(
    ctx: RequestContext,
    projectId: string,
    input: CreateApplicationRequest,
  ): Promise<InvestmentApplication> {
    return this.db.transaction(ctx, async (tx) => {
      // Тот же лок, что у материалов и подачи: два параллельных создания не
      // должны обойти лимит, посчитав один и тот же остаток.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `project-write:${projectId}`,
      ]);
      const project = await tx.query<{ stage: InvestmentApplication['stage'] }>(
        `SELECT stage FROM lab.projects WHERE id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      if (!project.rows[0]) throw errors.notFound({ subject: 'project' });

      const limits = await this.limits(tx, ctx, projectId);
      if (limits.applications.remaining <= 0) {
        throw errors.limitExceeded(
          `Достигнут предел заявок на проект: ${limits.applications.used} из ${limits.applications.limit}. ` +
            'Освободить место можно, архивировав одну из заявок',
        );
      }
      if (limits.account && limits.account.remaining <= 0) {
        throw errors.limitExceeded(
          `Достигнут предел заявок на аккаунт: ${limits.account.used} из ${limits.account.limit}`,
        );
      }

      const id = uuidv7();
      const { rows } = await tx.query<ApplicationRow>(
        `INSERT INTO lab.investment_applications
           (id, project_id, title, stage, business_type, funding_scope, funding_scope_note,
            investment_ask, schema_version, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10)
         RETURNING ${APPLICATION_COLUMNS}`,
        [
          id,
          projectId,
          input.title ?? null,
          input.stage ?? project.rows[0].stage,
          input.businessType ?? null,
          input.fundingScope ?? 'project',
          input.fundingScopeNote ?? null,
          input.investmentAsk ?? null,
          ACTIVE_SCHEMA_VERSION,
          ctx.userId,
        ],
      );

      await this.audit.emit(tx, {
        verb: 'lab.application.created',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'application',
        subjectId: id,
        context: { projectId, stage: input.stage ?? project.rows[0].stage },
        traceId: ctx.traceId,
      });
      return mapApplication(rows[0]!);
    });
  }

  async get(
    ctx: RequestContext,
    applicationId: string,
  ): Promise<{ application: InvestmentApplication; submission: ApplicationSubmissionCheck }> {
    return this.db.readOnly(ctx, async (tx) => {
      const application = await this.load(tx, applicationId);
      const policy = await loadActivePolicy(tx);
      return { application, submission: checkSubmission(application, policy.config) };
    });
  }

  /**
   * Частичное сохранение. `null` очищает поле, отсутствие — не трогает;
   * `answers` и `evidence` сливаются по ключам. Отказ здесь только один —
   * заявка в архиве: черновик правится всегда, даже без суммы.
   */
  async update(
    ctx: RequestContext,
    applicationId: string,
    input: UpdateApplicationRequest,
  ): Promise<{ application: InvestmentApplication; submission: ApplicationSubmissionCheck }> {
    const fields = Object.keys(input);
    if (fields.length === 0) {
      throw errors.validation([{ path: '(корень)', message: 'нет полей для изменения' }]);
    }
    return this.db.transaction(ctx, async (tx) => {
      const current = await this.load(tx, applicationId);
      if (current.status === 'archived') {
        throw errors.stateTransition('Заявка в архиве: её нельзя изменить');
      }

      const sets: string[] = [];
      const params: unknown[] = [applicationId];
      const set = (column: string, value: unknown, cast = '') => {
        params.push(value);
        sets.push(`${column} = $${params.length}${cast}`);
      };
      if (input.title !== undefined) set('title', input.title);
      if (input.stage !== undefined) set('stage', input.stage);
      if (input.businessType !== undefined) set('business_type', input.businessType);
      if (input.fundingScope !== undefined) set('funding_scope', input.fundingScope);
      if (input.fundingScopeNote !== undefined) set('funding_scope_note', input.fundingScopeNote);
      if (input.investmentAsk !== undefined)
        set('investment_ask', input.investmentAsk, '::numeric');
      if (input.answers !== undefined) {
        params.push(JSON.stringify(input.answers));
        sets.push(`answers_jsonb = answers_jsonb || $${params.length}::jsonb`);
      }
      if (input.evidence !== undefined) {
        params.push(JSON.stringify(input.evidence));
        sets.push(`evidence_jsonb = evidence_jsonb || $${params.length}::jsonb`);
      }

      const { rows } = await tx.query<ApplicationRow>(
        `UPDATE lab.investment_applications SET ${sets.join(', ')}
          WHERE id = $1
          RETURNING ${APPLICATION_COLUMNS}`,
        params,
      );
      const row = rows[0];
      if (!row) throw errors.notFound({ subject: 'application' });

      await this.audit.emit(tx, {
        verb: 'lab.application.updated',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'application',
        subjectId: applicationId,
        context: { fields },
        traceId: ctx.traceId,
      });

      const application = mapApplication(row);
      const policy = await loadActivePolicy(tx);
      return { application, submission: checkSubmission(application, policy.config) };
    });
  }

  /**
   * Архив — терминальный статус: обратно не открывается, инвестор архивную не
   * видит, слот в лимите освобождается. Снимки остаются.
   */
  async archive(ctx: RequestContext, applicationId: string): Promise<InvestmentApplication> {
    return this.db.transaction(ctx, async (tx) => {
      const current = await this.load(tx, applicationId);
      if (current.status === 'archived') return current;
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `project-write:${current.projectId}`,
      ]);
      const { rows } = await tx.query<ApplicationRow>(
        `UPDATE lab.investment_applications
            SET status = 'archived', archived_at = now()
          WHERE id = $1
          RETURNING ${APPLICATION_COLUMNS}`,
        [applicationId],
      );
      await recomputeProjectProjection(tx, current.projectId);
      await this.audit.emit(tx, {
        verb: 'lab.application.archived',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'application',
        subjectId: applicationId,
        context: { projectId: current.projectId, wasOpen: current.status === 'submitted' },
        traceId: ctx.traceId,
      });
      return mapApplication(rows[0]!);
    });
  }

  // ------------------------------------------------------- политика (админ)

  async listPolicies(ctx: RequestContext): Promise<ApplicationPolicyVersion[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<PolicyRow>(
        `SELECT id, version, config_jsonb, is_active, created_by, created_at, reason
           FROM lab.application_policies ORDER BY version DESC LIMIT 100`,
      );
      return rows.map(mapPolicy);
    });
  }

  /**
   * Новая версия политики активируется одной транзакцией: прежняя гаснет,
   * новая получает следующий номер. Частичный уникальный индекс в БД не даст
   * двум версиям быть активными, даже если код здесь ошибётся.
   */
  async activatePolicy(
    ctx: RequestContext,
    input: ActivateApplicationPolicyRequest,
  ): Promise<ApplicationPolicyVersion> {
    return this.db.transaction(ctx, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        'application-policy:activate',
      ]);
      await tx.query(`UPDATE lab.application_policies SET is_active = false WHERE is_active`);
      const { rows } = await tx.query<PolicyRow>(
        `INSERT INTO lab.application_policies
           (id, version, config_jsonb, is_active, created_by, reason)
         VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM lab.application_policies),
                 $2::jsonb, true, $3, $4)
         RETURNING id, version, config_jsonb, is_active, created_by, created_at, reason`,
        [uuidv7(), JSON.stringify(input.config), ctx.userId, input.reason],
      );
      const row = rows[0]!;
      await this.audit.emit(tx, {
        verb: 'lab.application_policy.activated',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'application_policy',
        subjectId: row.id,
        context: { version: row.version, reason: input.reason, config: input.config },
        traceId: ctx.traceId,
      });
      return mapPolicy(row);
    });
  }

  // ------------------------------------------------------------------ helpers

  private async load(tx: Tx, applicationId: string): Promise<InvestmentApplication> {
    const { rows } = await tx.query<ApplicationRow>(
      `SELECT ${APPLICATION_COLUMNS} FROM lab.investment_applications WHERE id = $1`,
      [applicationId],
    );
    const row = rows[0];
    // RLS уже отфильтровала чужое; отсутствие и отсутствие прав — один ответ.
    if (!row) throw errors.notFound({ subject: 'application' });
    return mapApplication(row);
  }

  private async limits(tx: Tx, ctx: RequestContext, projectId: string): Promise<ApplicationLimits> {
    const policy = await loadActivePolicy(tx);
    const { rows: byStatus } = await tx.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM lab.investment_applications
        WHERE project_id = $1 GROUP BY status`,
      [projectId],
    );
    const project = tally(byStatus);

    let account: Counts | null = null;
    if (policy.config.maxApplicationsPerAccount !== null && ctx.userId) {
      const { rows } = await tx.query<{ status: string; count: string }>(
        `SELECT a.status, count(*)::text AS count
           FROM lab.investment_applications a
           JOIN lab.founders_projects fp ON fp.project_id = a.project_id
          WHERE fp.user_id = $1 AND fp.role = 'owner'
          GROUP BY a.status`,
        [ctx.userId],
      );
      account = tally(rows);
    }

    const { rows: totals } = await tx.query<{ total: string | null }>(
      `SELECT sum(investment_ask)::text AS total FROM lab.investment_applications
        WHERE project_id = $1 AND status = 'submitted'`,
      [projectId],
    );
    return computeLimits(policy.version, policy.config, {
      project,
      account,
      openAskTotal: totals[0]?.total ?? '0.00',
    });
  }
}

/**
 * Версия схемы вопросов, по которой создаются новые черновики. До этапа 3 —
 * схема 0: старая форма из девяти полей, ответы свободны.
 */
export const ACTIVE_SCHEMA_VERSION = 0;

export interface Counts {
  draft: number;
  submitted: number;
  archived: number;
}

function tally(rows: { status: string; count: string }[]): Counts {
  const counts: Counts = { draft: 0, submitted: 0, archived: 0 };
  for (const row of rows) {
    if (row.status in counts) counts[row.status as keyof Counts] = Number(row.count);
  }
  return counts;
}

/**
 * Остаток по политике. Чистая функция: правила подсчёта (план 0.2 §2.8) —
 * черновик по флагу, поданная всегда, архив никогда — проверяются тестами
 * без БД.
 */
export function computeLimits(
  policyVersion: number,
  policy: ApplicationPolicy,
  usage: { project: Counts; account: Counts | null; openAskTotal: string },
): ApplicationLimits {
  const used = (c: Counts) => c.submitted + (policy.count.draft ? c.draft : 0);
  const projectUsed = used(usage.project);
  const accountUsed =
    policy.maxApplicationsPerAccount !== null && usage.account ? used(usage.account) : null;
  return {
    policyVersion,
    applications: {
      limit: policy.maxApplicationsPerProject,
      used: projectUsed,
      remaining: Math.max(0, policy.maxApplicationsPerProject - projectUsed),
    },
    account:
      accountUsed === null || policy.maxApplicationsPerAccount === null
        ? null
        : {
            limit: policy.maxApplicationsPerAccount,
            used: accountUsed,
            remaining: Math.max(0, policy.maxApplicationsPerAccount - accountUsed),
          },
    maxAskPerApplication: policy.maxAskPerApplication,
    maxOpenAskTotalPerProject: policy.maxOpenAskTotalPerProject,
    openAskTotal: normalizeAmount(usage.openAskTotal),
  };
}

function normalizeAmount(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

/**
 * Что мешает подаче. Только core-поля и потолок суммы; обязательные вопросы
 * схемы добавляются в этапе 3 тем же списком `missing`.
 */
export function checkSubmission(
  application: Pick<
    InvestmentApplication,
    'status' | 'investmentAsk' | 'fundingScope' | 'fundingScopeNote'
  >,
  policy: ApplicationPolicy,
): ApplicationSubmissionCheck {
  const missing: ApplicationSubmissionCheck['missing'] = [];
  if (application.status === 'archived') {
    missing.push({ path: 'status', message: 'заявка в архиве' });
  }
  if (application.investmentAsk === null) {
    missing.push({ path: 'investmentAsk', message: 'укажите сумму запроса' });
  } else if (
    policy.maxAskPerApplication !== null &&
    toMinorUnits(application.investmentAsk) > toMinorUnits(policy.maxAskPerApplication)
  ) {
    missing.push({
      path: 'investmentAsk',
      message: `сумма заявки не может превышать ${policy.maxAskPerApplication} ₽`,
    });
  }
  if (application.fundingScope === 'direction' && !application.fundingScopeNote) {
    missing.push({ path: 'fundingScopeNote', message: 'уточните направление или этап' });
  }
  return { canSubmit: missing.length === 0, missing };
}

/** Потолок суммы открытых заявок — проверка на подаче (защита от дробления). */
export function exceedsOpenTotal(
  policy: ApplicationPolicy,
  openAskTotal: string,
  candidateAsk: string,
): boolean {
  if (policy.maxOpenAskTotalPerProject === null) return false;
  const total = toMinorUnits(normalizeAmount(openAskTotal)) + toMinorUnits(candidateAsk);
  return total > toMinorUnits(policy.maxOpenAskTotalPerProject);
}

export function addAmounts(a: string, b: string): string {
  return fromMinorUnits(toMinorUnits(normalizeAmount(a)) + toMinorUnits(normalizeAmount(b)));
}

/**
 * Проекция открытых заявок в проект (план 0.2 §2.4). Совместимость, а не
 * правило доступа: каталог, фильтры, интеграционный API и триггер биллинга
 * читают одно число — максимум по открытым заявкам; стадия — последней
 * поданной. Если открытых нет, сумма и стадия не меняются: старое значение
 * честнее выдуманного, а колонки NOT NULL.
 */
export async function recomputeProjectProjection(tx: Tx, projectId: string): Promise<void> {
  await tx.query(
    `WITH open AS (
       SELECT id, stage, investment_ask, current_version_id, submitted_at
         FROM lab.investment_applications
        WHERE project_id = $1 AND status = 'submitted'
     ),
     latest AS (SELECT * FROM open ORDER BY submitted_at DESC, id DESC LIMIT 1),
     agg AS (SELECT max(investment_ask) AS max_ask FROM open)
     UPDATE lab.projects p
        SET investment_ask   = COALESCE(agg.max_ask, p.investment_ask),
            required_plan_id = billing.resolve_founder_plan(COALESCE(agg.max_ask, p.investment_ask)),
            stage            = COALESCE(latest.stage, p.stage),
            current_application_id = latest.id,
            current_version_id     = COALESCE(latest.current_version_id, p.current_version_id),
            status           = CASE WHEN p.status = 'draft' AND latest.id IS NOT NULL
                                    THEN 'submitted' ELSE p.status END,
            updated_at       = now()
       FROM agg LEFT JOIN latest ON true
      WHERE p.id = $1`,
    [projectId],
  );
}

export async function loadActivePolicy(
  tx: Tx,
): Promise<{ version: number; config: ApplicationPolicy }> {
  const { rows } = await tx.query<{ version: number; config_jsonb: unknown }>(
    `SELECT version, config_jsonb FROM lab.application_policies WHERE is_active`,
  );
  const row = rows[0];
  if (!row) throw errors.internal({ reason: 'no active application policy' });
  const parsed = ApplicationPolicySchema.safeParse(row.config_jsonb);
  if (!parsed.success) {
    throw errors.internal({ reason: 'application policy is malformed', version: row.version });
  }
  return { version: row.version, config: parsed.data };
}

async function assertProjectVisible(tx: Tx, projectId: string): Promise<void> {
  const { rows } = await tx.query(
    'SELECT 1 FROM lab.projects WHERE id = $1 AND deleted_at IS NULL',
    [projectId],
  );
  if (rows.length === 0) throw errors.notFound({ subject: 'project' });
}

function actorRole(ctx: RequestContext): string {
  return ctx.roles.includes('admin') ? 'admin' : 'founder';
}

const APPLICATION_COLUMNS = `
  id, project_id, status, title, stage, business_type, funding_scope, funding_scope_note,
  investment_ask::text AS investment_ask, ask_currency, schema_version, answers_jsonb,
  evidence_jsonb, current_version_id, created_at, updated_at, submitted_at, archived_at
`;

export interface ApplicationRow {
  id: string;
  project_id: string;
  status: InvestmentApplication['status'];
  title: string | null;
  stage: InvestmentApplication['stage'];
  business_type: InvestmentApplication['businessType'];
  funding_scope: InvestmentApplication['fundingScope'];
  funding_scope_note: string | null;
  investment_ask: string | null;
  ask_currency: string;
  schema_version: number;
  answers_jsonb: Record<string, unknown>;
  evidence_jsonb: Record<string, string[]>;
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  archived_at: Date | null;
}

export function mapApplication(row: ApplicationRow): InvestmentApplication {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    title: row.title,
    stage: row.stage,
    businessType: row.business_type,
    fundingScope: row.funding_scope,
    fundingScopeNote: row.funding_scope_note,
    investmentAsk: row.investment_ask,
    askCurrency: row.ask_currency as 'RUB',
    schemaVersion: row.schema_version,
    answers: row.answers_jsonb ?? {},
    evidence: row.evidence_jsonb ?? {},
    currentVersionId: row.current_version_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    submittedAt: row.submitted_at?.toISOString() ?? null,
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

interface PolicyRow {
  id: string;
  version: number;
  config_jsonb: unknown;
  is_active: boolean;
  created_by: string | null;
  created_at: Date;
  reason: string;
}

function mapPolicy(row: PolicyRow): ApplicationPolicyVersion {
  const parsed = ApplicationPolicySchema.safeParse(row.config_jsonb);
  if (!parsed.success) {
    throw errors.internal({ reason: 'application policy is malformed', version: row.version });
  }
  return {
    id: row.id,
    version: row.version,
    config: parsed.data,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    reason: row.reason,
  };
}
