import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  buildAnalysisInput,
  uuidv7,
  type AnalysisAnswer,
  type AnalysisMetadata,
  type SubmittedSnapshot,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { getEnv } from '../config/env';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { type ScoringReviewItem, type StoredPassport } from '@unicorn/contracts';
import { AiGatewayClient, type AnalysisResult } from './ai-gateway.client';
import { ProviderCredentialsService } from './provider-credentials.service';
import { CryptoService } from '../crypto/crypto.service';
import { LocalizationService } from './localization.service';
import {
  EgressViolation,
  IRS_DISCREPANCY_TOLERANCE,
  assertAxesComplete,
  assertReadinessComplete,
  buildIrsBreakdown,
  checkEgress,
  computeIrs,
  computeScore10,
  stripSlotMarkers,
  type Stage,
} from './scoring-rules';

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

/** AAD зашифрованных фактов паспорта; ротация KEK проверяет ключ с ним. */
const FACT_AAD = 'field:fact_value';

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly gateway: AiGatewayClient,
    private readonly credentials: ProviderCredentialsService,
    private readonly crypto: CryptoService,
    private readonly localization: LocalizationService,
  ) {}

  /**
   * Настроен ли выход к моделям.
   *
   * Нужен тем, кто решает, МОЖНО ли вообще запускать разбор, — чтобы не
   * создавать запись о прогоне, которому нечем работать. Сам адрес шлюза
   * наружу не отдаётся.
   */
  gatewayConfigured(): boolean {
    return this.gateway.isConfigured;
  }

  async run(ctx: RequestContext, projectId: string): Promise<AnalysisRunView> {
    const flags = await this.assertScoringEnabled(ctx);

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
                p.investment_ask::text AS investment_ask, p.ask_currency, p.geo_country,
                (SELECT t.name_ru FROM lab.project_taxonomy t WHERE t.id = p.taxonomy_id) AS taxonomy_name,
                EXISTS (SELECT 1 FROM lab.founders_projects fp
                         WHERE fp.project_id = p.id AND fp.user_id = app.current_user_id()
                           AND fp.role IN ('owner','cofounder')) AS can_edit
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

      // ОТВЕТЫ АНКЕТЫ — из ПОДАННОЙ версии, а не из редактируемого черновика.
      //
      // Черновик меняется в любую секунду, и отчёт по нему нельзя привязать ни
      // к какой версии: назавтра «та же заявка» означала бы другой текст.
      // Снимок поданной версии неизменяем (M004) и самодостаточен — в нём
      // лежат и ответы, и формулировки вопросов на языке подачи, и стадия.
      const submitted = await loadSubmittedAnswers(tx, projectId);

      // Маркеры слота данных вырезаются ДО снимка: снимок хранит ровно то, что
      // анализировалось, а nonce входит в отпечаток — воспроизводимость прогона
      // включает и границу слота (ADR-008 §3, Э4). Nonce детерминирован по
      // входу (HMAC с серверным ключом): один и тот же снимок — один и тот же
      // промпт, иначе модель даёт разброс IRS 4+ на одинаковом входе.
      // Вход собирается ОДНИМ местом из снимка поданной версии: ответы с
      // формулировками вопросов, метаданные, источник каждого поля.
      const built = buildAnalysisInput({
        snapshot: submitted?.snapshot ?? null,
        versionId: submitted?.versionId ?? null,
        versionNo: submitted?.versionNo ?? null,
        card: {
          title: row.title,
          tagline: row.tagline,
          description: row.description,
          stage: row.stage,
          investmentAsk: row.investment_ask,
          askCurrency: row.ask_currency,
          taxonomy: row.taxonomy_name,
          geoCountry: row.geo_country,
        },
      });

      const title = stripSlotMarkers(built.title);
      const summary = stripSlotMarkers(built.summary);
      const nonce = this.crypto.analysisNonce(
        `${row.id}|${row.updated_at.toISOString()}|${title.text}|${summary.text}`,
      );
      // Снимок входа — это и есть ответ на вопрос «что анализировалось».
      // Поэтому в него попадает ВСЁ: текст, ответы, метаданные и источник
      // каждого поля. Отпечаток считается по нему целиком.
      const snapshot = {
        title: title.text,
        summary: summary.text,
        stage: built.stage,
        nonce,
        markersRemoved: title.removed + summary.removed,
        metadata: built.metadata,
        sources: built.sources,
        projectUpdatedAt: row.updated_at.toISOString(),
        materials: materials.rows.map((m) => ({ id: m.id, type: m.type, version: m.version })),
        versionId: built.versionId,
        versionNo: built.versionNo,
        includesAnswers: built.includesAnswers,
        answers: built.answers,
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

    // Ключ провайдера достаётся ПОСЛЕ фиксации входа и только при включённом
    // LLM-скоринге: без флага прогон идёт эвристикой, и ключ из хранилища не
    // читается вовсе. Объект уходит в шлюз и нигде не задерживается.
    const credential = flags.llm
      ? await this.db.readOnly(ctx, (tx) => this.credentials.activeForCall(tx))
      : null;
    if (flags.llm && !credential) {
      await this.failRun(ctx, runId);
      throw errors.featureDisabled('ai.scoring.llm.enabled');
    }

    // Ответы анкеты и содержимое закрытых материалов НЕ уходят внешней модели,
    // пока не согласованы условия обработки. Разбор по правилам считает наш
    // собственный шлюз, и для него ограничение не действует; включённая
    // языковая модель — другое дело, и без явного разрешения путь закрыт.
    if (flags.llm && !flags.answersToModel) {
      await this.failRun(ctx, runId);
      throw errors.featureDisabled('ai.answers_to_model.allowed');
    }

    let result: AnalysisResult;
    try {
      result = await this.gateway.analyze(
        {
          title: input.snapshot.title,
          summary: input.snapshot.summary,
          stage: input.snapshot.stage,
          nonce: input.snapshot.nonce,
          metadata: input.snapshot.metadata,
          // Ответы анкеты с формулировками вопросов — то, ради чего анализ и
          // существует. Идут они в НАШ шлюз; внешней модели они не достаются,
          // пока не согласованы условия обработки (проверка ниже по флагу).
          answers: input.snapshot.answers.map((a) => ({
            key: a.key,
            question: a.question,
            text: a.text,
          })),
          // Содержимое материалов не передаётся: парсера дек нет, а ходить по
          // пользовательской ссылке сервером — это SSRF. В анализ попадает
          // только факт наличия материала и его тип.
          materials: input.materials.map((m) => ({ type: m.type })),
        },
        ANALYSIS_DATA_CLASS,
        ctx.traceId,
        { credential },
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
    let view: AnalysisRunView;
    try {
      view = await this.publish(ctx, projectId, runId, input, result);
    } catch (error) {
      if (error instanceof EgressViolation) {
        // Модель вернула то, чего не должна: ссылку, разметку, чужие
        // персональные данные. Это отказ прогона с названной причиной, а не
        // тихая правка — правка прятала бы сам факт (Э5). Причина пишется
        // отдельной транзакцией: та, где она обнаружена, откатывается.
        await this.journal(ctx, runId, 'egress_rejected', {
          field: error.field,
          reason: error.reason,
        });
        await this.failRun(ctx, runId);
        throw errors.conflict(
          `Результат анализа отклонён фильтром публикации (${error.field}: ${error.reason})`,
        );
      }
      await this.failRun(ctx, runId);
      throw error;
    }

    // Перевод — сразу после оценки, тем же провайдером, своим прогоном
    // (ADR-008 §5): английский читатель не должен ждать первого запроса, а
    // упавший перевод не делает оценку неуспешной.
    if (credential && view.passportId) {
      await this.localization.translate(ctx, projectId, view.passportId, credential);
    }
    return view;
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

      // То, что считает код, а не модель (ADR-008 §3). Порядок: полнота →
      // арифметика → фильтр выхода. Расхождения с моделью — в журнал прогона,
      // отказ — только на полноте и на фильтре.
      assertAxesComplete(result.scores);
      assertReadinessComplete(result.readiness);
      const computed = this.applyScoringRules(input.row.stage as Stage, result);
      checkEgress({
        passport: computed.stored,
        scores: result.scores,
        readiness: result.readiness,
        roadmap: result.roadmap,
      });
      const irsValue = computed.stored.irsComputed;
      await tx.query(
        `INSERT INTO audit.node_checkpoints (id, run_id, node_name, state_jsonb)
         VALUES ($1, $2, 'scoring_rules', $3::jsonb)`,
        [
          uuidv7(),
          runId,
          JSON.stringify({
            irsModel: result.irs.value,
            irsComputed: irsValue,
            score10Model: result.passport.score10,
            score10Base: computed.stored.score10Base,
            score10Proposed: computed.stored.score10Proposed,
            discrepancies: computed.stored.discrepancies,
            integrityFlags: result.passport.integrityFlags,
            complianceFlags: result.passport.complianceFlags,
            markersRemoved: input.snapshot.markersRemoved,
          }),
        ],
      );

      const version = await this.supersedePassport(tx, projectId);
      const passportId = uuidv7();
      await tx.query(
        `INSERT INTO scoring.investment_passports
           (id, project_id, version, jsonb_data, disclosure_tier, sources, model_id, published_at,
            project_version_id, input_sha256, input_sources, includes_answers, input_metadata)
         VALUES ($1, $2, $3, $4::jsonb, 'teaser', $5::jsonb, $6, now(),
                 $7, $8, $9::jsonb, $10, $11::jsonb)`,
        [
          passportId,
          projectId,
          version,
          JSON.stringify(computed.stored),
          JSON.stringify([{ type: 'analysis_run', ref: runId }]),
          modelId,
          // Происхождение живёт в САМОМ паспорте, а не только у прогона услуги:
          // прямой вызов анализа тоже обязан его нести.
          input.snapshot.versionId,
          input.inputSha256,
          JSON.stringify(input.snapshot.sources),
          input.snapshot.includesAnswers,
          // Не только «откуда», но и «что именно»: справочник отрасли ещё
          // переименуют, а объяснение этого отчёта меняться не должно.
          JSON.stringify(input.snapshot.metadata),
        ],
      );

      for (const fact of result.facts) {
        // Факты категорий finance и legal — выручка, маржа, запас хода,
        // структура владения — шифруются доменом passport_sensitive (Э14):
        // колонка value_wrapped_dek заведена M006 ровно для этого и до сих пор
        // была пуста, то есть выглядела защитой, которой нет. Остальные
        // категории остаются открытыми: по ним строится карта готовности.
        const sensitive = fact.category === 'finance' || fact.category === 'legal';
        const sealed = sensitive
          ? this.crypto.seal('passport_sensitive', JSON.stringify(fact.value), FACT_AAD)
          : null;
        await tx.query(
          `INSERT INTO scoring.passport_facts
             (id, passport_id, category, key, value_jsonb, value_wrapped_dek,
              source_type, source_ref, confidence)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
          [
            uuidv7(),
            passportId,
            fact.category,
            fact.key,
            sealed
              ? JSON.stringify({ enc: sealed.ciphertext.toString('base64') })
              : JSON.stringify(fact.value),
            sealed ? sealed.wrappedDek : null,
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
      const delta = previousValue === null ? null : round2(irsValue - previousValue);
      await tx.query(
        `INSERT INTO scoring.irs_scores (id, project_id, value, previous_value, delta, model_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidv7(), projectId, irsValue, previousValue, delta, irsModelId],
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
          promptVersion: result.promptVersion ?? null,
          irs: irsValue,
          score10: computed.stored.score10Published,
          reviewStatus: computed.stored.review.status,
        },
        traceId: ctx.traceId,
      });
      await this.audit.enqueue(tx, {
        aggregateType: 'project',
        aggregateId: projectId,
        aggregateVersion: version,
        eventType: 'lab.project.scored',
        payload: { projectId, irs: irsValue, passportVersion: version },
      });

      return {
        runId,
        projectId,
        status: 'succeeded' as const,
        inputSha256: input.inputSha256,
        inputVersionId: input.snapshot.versionId,
        inputVersionNo: input.snapshot.versionNo,
        includesAnswers: input.snapshot.includesAnswers,
        provider: result.provider,
        isLlm: result.isLlm,
        modelVersion: result.modelVersion,
        passportVersion: version,
        passportId,
        irs: irsValue,
        irsDelta: delta,
        score10: computed.stored.score10Published,
        reviewStatus: computed.stored.review.status,
      };
    });
  }

  /**
   * Пересчёт того, чему нельзя верить модели: IRS из осей по весам, балл из
   * IRS по таблице, потолки по коду правила и стадии. Значения модели служат
   * контролем: расхождение — запись в журнал, число — из расчёта.
   *
   * Публикуемый балл равен базовому, пока человек не подтвердил потолки и
   * штрафы (ADR-008 §4): суждение модели не меняет позицию проекта само.
   */
  private applyScoringRules(stage: Stage, result: AnalysisResult): { stored: StoredPassport } {
    const passport = result.passport;
    const irsComputed = computeIrs(result.scores);
    const discrepancies: string[] = [];
    if (Math.abs(irsComputed - result.irs.value) > IRS_DISCREPANCY_TOLERANCE) {
      discrepancies.push(`irs: модель ${result.irs.value}, пересчёт ${irsComputed}`);
    }
    if (Math.abs(irsComputed - passport.irsBreakdown.sum) > IRS_DISCREPANCY_TOLERANCE) {
      discrepancies.push(
        `irsBreakdown.sum: модель ${passport.irsBreakdown.sum}, пересчёт ${irsComputed}`,
      );
    }
    const score = computeScore10(
      irsComputed,
      stage,
      passport.capsApplied,
      passport.penaltiesApplied,
    );
    discrepancies.push(...score.discrepancies);
    if (passport.score10 !== score.proposed) {
      discrepancies.push(`score10: модель ${passport.score10}, пересчёт ${score.proposed}`);
    }
    const needsReview = score.caps.length > 0 || score.penalties.length > 0;
    const stored: StoredPassport = {
      ...passport,
      irsBreakdown: buildIrsBreakdown(result.scores) as StoredPassport['irsBreakdown'],
      capsApplied: score.caps,
      penaltiesApplied: score.penalties,
      score10Base: score.base,
      score10Proposed: score.proposed,
      score10Published: score.base,
      irsComputed,
      discrepancies: discrepancies.slice(0, 20),
      review: { status: needsReview ? 'pending' : 'none', decidedBy: null, decidedAt: null },
      complianceReview: {
        status: passport.complianceFlags.length > 0 ? 'pending' : 'none',
        decidedBy: null,
        decidedAt: null,
      },
    };
    return { stored };
  }

  // ------------------------------------------------------------ решения человека

  /**
   * Очередь оценок, ждущих человека: потолки/штрафы и флаги комплаенса.
   * Только действующие паспорта — по устаревшей версии решать нечего.
   */
  async listReviews(ctx: RequestContext): Promise<ScoringReviewItem[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        project_id: string;
        title: string;
        version: number;
        published_at: Date | null;
        jsonb_data: StoredPassport;
      }>(
        `SELECT p.id, p.project_id, pr.title, p.version, p.published_at, p.jsonb_data
           FROM scoring.investment_passports p
           JOIN lab.projects pr ON pr.id = p.project_id
          WHERE p.superseded_at IS NULL
            AND (p.jsonb_data->'review'->>'status' = 'pending'
                 OR p.jsonb_data->'complianceReview'->>'status' = 'pending')
          ORDER BY p.published_at DESC NULLS LAST
          LIMIT 200`,
      );
      return rows.map((row) => ({
        passportId: row.id,
        projectId: row.project_id,
        projectTitle: row.title,
        passportVersion: row.version,
        publishedAt: row.published_at?.toISOString() ?? null,
        score10Base: row.jsonb_data.score10Base,
        score10Proposed: row.jsonb_data.score10Proposed,
        score10Published: row.jsonb_data.score10Published,
        capsApplied: row.jsonb_data.capsApplied,
        penaltiesApplied: row.jsonb_data.penaltiesApplied,
        complianceFlags: row.jsonb_data.complianceFlags,
        integrityFlags: row.jsonb_data.integrityFlags,
        reviewStatus: row.jsonb_data.review.status,
        complianceStatus: row.jsonb_data.complianceReview.status,
      }));
    });
  }

  /**
   * Решение человека. Подтверждение потолков переносит предложенный балл в
   * публикуемый; отказ оставляет базовый. Решение по комплаенсу открывает или
   * закрывает публикацию листинга. Факт решения пишется в журнал прогона и в
   * аудит: автоматическое решение по суждению модели, затрагивающее права
   * заявителя, здесь заменяется решением человека (ADR-008 §4).
   */
  async decideReview(
    ctx: RequestContext,
    passportId: string,
    decision: 'confirm' | 'reject' | 'allow' | 'block',
    reason: string,
  ): Promise<ScoringReviewItem> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        project_id: string;
        title: string;
        version: number;
        published_at: Date | null;
        jsonb_data: StoredPassport;
        sources: { type: string; ref: string }[];
      }>(
        `SELECT p.id, p.project_id, pr.title, p.version, p.published_at, p.jsonb_data, p.sources
           FROM scoring.investment_passports p
           JOIN lab.projects pr ON pr.id = p.project_id
          WHERE p.id = $1 AND p.superseded_at IS NULL
          FOR UPDATE OF p`,
        [passportId],
      );
      const row = rows[0];
      if (!row) throw errors.notFound({ subject: 'investment_passport' });
      const now = new Date().toISOString();
      const data: StoredPassport = { ...row.jsonb_data };
      if (decision === 'confirm' || decision === 'reject') {
        if (data.review.status !== 'pending') {
          throw errors.stateTransition('По потолкам этого паспорта решение уже принято');
        }
        data.review = {
          status: decision === 'confirm' ? 'confirmed' : 'rejected',
          decidedBy: ctx.userId,
          decidedAt: now,
        };
        data.score10Published = decision === 'confirm' ? data.score10Proposed : data.score10Base;
      } else {
        if (data.complianceReview.status !== 'pending') {
          throw errors.stateTransition('По флагам комплаенса этого паспорта решение уже принято');
        }
        data.complianceReview = {
          status: decision === 'allow' ? 'allowed' : 'blocked',
          decidedBy: ctx.userId,
          decidedAt: now,
        };
      }
      await tx.query(
        `UPDATE scoring.investment_passports SET jsonb_data = $2::jsonb WHERE id = $1`,
        [passportId, JSON.stringify(data)],
      );
      const runRef = row.sources.find((s) => s.type === 'analysis_run')?.ref ?? null;
      if (runRef) {
        await tx.query(
          `INSERT INTO audit.node_checkpoints (id, run_id, node_name, state_jsonb)
           VALUES ($1, $2, 'human_review', $3::jsonb)`,
          [
            uuidv7(),
            runRef,
            JSON.stringify({ decision, reason, decidedBy: ctx.userId, decidedAt: now }),
          ],
        );
      }
      await this.audit.emit(tx, {
        verb: 'admin.scoring_review.decided',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'investment_passport',
        subjectId: passportId,
        context: { projectId: row.project_id, decision, reason },
        traceId: ctx.traceId,
      });
      return {
        passportId: row.id,
        projectId: row.project_id,
        projectTitle: row.title,
        passportVersion: row.version,
        publishedAt: row.published_at?.toISOString() ?? null,
        score10Base: data.score10Base,
        score10Proposed: data.score10Proposed,
        score10Published: data.score10Published,
        capsApplied: data.capsApplied,
        penaltiesApplied: data.penaltiesApplied,
        complianceFlags: data.complianceFlags,
        integrityFlags: data.integrityFlags,
        reviewStatus: data.review.status,
        complianceStatus: data.complianceReview.status,
      };
    });
  }

  /** Запись в журнал прогона отдельной транзакцией — переживает откат основной. */
  private async journal(
    ctx: RequestContext,
    runId: string,
    node: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    await this.db.transaction(ctx, async (tx) => {
      await tx.query(
        `INSERT INTO audit.node_checkpoints (id, run_id, node_name, state_jsonb)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [uuidv7(), runId, node, JSON.stringify(state)],
      );
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
        `SELECT s.axis, s.value::text AS value, s.confidence_low::text AS confidence_low,
                s.confidence_high::text AS confidence_high, s.explanation, s.computed_at,
                s.sources, m.version AS model_version
           FROM scoring.scores s
           LEFT JOIN scoring.score_models m ON m.id = s.model_id
          WHERE s.passport_id = $1 ORDER BY s.axis`,
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

      // Язык показа — из профиля читателя, не из Accept-Language (ADR-008 §5).
      // Нет варианта на нужной локали — канонический текст плюс признак
      // translationPending. На чтении ничего не генерируется.
      const locale = await this.userLocale(tx, ctx);
      const texts = await this.localization.textsFor(tx, row.id, locale);
      const data: Record<string, unknown> = { ...row.jsonb_data };
      if (locale !== 'ru-RU') {
        if (texts) {
          Object.assign(data, {
            verdict: texts.verdict,
            strengths: texts.strengths,
            weaknesses: texts.weaknesses,
            risks: texts.risks,
            businessModel: texts.businessModel,
            askSanity: texts.askSanity,
            investorExit: texts.investorExit,
            locale,
          });
        } else {
          data.translationPending = true;
        }
      }
      // Сигнал безопасности не выходит в кабинет: его место в журнале.
      delete data.integrityFlags;
      delete data.discrepancies;

      return {
        id: row.id,
        projectId: row.project_id,
        version: row.version,
        disclosureTier: row.disclosure_tier,
        modelVersion: row.model_version,
        data,
        publishedAt: row.published_at?.toISOString() ?? null,
        scores: scores.rows.map((s) => ({
          axis: s.axis,
          value: Number(s.value),
          confidenceLow: Number(s.confidence_low),
          confidenceHigh: Number(s.confidence_high),
          explanation: texts?.explanations[s.axis] ?? s.explanation,
          computedAt: s.computed_at.toISOString(),
          sources: s.sources ?? [],
          // Версия модели самой оценки, а не паспорта: пересчёт одной оси
          // другой моделью обязан быть виден по этой оси, а не по всему
          // документу.
          modelVersion: s.model_version ?? row.model_version ?? 'unknown',
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
      const texts = await this.activeTexts(tx, ctx, projectId);
      return rows.map((r) => ({
        dimension: r.dimension,
        level: r.level,
        recommendations: texts?.recommendations[r.dimension] ?? r.recommendations,
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
      const texts =
        roadmap.generated_by === 'ai' ? await this.activeTexts(tx, ctx, projectId) : null;
      return {
        id: roadmap.id,
        projectId: roadmap.project_id,
        generatedBy: roadmap.generated_by,
        isActive: roadmap.is_active,
        createdAt: roadmap.created_at.toISOString(),
        steps: steps.rows.map((s, index) => ({
          id: s.id,
          title: texts?.roadmap[index]?.title ?? s.title,
          description: texts?.roadmap[index]?.description ?? s.description,
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

  /** Локаль читателя — из профиля. Аноним и служебный контекст — канонический язык. */
  private async userLocale(tx: Tx, ctx: RequestContext): Promise<string> {
    if (!ctx.userId) return 'ru-RU';
    const { rows } = await tx.query<{ locale: string | null }>(
      `SELECT locale FROM identity.users WHERE id = $1`,
      [ctx.userId],
    );
    return rows[0]?.locale ?? 'ru-RU';
  }

  /** Перевод действующего паспорта проекта для локали читателя, если он есть. */
  private async activeTexts(tx: Tx, ctx: RequestContext, projectId: string) {
    const locale = await this.userLocale(tx, ctx);
    if (locale === 'ru-RU') return null;
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM scoring.investment_passports WHERE project_id = $1 AND superseded_at IS NULL`,
      [projectId],
    );
    const passportId = rows[0]?.id;
    return passportId ? this.localization.textsFor(tx, passportId, locale) : null;
  }

  /**
   * Два флага — два состояния продукта: скоринг эвристикой и скоринг моделью.
   * Второй без первого смысла не имеет; первый без второго — штатный режим.
   */
  private async assertScoringEnabled(
    ctx: RequestContext,
  ): Promise<{ llm: boolean; answersToModel: boolean }> {
    const flags = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ key: string; enabled: boolean }>(
        `SELECT key, enabled FROM audit.feature_flags
          WHERE key IN ('ai.scoring.enabled', 'ai.scoring.llm.enabled',
                        'ai.answers_to_model.allowed')`,
      );
      return Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
    });
    if (!flags['ai.scoring.enabled']) throw errors.featureDisabled('ai.scoring.enabled');
    return {
      llm: Boolean(flags['ai.scoring.llm.enabled']),
      answersToModel: Boolean(flags['ai.answers_to_model.allowed']),
    };
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
  investment_ask: string | null;
  ask_currency: string;
  geo_country: string | null;
  taxonomy_name: string | null;
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
    summary: string;
    stage: string;
    nonce: string;
    markersRemoved: number;
    metadata: AnalysisMetadata;
    sources: Record<string, string>;
    projectUpdatedAt: string;
    materials: { id: string; type: string; version: number }[];
    versionId: string | null;
    versionNo: number | null;
    includesAnswers: boolean;
    answers: AnalysisAnswer[];
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
  // Источники и версия модели входят в публичный контракт оценки: без них
  // клиент отбрасывает весь паспорт при разборе ответа, и человек видит
  // «паспорт недоступен» вместо посчитанных оценок.
  sources: { type: string; ref: string }[];
  model_version: string | null;
}

