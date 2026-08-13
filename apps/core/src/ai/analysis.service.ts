import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from '@unicorn/contracts';
import { errors } from '../common/errors';
import { getEnv } from '../config/env';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { AiGatewayClient, type AnalysisResult } from './ai-gateway.client';

/**
 * Оркестрация анализа проекта.
 *
 * Core остаётся единственным владельцем БД (ADR-001, ADR-007): шлюз считает,
 * приложение записывает. Из этого следуют три правила, которые здесь и живут.
 *
 *  1. **Запись результата — одна транзакция.** Паспорт, факты, оценки, IRS,
 *     карта готовности, роадмап и событие пишутся вместе либо не пишутся вовсе.
 *     Частично записанный анализ — это проект с новым паспортом и старым IRS,
 *     и никто не заметит расхождения.
 *  2. **Прогон всегда оставляет след.** `audit.agent_runs` заполняется и при
 *     успехе, и при ошибке. Молча не удавшийся анализ выглядит как «ещё не
 *     запускали», а это разные вещи.
 *  3. **Старый паспорт не переписывается.** Новая версия помечает предыдущую
 *     `superseded_at`. История оценок — основание для сравнения моделей, и
 *     переписав её, сравнивать станет не с чем.
 */

/**
 * Класс данных, который уходит в шлюз.
 *
 * Заявка проекта — не персональные данные участников: имена, контакты и
 * документы живут в `identity`/`kyc` и в анализ не передаются. Но это данные
 * непубличного проекта, поэтому класс `pseudonymous`, а не `public`: ошибиться
 * в сторону более строгого класса безопасно, в обратную — нет.
 */
