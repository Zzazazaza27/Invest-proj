import { Injectable } from '@nestjs/common';
import {
  APPLICATION_FORM_V1,
  ApplicationFormConfigSchema,
  buildStageForm,
  checkAgainstPublished,
  collectPublishedKeys,
  legacyFormConfig,
  uuidv7,
  type ApplicationFormConfig,
  type ApplicationFormVersion,
  type ApplicationFormVersionSummary,
  type ApplicationFormVersions,
  type ApplicationFormView,
  type ProjectStage,
} from '@unicorn/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { errors } from '../common/errors';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Конфигурация вопросов заявки: версии, черновик, публикация, откат
 * (план 0.2 §0в, M073).
 *
 * Правила, которые здесь держатся кодом, а не только БД:
 *
 *  1. ЗАЯВКА ЖИВЁТ НА СВОЕЙ ВЕРСИИ. Форма для заявки собирается из версии,
 *     записанной в её `schema_version`, а не из активной: публикация или
 *     откат другой версии не меняют черновик основателя (§0в п.6).
 *
 *  2. ЧЕРНОВИК ОДИН, ПУБЛИКАЦИЯ — ВЕРСИЯ. Админка правит единственный
 *     черновик; «Опубликовать» присваивает ему следующий номер и делает
 *     активным для НОВЫХ заявок. Откат — повторная активация прежней
 *     опубликованной версии; ни одна версия не удаляется.
 *
 *  3. ДОКУМЕНТ — ВНУТРЕННЯЯ РЕАЛИЗАЦИЯ. Сервер принимает только документ,
 *     прошедший `ApplicationFormConfigSchema` (системные ключи на месте с
 *     фиксированными типами и состояниями) и правила эволюции
 *     (`checkAgainstPublished`: опубликованный ключ нельзя удалить или
 *     сменить ему тип — только архивировать). Ошибки отдаются списком, как
 *     ошибки валидации: админка показывает их все сразу.
 *
 * Веса готовности здесь не живут — у них своя версия (`lab.readiness_configs`).
 */