/**
 * Ответы ПОДАННОЙ версии заявки вместе с формулировками вопросов.
 *
 * Берётся последняя поданная версия: её снимок неизменяем (M004) и
 * самодостаточен — вопрос могли потом переписать или архивировать, а разбор
 * обязан описывать то, что человек видел и на что отвечал.
 *
 * Черновик заявки сюда не попадает намеренно. Он меняется в любую секунду, и
 * отчёт по нему нельзя привязать ни к какой версии: «тот же отчёт о той же
 * заявке» назавтра означал бы другой текст.
 *
 * Пусто (null) — заявка ещё не подана. Тогда разбор идёт по карточке проекта,
 * и называть его анализом версии заявки нельзя: это разные вещи, и вызывающий
 * об этом узнаёт по `includesAnswers`.
 */
async function loadSubmittedAnswers(tx: Tx, projectId: string): Promise<SubmittedAnswers | null> {
  const { rows } = await tx.query<{ id: string; version_no: number; snapshot_jsonb: unknown }>(
    `SELECT id, version_no, snapshot_jsonb FROM lab.project_versions
      WHERE project_id = $1 ORDER BY version_no DESC LIMIT 1`,
    [projectId],
  );
  const row = rows[0];
  if (!row) return null;

  // Разбор снимка делает общий модуль `buildAnalysisInput`: здесь только
  // чтение. Два места, знающих форму снимка, однажды разошлись бы.
  return {
    versionId: row.id,
    versionNo: row.version_no,
    snapshot: (row.snapshot_jsonb ?? {}) as SubmittedSnapshot,
  };
}