const ANALYSIS_DATA_CLASS = 'pseudonymous' as const;

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly gateway: AiGatewayClient,
  ) {}

  async run(ctx: RequestContext, projectId: string): Promise<AnalysisRunView> {
    await this.assertScoringEnabled(ctx);

    const runId = uuidv7();
    const env = getEnv();
    // Вход читается в ТОЙ ЖЕ транзакции, что создаёт прогон, под advisory-локом
    // проекта: то, что ушло в анализ, зафиксировано снапшотом и отпечатком, а
    // не «что успели прочитать до гонки» (CODE-HIGH-05). Право на запуск
    // проверяется под RLS пользователя — отказ откатывает всё.
    const input = await this.db.transaction(ctx, async (tx) => {
      // Лок на проект берётся ДО проверок. Без него «посмотрели, что активного
      // прогона нет → вставили» — обычная гонка: одновременные запросы читают
      // одно и то же и проходят все (SEC-17).
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `analysis-run:${projectId}`,
      ]);
      // Лок на пользователя — ПОСЛЕ лока проекта (порядок фиксирован, дедлок
      // невозможен: обратного порядка нет ни в одном пути). Без него суточная
      // квота обходилась параллельными запусками по РАЗНЫМ проектам: лок
      // проекта их не сериализует, и count-before-insert видел одно и то же
      // значение (CODE-HIGH-04 / SEC-HIGH-09).
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `analysis-quota:${ctx.userId}`,
      ]);

      // Брошенные прогоны закрываются, иначе упавший экземпляр заблокировал бы
      // проект навсегда: «один активный» превратилось бы в «ни одного больше».
      await tx.query(
        `UPDATE audit.agent_runs
            SET status = 'failed', finished_at = now()
          WHERE project_id = $1 AND status = 'running'
            AND started_at < now() - ($2 || ' minutes')::interval`,
        [projectId, String(env.AI_ANALYSIS_STALE_MINUTES)],
      );

      const { rows: active } = await tx.query(
        `SELECT 1 FROM audit.agent_runs
          WHERE project_id = $1 AND status = 'running' LIMIT 1`,
        [projectId],
      );
      if (active.length > 0) {
        throw errors.conflict('Анализ этого проекта уже выполняется');
      }

      // Суточная квота на пользователя. Общий предел частоты здесь не защищает:
      // он на порядки выше стоимости одного анализа.
      const { rows: used } = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit.agent_runs
          WHERE user_id = $1 AND started_at > now() - interval '24 hours'`,
        [ctx.userId],
      );
      if (Number(used[0]?.n ?? 0) >= env.AI_ANALYSIS_DAILY_LIMIT) {
        throw errors.conflict(
          `Суточный предел запусков анализа исчерпан (${env.AI_ANALYSIS_DAILY_LIMIT})`,
        );
      }

      const { rows } = await tx.query<ProjectRow>(
        `SELECT p.id, p.title, p.tagline, p.description, p.stage,
                p.updated_at,
                EXISTS (SELECT 1 FROM lab.founders_projects fp
                         WHERE fp.project_id = p.id AND fp.user_id = app.current_user_id()
                           AND fp.role IN ('owner','editor')) AS can_edit
           FROM lab.projects p
          WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [projectId],
      );
      const row = rows[0];
      if (!row) throw errors.notFound({ subject: 'project' });
      if (!row.can_edit && !ctx.roles.includes('admin')) {
        throw errors.forbidden({ stage: 'not-project-editor' });
      }
      // Только ПОДТВЕРЖДЁННЫЕ материалы: незавершённый upload-билет — это
      // строка без файла, и учитывать его как «материал есть» значит дать
      // основателю пять пустых билетов ради эвристического балла
      // (CODE-HIGH-05 / SEC-HIGH-10).
      const materials = await tx.query<MaterialRow>(
        `SELECT id, type, version FROM lab.project_materials
          WHERE project_id = $1 AND uploaded_at IS NOT NULL
          ORDER BY id`,
        [projectId],
      );

      const snapshot = {
        title: row.title,
        tagline: row.tagline,
        description: row.description,
        stage: row.stage,
        projectUpdatedAt: row.updated_at.toISOString(),
        materials: materials.rows.map((m) => ({ id: m.id, type: m.type, version: m.version })),
      };
      const inputSha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

      await tx.query(
        `INSERT INTO audit.agent_runs (id, graph_name, project_id, user_id, status)
         VALUES ($1, 'project_analysis', $2, $3, 'running')`,
        [runId, projectId, ctx.userId],
      );
      // Снапшот входа сохраняется рядом с прогоном: у результата появляется
      // provenance — какой именно текст и какие материалы анализировались,
      // с каким отпечатком. Без него «паспорт от 13-го» нечем связать с
      // фактическим состоянием заявки.
      await tx.query(
        `INSERT INTO audit.node_checkpoints (id, run_id, node_name, state_jsonb)
         VALUES ($1, $2, 'input_snapshot', $3::jsonb)`,
        [uuidv7(), runId, JSON.stringify({ inputSha256, snapshot })],
      );

      return { row, materials: materials.rows, snapshot, inputSha256 };
    });

    let result: AnalysisResult;
    try {
      result = await this.gateway.analyze(
        {
          title: input.row.title,
          summary: [input.row.tagline, input.row.description].filter(Boolean).join('\n'),
          stage: input.row.stage,
          // Содержимое материалов не передаётся: парсера дек нет, а ходить по
          // пользовательской ссылке сервером — это SSRF. В анализ попадает
          // только факт наличия материала и его тип.
          materials: input.materials.map((m) => ({ type: m.type })),
        },
        ANALYSIS_DATA_CLASS,
        ctx.traceId,
      );
    } catch (error) {
      await this.db.transaction(ctx, async (tx) => {
        await tx.query(
          `UPDATE audit.agent_runs SET status = 'failed', finished_at = now() WHERE id = $1`,
          [runId],
        );
      });
      throw error;
    }

    // Публикация обёрнута целиком: ЛЮБАЯ ошибка после успешного ответа шлюза
    // (model lookup, constraint, supersede, outbox) раньше оставляла прогон в
    // `running` навсегда — до stale-cleanup следующего запуска. Терминальное
    // состояние — инвариант, а не пожелание (CODE-HIGH-03).
    try {
      return await this.publish(ctx, projectId, runId, input, result);
    } catch (error) {
      await this.failRun(ctx, runId);
      throw error;
    }
  }

  private async publish(
    ctx: RequestContext,
    projectId: string,
    runId: string,
    input: AnalysisInputSnapshot,
    result: AnalysisResult,
  ): Promise<AnalysisRunView> {
    return this.db.transaction(ctx, async (tx) => {
      // Вход мог измениться, пока шлюз считал: публиковать «свежий» паспорт
      // по устаревшему тексту — значит показать инвестору оценку, которая не
      // соответствует заявке. Сверка по той же паре (updated_at + список
      // подтверждённых материалов), что вошла в снапшот и отпечаток.
      const { rows: current } = await tx.query<{ updated_at: Date }>(
        `SELECT updated_at FROM lab.projects WHERE id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      if (!current[0]) throw errors.notFound({ subject: 'project' });
      const currentMaterials = await tx.query<MaterialRow>(
        `SELECT id, type, version FROM lab.project_materials
          WHERE project_id = $1 AND uploaded_at IS NOT NULL
          ORDER BY id`,
        [projectId],
      );
      const sameProject = current[0].updated_at.toISOString() === input.snapshot.projectUpdatedAt;
      const sameMaterials =
        JSON.stringify(
          currentMaterials.rows.map((m) => ({ id: m.id, type: m.type, version: m.version })),
        ) === JSON.stringify(input.snapshot.materials);
      if (!sameProject || !sameMaterials) {
        throw errors.conflict(
          'Проект изменился во время анализа — результат отброшен, запустите анализ заново',
        );
      }

      const modelId = await this.activeModelId(tx, 'ai_score');
      const irsModelId = await this.activeModelId(tx, 'irs');

      const version = await this.supersedePassport(tx, projectId);
      const passportId = uuidv7();
      await tx.query(
        `INSERT INTO scoring.investment_passports
           (id, project_id, version, jsonb_data, disclosure_tier, sources, model_id, published_at)
         VALUES ($1, $2, $3, $4::jsonb, 'teaser', $5::jsonb, $6, now())`,
        [
          passportId,
          projectId,
          version,
          JSON.stringify(result.passport),
          JSON.stringify([{ type: 'analysis_run', ref: runId }]),
          modelId,
        ],
      );

      for (const fact of result.facts) {
        await tx.query(
          `INSERT INTO scoring.passport_facts
             (id, passport_id, category, key, value_jsonb, source_type, source_ref, confidence)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
          [
            uuidv7(),
            passportId,
            fact.category,
            fact.key,
            JSON.stringify(fact.value),
            fact.sourceType,
            fact.sourceRef,
            fact.confidence,
          ],
        );
      }

      for (const score of result.scores) {
        await tx.query(
          `INSERT INTO scoring.scores
             (id, project_id, passport_id, axis, value, confidence_low, confidence_high,
              explanation, sources, model_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
          [
            uuidv7(),
            projectId,
            passportId,
            score.axis,
            score.value,
            score.confidenceLow,
            score.confidenceHigh,
            score.explanation,
            JSON.stringify(score.sources.map((s) => ({ type: s, ref: 'analysis_run:' + runId }))),
            modelId,
          ],
        );
      }

      // Предыдущее значение и дельта считаются от последнего IRS этого проекта.
      // CHECK в схеме требует, чтобы delta = value - previous_value: посчитать
      // их «примерно» не выйдет, и это правильно.
      const previous = await tx.query<{ value: string }>(
        `SELECT value::text AS value FROM scoring.irs_scores
          WHERE project_id = $1 ORDER BY computed_at DESC LIMIT 1`,
        [projectId],
      );
      const previousValue = previous.rows[0] ? Number(previous.rows[0].value) : null;
      const delta = previousValue === null ? null : round2(result.irs.value - previousValue);
      await tx.query(
        `INSERT INTO scoring.irs_scores (id, project_id, value, previous_value, delta, model_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidv7(), projectId, result.irs.value, previousValue, delta, irsModelId],
      );

      for (const entry of result.readiness) {
        await tx.query(
          `INSERT INTO scoring.readiness_map (project_id, dimension, level, recommendations, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (project_id, dimension)
           DO UPDATE SET level = EXCLUDED.level,
                         recommendations = EXCLUDED.recommendations,
                         updated_at = now()`,
          [projectId, entry.dimension, entry.level, JSON.stringify(entry.recommendations)],
        );
      }

      // Активный роадмап один: прошлый деактивируется, а не удаляется —
      // выполненные шаги остаются историей развития проекта.
      await tx.query(
        `UPDATE scoring.roadmaps SET is_active = false
          WHERE project_id = $1 AND is_active AND generated_by = 'ai'`,
        [projectId],
      );
      const roadmapId = uuidv7();
      await tx.query(
        `INSERT INTO scoring.roadmaps (id, project_id, generated_by, is_active)
         VALUES ($1, $2, 'ai', true)`,
        [roadmapId, projectId],
      );
      for (const step of result.roadmap) {
        await tx.query(
          `INSERT INTO scoring.roadmap_steps
             (id, roadmap_id, title, description, dimension, priority, order_index)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            uuidv7(),
            roadmapId,
            step.title,
            step.description,
            step.dimension,
            step.priority,
            step.orderIndex,
          ],
        );
      }

      await tx.query(
        `UPDATE audit.agent_runs
            SET status = 'succeeded', finished_at = now(), model_id = $2
          WHERE id = $1`,
        [runId, modelId],
      );

      await this.audit.emit(tx, {
        verb: 'lab.project.scored',
        actorId: ctx.userId,
        actorRole: 'system',
        subjectType: 'project',
        subjectId: projectId,
        context: {
          runId,
          inputSha256: input.inputSha256,
          provider: result.provider,
          isLlm: result.isLlm,
          modelVersion: result.modelVersion,
          irs: result.irs.value,
        },
        traceId: ctx.traceId,
      });
      await this.audit.enqueue(tx, {
        aggregateType: 'project',
        aggregateId: projectId,
        aggregateVersion: version,
        eventType: 'lab.project.scored',
        payload: { projectId, irs: result.irs.value, passportVersion: version },
      });

      return {
        runId,
        projectId,
        status: 'succeeded' as const,
        provider: result.provider,
        isLlm: result.isLlm,
        modelVersion: result.modelVersion,
        passportVersion: version,
        irs: result.irs.value,
        irsDelta: delta,
      };
    });
  }

  // ------------------------------------------------------------------ чтение

  async getPassport(ctx: RequestContext, projectId: string): Promise<PassportView> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<PassportRow>(
        `SELECT p.id, p.project_id, p.version, p.jsonb_data, p.disclosure_tier,
                p.published_at, m.version AS model_version
           FROM scoring.investment_passports p
           LEFT JOIN scoring.score_models m ON m.id = p.model_id
          WHERE p.project_id = $1 AND p.superseded_at IS NULL`,
        [projectId],
      );
      const row = rows[0];
      if (!row) throw errors.notFound({ subject: 'investment_passport' });

      const scores = await tx.query<ScoreRow>(
        `SELECT axis, value::text AS value, confidence_low::text AS confidence_low,
                confidence_high::text AS confidence_high, explanation, computed_at
           FROM scoring.scores WHERE passport_id = $1 ORDER BY axis`,
        [row.id],
      );
      const irs = await tx.query<{
        value: string;
        previous_value: string | null;
        delta: string | null;
        computed_at: Date;
      }>(
        `SELECT value::text AS value, previous_value::text AS previous_value,
                delta::text AS delta, computed_at
           FROM scoring.irs_scores WHERE project_id = $1
          ORDER BY computed_at DESC LIMIT 1`,
        [projectId],
      );

      return {
        id: row.id,
        projectId: row.project_id,
        version: row.version,
        disclosureTier: row.disclosure_tier,
        modelVersion: row.model_version,
        data: row.jsonb_data,
        publishedAt: row.published_at?.toISOString() ?? null,
        scores: scores.rows.map((s) => ({
          axis: s.axis,
          value: Number(s.value),
          confidenceLow: Number(s.confidence_low),
          confidenceHigh: Number(s.confidence_high),
          explanation: s.explanation,
          computedAt: s.computed_at.toISOString(),
        })),
        irs: irs.rows[0]
          ? {
              value: Number(irs.rows[0].value),
              previousValue:
                irs.rows[0].previous_value === null ? null : Number(irs.rows[0].previous_value),
              delta: irs.rows[0].delta === null ? null : Number(irs.rows[0].delta),
              computedAt: irs.rows[0].computed_at.toISOString(),
            }
          : null,
      };
    });
  }

  async getReadiness(ctx: RequestContext, projectId: string): Promise<ReadinessView[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{
        dimension: string;
        level: string;
        recommendations: string[];
        updated_at: Date;
      }>(
        `SELECT dimension, level, recommendations, updated_at
           FROM scoring.readiness_map WHERE project_id = $1 ORDER BY dimension`,
        [projectId],
      );
      return rows.map((r) => ({
        dimension: r.dimension,
        level: r.level,
        recommendations: r.recommendations,
        updatedAt: r.updated_at.toISOString(),
      }));
    });
  }

  async getRoadmap(ctx: RequestContext, projectId: string): Promise<RoadmapView | null> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        project_id: string;
        generated_by: string;
        is_active: boolean;
        created_at: Date;
      }>(
        `SELECT id, project_id, generated_by, is_active, created_at
           FROM scoring.roadmaps WHERE project_id = $1 AND is_active
          ORDER BY created_at DESC LIMIT 1`,
        [projectId],
      );
      const roadmap = rows[0];
      if (!roadmap) return null;
      const steps = await tx.query<{
        id: string;
        title: string;
        description: string | null;
        dimension: string | null;
        status: string;
        priority: number;
        order_index: number;
      }>(
        `SELECT id, title, description, dimension, status, priority, order_index
           FROM scoring.roadmap_steps WHERE roadmap_id = $1 ORDER BY order_index`,
        [roadmap.id],
      );
      return {
        id: roadmap.id,
        projectId: roadmap.project_id,
        generatedBy: roadmap.generated_by,
        isActive: roadmap.is_active,
        createdAt: roadmap.created_at.toISOString(),
        steps: steps.rows.map((s) => ({
          id: s.id,
          title: s.title,
          description: s.description,
          dimension: s.dimension,
          status: s.status,
          priority: s.priority,
          orderIndex: s.order_index,
        })),
      };
    });
  }

  // ------------------------------------------------------------------ private

  /**
   * Терминальное закрытие прогона при провале публикации. Best-effort:
   * если недоступна сама БД, здесь упадёт и это — тогда прогон закроет
   * stale-cleanup следующего запуска, а причина останется в логе.
   */
  private async failRun(ctx: RequestContext, runId: string): Promise<void> {
    try {
      await this.db.transaction(ctx, async (tx) => {
        await tx.query(
          `UPDATE audit.agent_runs SET status = 'failed', finished_at = now()
            WHERE id = $1 AND status = 'running'`,
          [runId],
        );
      });
    } catch (error) {
      this.logger.error({
        msg: 'не удалось пометить прогон анализа неуспешным',
        runId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private async assertScoringEnabled(ctx: RequestContext): Promise<void> {
    const enabled = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ enabled: boolean }>(
        `SELECT enabled FROM audit.feature_flags WHERE key = 'ai.scoring.enabled'`,
      );
      return rows[0]?.enabled ?? false;
    });
    if (!enabled) throw errors.featureDisabled('ai.scoring.enabled');
  }

  private async activeModelId(tx: Tx, name: string): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM scoring.score_models WHERE name = $1 AND is_active`,
      [name],
    );
    const id = rows[0]?.id;
    if (!id) throw errors.internal({ reason: `no active score model ${name}` });
    return id;
  }

  /** Пометить действующий паспорт устаревшим и вернуть номер новой версии. */
  private async supersedePassport(tx: Tx, projectId: string): Promise<number> {
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE scoring.investment_passports SET superseded_at = now()
        WHERE project_id = $1 AND superseded_at IS NULL
        RETURNING version`,
      [projectId],
    );
    const current = rows[0]?.version;
    if (current !== undefined) return current + 1;
    // Паспорта ещё не было — но версии могли остаться от прошлых прогонов,
    // поэтому берём максимум, а не единицу: UNIQUE(project_id, version).
    const max = await tx.query<{ max: number | null }>(
      `SELECT max(version) AS max FROM scoring.investment_passports WHERE project_id = $1`,
      [projectId],
    );
    return (max.rows[0]?.max ?? 0) + 1;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface ProjectRow {
  id: string;
  title: string;
  tagline: string | null;
  description: string | null;
  stage: string;
  updated_at: Date;
  can_edit: boolean;
}

interface MaterialRow {
  id: string;
  type: string;
  version: number;
}

interface AnalysisInputSnapshot {
  row: ProjectRow;
  materials: MaterialRow[];
  snapshot: {
    title: string;
    tagline: string | null;
    description: string | null;
    stage: string;
    projectUpdatedAt: string;
    materials: { id: string; type: string; version: number }[];
  };
  inputSha256: string;
}

interface PassportRow {
  id: string;
  project_id: string;
  version: number;
  jsonb_data: Record<string, unknown>;
  disclosure_tier: string;
  published_at: Date | null;
  model_version: string | null;
}

interface ScoreRow {
  axis: string;
  value: string;
  confidence_low: string;
  confidence_high: string;
  explanation: string;
  computed_at: Date;
}

export interface AnalysisRunView {
  runId: string;
  projectId: string;
  status: 'succeeded';
  provider: string;
  isLlm: boolean;
  modelVersion: string;
  passportVersion: number;
  irs: number;
  irsDelta: number | null;
}

export interface PassportView {
  id: string;
  projectId: string;
  version: number;
  disclosureTier: string;
  modelVersion: string | null;
  data: Record<string, unknown>;
  publishedAt: string | null;
  scores: {
    axis: string;
    value: number;
    confidenceLow: number;
    confidenceHigh: number;
    explanation: string;
    computedAt: string;
  }[];
  irs: {
    value: number;
    previousValue: number | null;
    delta: number | null;
    computedAt: string;
  } | null;
}

export interface ReadinessView {
  dimension: string;
  level: string;
  recommendations: string[];
  updatedAt: string;
}

export interface RoadmapView {
  id: string;
  projectId: string;
  generatedBy: string;
  isActive: boolean;
  createdAt: string;
  steps: {
    id: string;
    title: string;
    description: string | null;
    dimension: string | null;
    status: string;
    priority: number;
    orderIndex: number;
  }[];
}
