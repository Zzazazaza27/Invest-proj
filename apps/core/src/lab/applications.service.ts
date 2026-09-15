import { Injectable } from '@nestjs/common';
import {
  ApplicationPolicySchema,
  DEFAULT_FORM_LOCALE,
  ReadinessConfigSchema,
  applicableQuestions,
  buildAnswersSchema,
  buildStageForm,
  computeCompleteness,
  uuidv7,
  type ActivateReadinessConfigRequest,
  type ApplicationDetail,
  type ApplicationFormConfig,
  type ApplicationLimits,
  type ApplicationPolicy,
  type ApplicationPolicyVersion,
  type ApplicationReadiness,
  type ApplicationSubmissionCheck,
  type ActivateApplicationPolicyRequest,
  type CreateApplicationRequest,
  type InvestmentApplication,
  type ProjectVersion,
  type ReadinessConfig,
  type ReadinessConfigVersion,
  type UpdateApplicationRequest,
  toMinorUnits,
  fromMinorUnits,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { loadFormConfig } from './application-forms.service';
import { VERSION_COLUMNS, mapVersion, type VersionRow } from './versions';

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
      const schemaVersion = await activeSchemaVersion(tx);
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
          schemaVersion,
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

  async get(ctx: RequestContext, applicationId: string): Promise<ApplicationDetail> {
    return this.db.readOnly(ctx, async (tx) => {
      const application = await this.load(tx, applicationId);
      return this.detail(tx, application);
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
  ): Promise<ApplicationDetail> {
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
        // Ответы проверяются по форме ВЕРСИИ заявки: тип, ограничения, коды
        // вариантов, ключи только из документа. Схема 0 — ответы свободны.
        if (current.schemaVersion > 0) {
          const form = await loadFormConfig(tx, current.schemaVersion);
          const parsed = buildAnswersSchema(form).safeParse(input.answers);
          if (!parsed.success) {
            throw errors.validation(
              parsed.error.issues.map((issue) => ({
                path: `answers.${issue.path.join('.') || '(корень)'}`,
                message: issue.message,
              })),
            );
          }
        }
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

      return this.detail(tx, mapApplication(row));
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

  // ------------------------------------------------------------------ подача

  /**
   * Подача заявки (план 0.2 §2.3, §5.1). Сезон не требуется.
   *
   * Создаёт НЕИЗМЕНЯЕМЫЙ снимок версии: на него ссылаются скоринг и
   * экспертиза, и правки черновика после подачи его не трогают. Повторная
   * подача той же заявки — новая версия, а не новая заявка: улучшать заявку
   * всегда дешевле, чем заводить ещё одну.
   */
  async submit(
    ctx: RequestContext,
    applicationId: string,
    opts: SubmitOptions = {},
  ): Promise<ProjectVersion> {
    return this.db.transaction(ctx, (tx) => this.submitInTx(tx, ctx, applicationId, opts));
  }

  /**
   * Та же подача внутри чужой транзакции — для старого маршрута проекта,
   * который добавляет сезон и своё событие в ту же единицу работы.
   */
  async submitInTx(
    tx: Tx,
    ctx: RequestContext,
    applicationId: string,
    opts: SubmitOptions = {},
  ): Promise<ProjectVersion> {
    const enforcePolicy = opts.enforcePolicy ?? true;
    const probe = await this.load(tx, applicationId);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `project-write:${probe.projectId}`,
    ]);
    // Перечитать под локом: параллельная подача могла изменить заявку.
    const application = await this.load(tx, applicationId);
    if (application.status === 'archived') {
      throw errors.stateTransition('Заявка в архиве: подать её нельзя');
    }

    const { rows: projectRows } = await tx.query<SnapshotProjectRow>(
      `SELECT title, tagline, description, taxonomy_id, geo_country, geo_region, status
         FROM lab.projects WHERE id = $1 AND deleted_at IS NULL`,
      [application.projectId],
    );
    const project = projectRows[0];
    if (!project) throw errors.notFound({ subject: 'project' });
    if (project.status === 'rejected' || project.status === 'archived') {
      throw errors.stateTransition('Проект закрыт: подача заявки недоступна');
    }

    const policy = await loadActivePolicy(tx);
    const rules = enforcePolicy
      ? policy.config
      : { ...policy.config, maxAskPerApplication: null, maxOpenAskTotalPerProject: null };
    // Обязательные вопросы формы — условие подачи наравне с суммой (план 0.2 §4 п.5).
    const assessment = await assessApplication(tx, application);
    const check = checkSubmission(application, rules, assessment.readiness);
    if (!check.canSubmit) throw errors.validation(check.missing);
    const ask = application.investmentAsk!;

    if (rules.maxOpenAskTotalPerProject !== null) {
      // Сумма открытых заявок БЕЗ этой: при повторной подаче она уже в сумме.
      const { rows } = await tx.query<{ total: string | null }>(
        `SELECT sum(investment_ask)::text AS total FROM lab.investment_applications
          WHERE project_id = $1 AND status = 'submitted' AND id <> $2`,
        [application.projectId, applicationId],
      );
      const others = rows[0]?.total ?? '0.00';
      if (exceedsOpenTotal(rules, others, ask)) {
        throw errors.limitExceeded(
          `Сумма открытых запросов проекта превысит потолок ${rules.maxOpenAskTotalPerProject} ₽: ` +
            `уже открыто ${addAmounts(others, '0')} ₽`,
        );
      }
    }

    // Номер версии — внутри заявки; при подаче в сезон он обязан быть уникален
    // и в паре (проект, сезон): у проекта с несколькими заявками номера
    // версий разных заявок совпадают, а старый UNIQUE этого не знает.
    const next = await tx.query<{ next_no: string }>(
      `SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no
         FROM lab.project_versions
        WHERE application_id = $1
           OR ($3::uuid IS NOT NULL AND project_id = $2 AND season_id = $3)`,
      [applicationId, application.projectId, opts.seasonId ?? null],
    );
    const versionNo = Number(next.rows[0]?.next_no ?? 1);
    const versionId = uuidv7();
    const snapshot = buildSnapshot(application, project, {
      form: assessment.form,
      readiness: assessment.readiness,
      locale: DEFAULT_FORM_LOCALE,
    });

    const { rows: versionRows } = await tx.query<VersionRow>(
      `INSERT INTO lab.project_versions
         (id, project_id, season_id, version_no, snapshot_jsonb, application_id, schema_version,
          readiness_config_version, completeness_pct)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
       RETURNING ${VERSION_COLUMNS}`,
      [
        versionId,
        application.projectId,
        opts.seasonId ?? null,
        versionNo,
        JSON.stringify(snapshot),
        applicationId,
        application.schemaVersion,
        assessment.readiness.readinessConfigVersion,
        assessment.readiness.percent,
      ],
    );

    await tx.query(
      `UPDATE lab.investment_applications
          SET status = 'submitted', submitted_at = now(), current_version_id = $2
        WHERE id = $1`,
      [applicationId, versionId],
    );
    if (opts.seasonId) {
      await tx.query(`UPDATE lab.projects SET season_id = $2 WHERE id = $1`, [
        application.projectId,
        opts.seasonId,
      ]);
    }
    await recomputeProjectProjection(tx, application.projectId);

    await this.audit.record(tx, {
      verb: 'lab.application.submitted',
      actorId: ctx.userId,
      actorRole: actorRole(ctx),
      aggregateType: 'application',
      aggregateId: applicationId,
      aggregateVersion: versionNo,
      payload: {
        applicationId,
        projectId: application.projectId,
        versionId,
        versionNo,
        seasonId: opts.seasonId ?? null,
        schemaVersion: application.schemaVersion,
      },
      traceId: ctx.traceId,
    });

    return mapVersion(versionRows[0]!);
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

  // ------------------------------------------------------ веса готовности (админ)

  async listReadinessConfigs(ctx: RequestContext): Promise<ReadinessConfigVersion[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<ReadinessRow>(
        `SELECT ${READINESS_COLUMNS} FROM lab.readiness_configs ORDER BY version DESC LIMIT 100`,
      );
      return rows.map(mapReadiness);
    });
  }

  /**
   * Новая версия весов активируется одной транзакцией, как политика: прежняя
   * гаснет и остаётся в истории. Черновики заявок считаются по новой версии
   * налету; снимки хранят свою версию и процент и не пересчитываются
   * (план 0.2 §5.4). Конфигурация вопросов не трогается — у неё свои версии.
   */
  async activateReadinessConfig(
    ctx: RequestContext,
    input: ActivateReadinessConfigRequest,
  ): Promise<ReadinessConfigVersion> {
    return this.db.transaction(ctx, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        'readiness-config:activate',
      ]);
      const schemaVersion = await activeSchemaVersion(tx);
      await tx.query(`UPDATE lab.readiness_configs SET is_active = false WHERE is_active`);
      const { rows } = await tx.query<ReadinessRow>(
        `INSERT INTO lab.readiness_configs
           (id, version, schema_version, config_jsonb, is_active, created_by, reason)
         VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM lab.readiness_configs),
                 $2, $3::jsonb, true, $4, $5)
         RETURNING ${READINESS_COLUMNS}`,
        [uuidv7(), schemaVersion, JSON.stringify(input.config), ctx.userId, input.reason],
      );
      const row = rows[0]!;
      await this.audit.emit(tx, {
        verb: 'lab.readiness_config.activated',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'readiness_config',
        subjectId: row.id,
        context: {
          version: row.version,
          schemaVersion,
          reason: input.reason,
          config: input.config,
        },
        traceId: ctx.traceId,
      });
      return mapReadiness(row);
    });
  }

  // ------------------------------------------------------------------ helpers

  /** Заявка + условия подачи + готовность — то, что видит мастер после каждого сохранения. */
  private async detail(tx: Tx, application: InvestmentApplication): Promise<ApplicationDetail> {
    const policy = await loadActivePolicy(tx);
    const { readiness } = await assessApplication(tx, application);
    return {
      application,
      submission: checkSubmission(application, policy.config, readiness),
      readiness,
    };
  }

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
 * Схема 0 — старая форма из девяти полей проекта, ответы свободны: так
 * созданы заявки переноса M071 и так создаются новые, пока ни одна версия
 * конфигурации вопросов не опубликована (M073, план 0.2 §0в).
 */