interface SubmittedAnswers {
  versionId: string;
  versionNo: number;
  snapshot: SubmittedSnapshot;
}

export interface AnalysisRunView {
  runId: string;
  projectId: string;
  status: 'succeeded';
  /**
   * Отпечаток входа, по которому сделан разбор.
   *
   * Возвращается вместе с результатом, а не вычитывается потом из снимка:
   * снимок лежит в `audit.node_checkpoints`, а его читает только
   * администратор. Вызывающему, который обязан связать отчёт с версией
   * заявки, отпечаток нужен здесь и сейчас.
   */
  inputSha256: string;
  /** Версия заявки, ответы которой участвовали; null — ответов в разборе нет. */
  inputVersionId: string | null;
  inputVersionNo: number | null;
  /** Участвовали ли ответы анкеты. false — отчёт описывает карточку проекта. */
  includesAnswers: boolean;
  provider: string;
  isLlm: boolean;
  modelVersion: string;
  passportVersion: number;
  passportId: string;
  irs: number;
  irsDelta: number | null;
  /** Публикуемый балл 1–10 и состояние решения человека по потолкам. */
  score10: number;
  reviewStatus: 'none' | 'pending' | 'confirmed' | 'rejected';
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
    sources: { type: string; ref: string }[];
    modelVersion: string;
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