@Injectable()
export class ApplicationFormsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  /** Форма заявки по ЕЁ версии и стадии, с текстами на языке (fallback — ru-RU). */
  async formForApplication(
    ctx: RequestContext,
    applicationId: string,
    locale: string,
  ): Promise<ApplicationFormView> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ stage: ProjectStage; schema_version: number }>(
        `SELECT stage, schema_version FROM lab.investment_applications WHERE id = $1`,
        [applicationId],
      );
      const row = rows[0];
      if (!row) throw errors.notFound({ subject: 'application' });
      const config = await loadFormConfig(tx, row.schema_version);
      return buildStageForm(config, {
        schemaVersion: row.schema_version,
        stage: row.stage,
        locale,
      });
    });
  }

  // ---------------------------------------------------------------- админка

  async listVersions(ctx: RequestContext): Promise<ApplicationFormVersions> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM lab.application_form_versions
          ORDER BY status = 'draft' DESC, version DESC NULLS LAST`,
      );
      const all = rows.map(mapSummary);
      return {
        activeVersion: all.find((v) => v.isActive)?.version ?? null,
        draft: all.find((v) => v.status === 'draft') ?? null,
        items: all.filter((v) => v.status === 'published'),
      };
    });
  }

  async getVersion(ctx: RequestContext, version: number): Promise<ApplicationFormVersion> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM lab.application_form_versions
          WHERE version = $1 AND status = 'published'`,
        [version],
      );
      const row = rows[0];
      if (!row) throw errors.notFound({ subject: 'application_form_version', version });
      return mapVersion(row);
    });
  }

  /** Черновик целиком; если его нет — создаётся копией активной версии. */
  async getDraft(ctx: RequestContext): Promise<ApplicationFormVersion> {
    return this.db.transaction(ctx, async (tx) => {
      await lockDraft(tx);
      return this.ensureDraft(tx, ctx);
    });
  }

  async saveDraft(
    ctx: RequestContext,
    config: ApplicationFormConfig,
  ): Promise<ApplicationFormVersion> {
    return this.db.transaction(ctx, async (tx) => {
      await lockDraft(tx);
      const draft = await this.ensureDraft(tx, ctx);
      await assertEvolutionRules(tx, config);
      const { rows } = await tx.query<VersionRow>(
        `UPDATE lab.application_form_versions SET config_jsonb = $2::jsonb
          WHERE id = $1 RETURNING ${VERSION_COLUMNS}`,
        [draft.id, JSON.stringify(config)],
      );
      await this.audit.emit(tx, {
        verb: 'lab.application_form.draft_saved',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'application_form',
        subjectId: draft.id,
        context: {
          basedOnVersion: draft.basedOnVersion,
          sections: config.sections.length,
          questions: config.questions.length,
        },
        traceId: ctx.traceId,
      });
      return mapVersion(rows[0]!);
    });
  }

  /** Форма из черновика для стадии — как её увидит основатель после публикации. */
  async preview(
    ctx: RequestContext,
    stage: ProjectStage,
    locale: string,
  ): Promise<ApplicationFormView> {
    return this.db.transaction(ctx, async (tx) => {
      await lockDraft(tx);
      const draft = await this.ensureDraft(tx, ctx);
      const next = await nextVersionNumber(tx);
      return buildStageForm(draft.config, { schemaVersion: next, stage, locale });
    });
  }

  /**
   * Публикация: черновик получает следующий номер, становится опубликованным
   * и активным для новых заявок; прежняя активная гаснет, но остаётся в
   * истории. Одной транзакцией под локом: две публикации подряд получат
   * последовательные номера, а не один и тот же.
   */
  async publish(ctx: RequestContext, reason: string): Promise<ApplicationFormVersion> {
    return this.db.transaction(ctx, async (tx) => {
      await lockDraft(tx);
      const { rows: drafts } = await tx.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM lab.application_form_versions WHERE status = 'draft'`,
      );
      const draft = drafts[0];
      if (!draft)
        throw errors.conflict('Нет черновика для публикации: сначала сохраните изменения');
      const config = parseStoredConfig(draft.config_jsonb, 'draft');
      await assertEvolutionRules(tx, config);

      const version = await nextVersionNumber(tx);
      await tx.query(`UPDATE lab.application_form_versions SET is_active = false WHERE is_active`);
      const { rows } = await tx.query<VersionRow>(
        `UPDATE lab.application_form_versions
            SET status = 'published', version = $2, is_active = true, reason = $3,
                published_by = $4, published_at = now(), activated_at = now()
          WHERE id = $1 RETURNING ${VERSION_COLUMNS}`,
        [draft.id, version, reason, ctx.userId],
      );
      await this.audit.emit(tx, {
        verb: 'lab.application_form.published',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'application_form',
        subjectId: draft.id,
        context: {
          version,
          basedOnVersion: draft.based_on_version,
          reason,
          sections: config.sections.length,
          questions: config.questions.length,
        },
        traceId: ctx.traceId,
      });
      return mapVersion(rows[0]!);
    });
  }

  /**
   * Активация ранее опубликованной версии — откат или возврат. Новые заявки
   * создаются на ней; заявки, созданные на других версиях, не трогаются;
   * черновик админки остаётся как был.
   */
  async activate(
    ctx: RequestContext,
    version: number,
    reason: string,
  ): Promise<ApplicationFormVersion> {
    return this.db.transaction(ctx, async (tx) => {
      await lockDraft(tx);
      const { rows: found } = await tx.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM lab.application_form_versions
          WHERE version = $1 AND status = 'published'`,
        [version],
      );
      const target = found[0];
      if (!target) throw errors.notFound({ subject: 'application_form_version', version });
      if (target.is_active) {
        throw errors.conflict(`Версия ${version} уже активна`);
      }
      await tx.query(`UPDATE lab.application_form_versions SET is_active = false WHERE is_active`);
      const { rows } = await tx.query<VersionRow>(
        `UPDATE lab.application_form_versions
            SET is_active = true, activated_at = now(), reason = $2
          WHERE id = $1 RETURNING ${VERSION_COLUMNS}`,
        [target.id, reason],
      );
      await this.audit.emit(tx, {
        verb: 'lab.application_form.activated',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'application_form',
        subjectId: target.id,
        context: { version, reason },
        traceId: ctx.traceId,
      });
      return mapVersion(rows[0]!);
    });
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Черновик создаётся из активной версии, а без единой опубликованной — из
   * стартовой конфигурации в коде: администратору всегда есть что править.
   */
  private async ensureDraft(tx: Tx, ctx: RequestContext): Promise<ApplicationFormVersion> {
    const { rows } = await tx.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM lab.application_form_versions WHERE status = 'draft'`,
    );
    if (rows[0]) return mapVersion(rows[0]);

    const { rows: active } = await tx.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM lab.application_form_versions WHERE is_active`,
    );
    const base = active[0];
    const config = base ? parseStoredConfig(base.config_jsonb, base.version) : APPLICATION_FORM_V1;
    const { rows: created } = await tx.query<VersionRow>(
      `INSERT INTO lab.application_form_versions
         (id, status, config_jsonb, based_on_version, created_by)
       VALUES ($1, 'draft', $2::jsonb, $3, $4)
       RETURNING ${VERSION_COLUMNS}`,
      [uuidv7(), JSON.stringify(config), base?.version ?? null, ctx.userId],
    );
    return mapVersion(created[0]!);
  }
}