export const LEGACY_SCHEMA_VERSION = 0;

/**
 * Версия конфигурации, с которой создаётся новый черновик, — активная
 * опубликованная. Заявка живёт на ней до подачи: публикация или откат
 * другой версии её не трогают (§0в п.6), поэтому версия читается один раз,
 * при создании, и хранится в строке заявки.
 */
export async function activeSchemaVersion(tx: Tx): Promise<number> {
  const { rows } = await tx.query<{ version: number }>(
    `SELECT version FROM lab.application_form_versions WHERE is_active AND status = 'published'`,
  );
  return rows[0]?.version ?? LEGACY_SCHEMA_VERSION;
}

export interface SubmitOptions {
  /** Сезон — только для старого маршрута подачи проекта (план 0.2 §2.14). */
  seasonId?: string;
  /** Старый маршрут политику ограничений не проверяет: v1 работает как прежде. */
  enforcePolicy?: boolean;
}

export interface SnapshotProjectRow {
  title: string;
  tagline: string | null;
  description: string | null;
  taxonomy_id: string | null;
  geo_country: string | null;
  geo_region: string | null;
  status: string;
}

/**
 * Снимок версии (план 0.2 §5.1). Хранит и заявку, и те поля проекта, что
 * входят в представление инвестору: правки проекта после подачи снимок не
 * меняют. `applicableKeys` для схемы 0 пуст — применимость вопросов появится
 * со схемой 1 (этап 3).
 */