/** Конфигурация версии: 0 — старая форма (системные поля), иначе — из БД. */
export async function loadFormConfig(tx: Tx, version: number): Promise<ApplicationFormConfig> {
  if (version === 0) return legacyFormConfig();
  const { rows } = await tx.query<{ config_jsonb: unknown }>(
    `SELECT config_jsonb FROM lab.application_form_versions
      WHERE version = $1 AND status = 'published'`,
    [version],
  );
  const row = rows[0];
  if (!row) throw errors.notFound({ subject: 'application_form_version', version });
  return parseStoredConfig(row.config_jsonb, version);
}

/**
 * Документ из БД проверяется той же схемой, что и вход админки: испорченная
 * строка — ошибка сервера, а не тихий рендер половины формы.
 */
function parseStoredConfig(raw: unknown, version: number | string | null): ApplicationFormConfig {
  const parsed = ApplicationFormConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `конфигурация вопросов версии ${String(version)} не проходит схему: ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

async function assertEvolutionRules(tx: Tx, next: ApplicationFormConfig): Promise<void> {
  const { rows } = await tx.query<{ config_jsonb: unknown; version: number }>(
    `SELECT version, config_jsonb FROM lab.application_form_versions WHERE status = 'published'`,
  );
  const published = collectPublishedKeys(
    rows.map((r) => parseStoredConfig(r.config_jsonb, r.version)),
  );
  const issues = checkAgainstPublished(next, published);
  if (issues.length > 0) {
    throw errors.validation(issues.map((i) => ({ path: `config.${i.path}`, message: i.message })));
  }
}

async function nextVersionNumber(tx: Tx): Promise<number> {
  const { rows } = await tx.query<{ next: string }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM lab.application_form_versions`,
  );
  return Number(rows[0]?.next ?? 1);
}

/** Черновик и публикация — под одним локом: номер версии присваивается один раз. */
async function lockDraft(tx: Tx): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    'application-form:draft',
  ]);
}

const VERSION_COLUMNS = `
  id, version, status, is_active, config_jsonb, based_on_version, reason, created_by,
  created_at, updated_at, published_by, published_at, activated_at,
  COALESCE(jsonb_array_length(config_jsonb->'sections'), 0) AS sections,
  COALESCE(jsonb_array_length(config_jsonb->'questions'), 0) AS questions
`;

interface VersionRow {
  id: string;
  version: number | null;
  status: 'draft' | 'published';
  is_active: boolean;
  config_jsonb: unknown;
  based_on_version: number | null;
  reason: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  published_by: string | null;
  published_at: Date | null;
  activated_at: Date | null;
  sections: number;
  questions: number;
}

function mapSummary(row: VersionRow): ApplicationFormVersionSummary {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    isActive: row.is_active,
    basedOnVersion: row.based_on_version,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    publishedBy: row.published_by,
    publishedAt: row.published_at?.toISOString() ?? null,
    activatedAt: row.activated_at?.toISOString() ?? null,
    sections: Number(row.sections),
    questions: Number(row.questions),
  };
}

function mapVersion(row: VersionRow): ApplicationFormVersion {
  return { ...mapSummary(row), config: parseStoredConfig(row.config_jsonb, row.version) };
}