export function buildSnapshot(
  application: InvestmentApplication,
  project: Omit<SnapshotProjectRow, 'status'>,
  /**
   * Форма и готовность на момент подачи (план 0.2 §0в п.7): разделы,
   * показанные вопросы с ключами, типами, формулировками и обязательностью
   * на языке подачи. Снимок самодостаточен — поданная заявка открывается
   * так, как её видел основатель, даже если вопрос потом изменили или
   * архивировали. Без аргумента — снимок схемы 0 (тесты, совместимость).
   */
  formState?: { form: ApplicationFormConfig; readiness: ApplicationReadiness; locale: string },
): Record<string, unknown> {
  const applicableKeys: Record<string, string> = {};
  if (formState) {
    for (const [key, level] of applicableQuestions(formState.form, application.stage)) {
      if (key === 'funding_scope_note' && application.fundingScope !== 'direction') continue;
      applicableKeys[key] = level;
    }
  }
  return {
    core: {
      title: application.title,
      stage: application.stage,
      businessType: application.businessType,
      fundingScope: application.fundingScope,
      fundingScopeNote: application.fundingScopeNote,
      investmentAsk: application.investmentAsk,
      askCurrency: application.askCurrency,
    },
    answers: application.answers,
    evidence: application.evidence,
    applicableKeys,
    ...(formState
      ? {
          form: buildStageForm(formState.form, {
            schemaVersion: application.schemaVersion,
            stage: application.stage,
            locale: formState.locale,
          }),
          readiness: {
            percent: formState.readiness.percent,
            readinessConfigVersion: formState.readiness.readinessConfigVersion,
          },
        }
      : {}),
    project: {
      title: project.title,
      tagline: project.tagline,
      description: project.description,
      taxonomyId: project.taxonomy_id,
      geoCountry: project.geo_country,
      geoRegion: project.geo_region,
    },
  };
}

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
  /** Готовность по форме версии заявки: незаполненные обязательные вопросы тоже мешают подаче. */
  readiness?: Pick<ApplicationReadiness, 'missingMandatory'>,
): ApplicationSubmissionCheck {
  const missing: ApplicationSubmissionCheck['missing'] = [];
  // Системные поля проверяются ниже своими сообщениями; из готовности берутся
  // только вопросы формы, чтобы сумма не попадала в список дважды.
  for (const key of readiness?.missingMandatory ?? []) {
    if (CORE_KEYS.has(key)) continue;
    missing.push({ path: `answers.${key}`, message: 'заполните обязательный вопрос' });
  }
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
     latest_open AS (SELECT * FROM open ORDER BY submitted_at DESC, id DESC LIMIT 1),
     -- Текущая заявка: последняя открытая, а если открытых нет — последний
     -- незаархивированный черновик (так же её выбирает перенос M071).
     latest_any AS (
       SELECT id FROM lab.investment_applications
        WHERE project_id = $1 AND status <> 'archived'
        ORDER BY (status = 'submitted') DESC, submitted_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 1
     ),
     agg AS (SELECT max(investment_ask) AS max_ask FROM open)
     UPDATE lab.projects p
        SET investment_ask   = COALESCE(agg.max_ask, p.investment_ask),
            required_plan_id = billing.resolve_founder_plan(COALESCE(agg.max_ask, p.investment_ask)),
            stage            = COALESCE(latest_open.stage, p.stage),
            current_application_id = latest_any.id,
            current_version_id     = COALESCE(latest_open.current_version_id, p.current_version_id),
            status           = CASE WHEN p.status = 'draft' AND latest_open.id IS NOT NULL
                                    THEN 'submitted' ELSE p.status END,
            updated_at       = now()
       FROM agg LEFT JOIN latest_open ON true LEFT JOIN latest_any ON true
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

const CORE_KEYS = new Set([
  'stage',
  'business_type',
  'funding_scope',
  'funding_scope_note',
  'investment_ask',
]);

/**
 * Форма версии заявки и её готовность по активным весам. Форма берётся по
 * `schema_version` самой заявки (она живёт на своей версии), веса — активные:
 * процент черновика может измениться после активации новых весов, и это
 * ожидаемо (план 0.2 §5.4); снимок хранит свою версию и процент.
 */
export async function assessApplication(
  tx: Tx,
  application: InvestmentApplication,
): Promise<{ form: ApplicationFormConfig; readiness: ApplicationReadiness }> {
  const form = await loadFormConfig(tx, application.schemaVersion);
  const weights = await loadActiveReadinessConfig(tx);
  const readiness = computeCompleteness(
    form,
    weights.config,
    {
      stage: application.stage,
      businessType: application.businessType,
      fundingScope: application.fundingScope,
      fundingScopeNote: application.fundingScopeNote,
      investmentAsk: application.investmentAsk,
      answers: application.answers,
      evidence: application.evidence,
    },
    { schemaVersion: application.schemaVersion, readinessConfigVersion: weights.version },
  );
  return { form, readiness };
}

export async function loadActiveReadinessConfig(
  tx: Tx,
): Promise<{ version: number; config: ReadinessConfig }> {
  const { rows } = await tx.query<{ version: number; config_jsonb: unknown }>(
    `SELECT version, config_jsonb FROM lab.readiness_configs WHERE is_active`,
  );
  const row = rows[0];
  if (!row) throw new Error('нет активной конфигурации готовности: сид M075 не применён');
  const parsed = ReadinessConfigSchema.safeParse(row.config_jsonb);
  if (!parsed.success) {
    throw new Error(`конфигурация готовности версии ${row.version} не проходит схему`);
  }
  return { version: row.version, config: parsed.data };
}

const READINESS_COLUMNS = `id, version, schema_version, config_jsonb, is_active, created_by, created_at, reason`;

interface ReadinessRow {
  id: string;
  version: number;
  schema_version: number;
  config_jsonb: unknown;
  is_active: boolean;
  created_by: string | null;
  created_at: Date;
  reason: string;
}

function mapReadiness(row: ReadinessRow): ReadinessConfigVersion {
  return {
    id: row.id,
    version: row.version,
    schemaVersion: row.schema_version,
    config: ReadinessConfigSchema.parse(row.config_jsonb),
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    reason: row.reason,
  };
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
