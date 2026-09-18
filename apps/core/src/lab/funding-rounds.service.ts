import { Injectable } from '@nestjs/common';
import {
  FUNDING_ROUND_TRANSITIONS,
  buildAnswersSchema,
  computeRoundReadiness,
  sectionScope,
  uuidv7,
  type ChangeFundingRoundBasisRequest,
  type CloseFundingRoundRequest,
  type CreateFundingRoundRequest,
  type FundingRound,
  type FundingRoundBasisHistoryEntry,
  type FundingRoundDetail,
  type FundingRoundReadiness,
  type FundingRoundStatus,
  type OpenFundingRoundRequest,
  type ProjectStage,
  type ServiceCountryPolicy,
  type UpdateFundingRoundRequest,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { ServiceCountriesService } from '../billing/service-countries.service';
import { loadFormConfig } from './application-forms.service';
import {
  activeSchemaVersion,
  evidenceIds,
  foreignEvidence,
  recomputeProjectProjection,
} from './applications.service';

/**
 * Раунд привлечения (план 0.2 §0г, заявка-03 §2.5; таблицы M081, глаголы M082).
 *
 * Раунд — конкретное привлечение: сумма, условия и основание в виде
 * поданной версии профиля. Правила, которые держит сервис:
 *
 *  1. ПРОФИЛЬ ЖИВЁТ БЕЗ РАУНДА. Черновик раунда создаётся пустым и
 *     предзаполняется из заявки (черновики v1 хранили сумму и вопросы
 *     раунда), но профиль подаётся и показывается без него.
 *  2. ОТКРЫТЬ можно только готовый раунд: сумма, валюта из разрешённых
 *     условиями страны аккаунта, предмет финансирования, основание —
 *     поданная версия того же проекта, обязательные вопросы раздела раунда
 *     для стадии основания. Готовность раунда — отдельный показатель, не
 *     часть полноты профиля.
 *  3. ОДНА НЕЗАВЕРШЁННАЯ КАМПАНИЯ на проект (open или paused) и один
 *     черновик — держит БД индексами; сервис лишь объясняет отказ.
 *  4. СМЕНА ОСНОВАНИЯ — тем же раундом с историей; у незавершённого раунда
 *     новая версия обязана проходить готовность по своей стадии, иначе отказ
 *     с перечнем и советом сначала поставить раунд на паузу.
 *  5. КОММЕРЧЕСКОЕ (пакеты, оплата, учёт бесплатной границы) — не здесь:
 *     страна и версия условий фиксируются при открытии как снимок.
 *
 * Границу «своё/чужое» держит RLS (M081); внешним ролям раунд до этапа 5.7
 * не виден вовсе.
 */
@Injectable()
export class FundingRoundsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly countries: ServiceCountriesService,
  ) {}

  async listForProject(ctx: RequestContext, projectId: string): Promise<FundingRound[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<RoundRow>(
        `SELECT ${ROUND_COLUMNS} FROM lab.funding_rounds
          WHERE project_id = $1
          ORDER BY created_at DESC`,
        [projectId],
      );
      return rows.map(mapRound);
    });
  }

  /**
   * Черновик раунда. Если он уже есть — возвращается он же: действие «Открыть
   * раунд привлечения» продолжает начатое (текущее ограничение первого
   * интерфейса — один черновик на проект, план 0.2 §0г.2 п.9).
   */
  async createDraft(
    ctx: RequestContext,
    projectId: string,
    input: CreateFundingRoundRequest,
  ): Promise<FundingRoundDetail> {
    return this.db.transaction(ctx, async (tx) => {
      await lockProject(tx, projectId);
      const project = await tx.query<{ id: string }>(
        `SELECT id FROM lab.projects WHERE id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      if (!project.rows[0]) throw errors.notFound({ subject: 'project' });

      const existing = await tx.query<RoundRow>(
        `SELECT ${ROUND_COLUMNS} FROM lab.funding_rounds WHERE project_id = $1 AND status = 'draft'`,
        [projectId],
      );
      if (existing.rows[0]) return this.detail(tx, mapRound(existing.rows[0]));

      if (input.applicationVersionId) {
        await assertVersionOfProject(tx, projectId, input.applicationVersionId);
      }
      const seed = await prefillFromApplication(tx, projectId);
      const schemaVersion = await activeSchemaVersion(tx);
      const id = uuidv7();
      const { rows } = await tx.query<RoundRow>(
        `INSERT INTO lab.funding_rounds
           (id, project_id, application_version_id, schema_version, status, funding_scope,
            funding_scope_note, target, currency, answers_jsonb, evidence_jsonb, created_by)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7::numeric, $8, $9::jsonb, $10::jsonb, $11)
         RETURNING ${ROUND_COLUMNS}`,
        [
          id,
          projectId,
          input.applicationVersionId ?? null,
          schemaVersion,
          seed.fundingScope,
          seed.fundingScopeNote,
          seed.target,
          seed.currency,
          JSON.stringify(seed.answers),
          JSON.stringify(seed.evidence),
          ctx.userId,
        ],
      );
      await this.audit.emit(tx, {
        verb: 'lab.funding_round.created',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'funding_round',
        subjectId: id,
        context: { projectId, schemaVersion, prefilled: seed.prefilled },
        traceId: ctx.traceId,
      });
      if (input.applicationVersionId) {
        await this.writeBasisHistory(
          tx,
          ctx,
          id,
          null,
          input.applicationVersionId,
          'основание при создании',
        );
      }
      return this.detail(tx, mapRound(rows[0]!));
    });
  }

  async get(ctx: RequestContext, roundId: string): Promise<FundingRoundDetail> {
    return this.db.readOnly(ctx, async (tx) => this.detail(tx, await this.load(tx, roundId)));
  }

  /** Частичное сохранение, как у заявки: `null` очищает, отсутствие не трогает. */
  async update(
    ctx: RequestContext,
    roundId: string,
    input: UpdateFundingRoundRequest,
  ): Promise<FundingRoundDetail> {
    if (Object.keys(input).length === 0) {
      throw errors.validation([{ path: '(корень)', message: 'нет полей для изменения' }]);
    }
    return this.db.transaction(ctx, async (tx) => {
      const current = await this.load(tx, roundId);
      if (current.status === 'closed' || current.status === 'cancelled') {
        throw errors.stateTransition('Раунд завершён: его нельзя изменить');
      }

      const sets: string[] = [];
      const params: unknown[] = [roundId];
      const set = (column: string, value: unknown, cast = '') => {
        params.push(value);
        sets.push(`${column} = $${params.length}${cast}`);
      };
      if (input.fundingScope !== undefined) set('funding_scope', input.fundingScope);
      if (input.fundingScopeNote !== undefined) set('funding_scope_note', input.fundingScopeNote);
      if (input.target !== undefined) {
        if (
          (current.status === 'open' || current.status === 'paused') &&
          input.target !== null &&
          current.target !== null &&
          Number(input.target) > Number(current.target)
        ) {
          // Увеличение суммы незавершённого раунда — коммерческое действие
          // (план 0.2 §0г, реестр: границы оплаченного раунда): проходит тот же
          // гейт, что открытие и возобновление.
          const policy = current.serviceCountry
            ? await this.countries.activePolicy(tx, current.serviceCountry)
            : null;
          if (!policy) {
            throw errors.stateTransition('Для страны раунда нет действующих условий');
          }
          assertCommercialConditions(policy, 'increase');
        }
        set('target', input.target, '::numeric');
      }
      if (input.currency !== undefined) set('currency', input.currency);
      if (input.investorMode !== undefined) set('investor_mode', input.investorMode);
      if (input.ticketMin !== undefined) set('ticket_min', input.ticketMin, '::numeric');
      if (input.ticketMax !== undefined) set('ticket_max', input.ticketMax, '::numeric');
      if (input.committed !== undefined) set('committed', input.committed, '::numeric');
      if (input.answers !== undefined) {
        // Ответы — только вопросы разделов раунда формы версии раунда.
        const form = await loadFormConfig(tx, current.schemaVersion);
        const roundKeys = new Set(
          form.questions
            .filter((q) => {
              const section = form.sections.find((s) => s.key === q.section);
              return section !== undefined && sectionScope(section) === 'round' && !q.coreField;
            })
            .map((q) => q.key),
        );
        const foreignKeys = Object.keys(input.answers).filter((k) => !roundKeys.has(k));
        if (foreignKeys.length > 0) {
          throw errors.validation(
            foreignKeys.map((k) => ({
              path: `answers.${k}`,
              message: 'вопрос не относится к раунду',
            })),
          );
        }
        const parsed = buildAnswersSchema(form).safeParse(input.answers);
        if (!parsed.success) {
          throw errors.validation(
            parsed.error.issues.map((issue) => ({
              path: `answers.${issue.path.join('.') || '(корень)'}`,
              message: issue.message,
            })),
          );
        }
        params.push(JSON.stringify(input.answers));
        sets.push(`answers_jsonb = answers_jsonb || $${params.length}::jsonb`);
      }
      if (input.evidence !== undefined) {
        const wanted = evidenceIds(input.evidence);
        const owned =
          wanted.length === 0
            ? []
            : (
                await tx.query<{ id: string }>(
                  `SELECT id FROM lab.project_materials
                    WHERE project_id = $1 AND id = ANY($2::uuid[]) AND uploaded_at IS NOT NULL`,
                  [current.projectId, wanted],
                )
              ).rows.map((r) => r.id);
        const foreign = foreignEvidence(input.evidence, owned);
        if (foreign.length > 0) throw errors.validation(foreign);
        params.push(JSON.stringify(input.evidence));
        sets.push(`evidence_jsonb = evidence_jsonb || $${params.length}::jsonb`);
      }

      const { rows } = await tx.query<RoundRow>(
        `UPDATE lab.funding_rounds SET ${sets.join(', ')} WHERE id = $1 RETURNING ${ROUND_COLUMNS}`,
        params,
      );
      const row = rows[0];
      if (!row) throw errors.notFound({ subject: 'funding_round' });
      await this.audit.emit(tx, {
        verb: 'lab.funding_round.updated',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'funding_round',
        subjectId: roundId,
        context: { fields: Object.keys(input) },
        traceId: ctx.traceId,
      });
      // Сумма незавершённого раунда — кеш проекта (каталог, совместимость).
      if (row.status === 'open' || row.status === 'paused') {
        await recomputeProjectProjection(tx, current.projectId);
      }
      return this.detail(tx, mapRound(row));
    });
  }

  /**
   * Открытие: страна обслуживания аккаунта и её действующие условия
   * фиксируются в раунде как снимок; валюта — из разрешённых; основание —
   * поданная версия того же проекта; готовность по стадии основания.
   */
  async open(
    ctx: RequestContext,
    roundId: string,
    input: OpenFundingRoundRequest,
  ): Promise<FundingRoundDetail> {
    return this.transition(ctx, roundId, 'open', async (tx, round) => {
      if (round.status !== 'draft') return; // resume — отдельное действие
      // Подтверждение версии условий (5.7.3): владелец видел предпросмотр по
      // активной версии; если она сменилась — повторный просмотр, не открытие.
      const activeVersion = await activeSchemaVersion(tx);
      if (input.confirmDisclosureVersion !== activeVersion) {
        throw errors.conflict(
          'Условия раскрытия изменились после предпросмотра: откройте предпросмотр раунда заново',
          { seen: input.confirmDisclosureVersion, active: activeVersion },
        );
      }
      const missing: { path: string; message: string }[] = [];
      const country = await this.countries.userCountry(tx, ctx.userId);
      if (!country) {
        missing.push({
          path: 'serviceCountry',
          message: 'выберите страну обслуживания аккаунта — от неё зависят условия привлечения',
        });
      }
      const policy = country ? await this.countries.activePolicy(tx, country) : null;
      if (country && !policy) {
        missing.push({ path: 'serviceCountry', message: 'для страны нет действующих условий' });
      }
      if (
        policy &&
        round.currency &&
        !policy.config.allowedRoundCurrencies.includes(round.currency)
      ) {
        missing.push({
          path: 'currency',
          message: `валюта ${round.currency} недоступна: разрешены ${policy.config.allowedRoundCurrencies.join(', ')}`,
        });
      }
      if (
        policy?.config.limits.maxTargetPerRound &&
        round.target &&
        Number(round.target) > Number(policy.config.limits.maxTargetPerRound)
      ) {
        missing.push({
          path: 'target',
          message: `сумма раунда не может превышать ${policy.config.limits.maxTargetPerRound}`,
        });
      }
      if (!round.applicationVersionId) {
        missing.push({
          path: 'applicationVersionId',
          message: 'укажите поданную версию профиля как основание',
        });
      }
      const readiness = await this.readiness(tx, round);
      missing.push(...readiness.missing);
      if (missing.length > 0) throw errors.validation(missing);
      assertCommercialConditions(policy!, 'open');

      await tx.query(
        `UPDATE lab.funding_rounds
            SET status = 'open', opened_at = now(), service_country = $2, policy_version = $3,
                -- Версия условий раскрытия фиксируется при открытии (M086):
                -- расширение публичности потом этот раунд не затронет.
                disclosure_version = (SELECT version FROM lab.application_form_versions
                                       WHERE is_active LIMIT 1)
          WHERE id = $1`,
        [roundId, country, policy!.version],
      );
    });
  }

  async pause(ctx: RequestContext, roundId: string): Promise<FundingRoundDetail> {
    return this.transition(ctx, roundId, 'paused', async (tx) => {
      await tx.query(
        `UPDATE lab.funding_rounds SET status = 'paused', paused_at = now() WHERE id = $1`,
        [roundId],
      );
    });
  }

  async resume(ctx: RequestContext, roundId: string): Promise<FundingRoundDetail> {
    return this.transition(ctx, roundId, 'open', async (tx, round) => {
      if (round.status !== 'paused')
        throw errors.stateTransition('Возобновить можно только приостановленный раунд');
      // Возобновление проходит те же коммерческие условия, что открытие:
      // иначе «пауза → возобновление» стало бы обходом оплаты в 5.9.
      const policy = round.serviceCountry
        ? await this.countries.activePolicy(tx, round.serviceCountry)
        : null;
      if (!policy) {
        throw errors.stateTransition(
          'Для страны раунда нет действующих условий: возобновление недоступно',
        );
      }
      assertCommercialConditions(policy, 'resume');
      await tx.query(
        `UPDATE lab.funding_rounds SET status = 'open', paused_at = NULL WHERE id = $1`,
        [roundId],
      );
    });
  }

  /** Закрытие — с причиной; обязательства по сделкам не затрагиваются. */
  async close(
    ctx: RequestContext,
    roundId: string,
    input: CloseFundingRoundRequest,
  ): Promise<FundingRoundDetail> {
    return this.transition(ctx, roundId, 'closed', async (tx) => {
      await tx.query(
        `UPDATE lab.funding_rounds SET status = 'closed', closed_at = now(), close_reason = $2 WHERE id = $1`,
        [roundId, input.closeReason],
      );
    });
  }

  async cancel(ctx: RequestContext, roundId: string): Promise<FundingRoundDetail> {
    return this.transition(ctx, roundId, 'cancelled', async (tx) => {
      await tx.query(
        `UPDATE lab.funding_rounds SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
        [roundId],
      );
    });
  }

  /**
   * Смена основания — тем же раундом с историей (заявка-03 §2.5). У
   * незавершённого раунда новая версия обязана проходить готовность по своей
   * стадии: иначе отказ с перечнем и советом сначала поставить раунд на паузу.
   */
  async changeBasis(
    ctx: RequestContext,
    roundId: string,
    input: ChangeFundingRoundBasisRequest,
  ): Promise<FundingRoundDetail> {
    return this.db.transaction(ctx, async (tx) => {
      const round = await this.load(tx, roundId);
      if (round.status === 'closed' || round.status === 'cancelled') {
        throw errors.stateTransition('Раунд завершён: основание не меняется');
      }
      await assertVersionOfProject(tx, round.projectId, input.applicationVersionId);
      if (round.status === 'open' || round.status === 'paused') {
        const readiness = await this.readiness(tx, {
          ...round,
          applicationVersionId: input.applicationVersionId,
        });
        if (!readiness.canOpen) {
          throw errors.validation([
            {
              path: 'applicationVersionId',
              message:
                'по стадии новой версии раунд не готов: ' +
                readiness.missing.map((m) => m.path).join(', ') +
                '. Поставьте раунд на паузу и дозаполните, либо выберите другую версию',
            },
            ...readiness.missing,
          ]);
        }
      }
      await tx.query(`UPDATE lab.funding_rounds SET application_version_id = $2 WHERE id = $1`, [
        roundId,
        input.applicationVersionId,
      ]);
      await this.writeBasisHistory(
        tx,
        ctx,
        roundId,
        round.applicationVersionId,
        input.applicationVersionId,
        input.reason,
      );
      await this.audit.emit(tx, {
        verb: 'lab.funding_round.basis_changed',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'funding_round',
        subjectId: roundId,
        context: {
          from: round.applicationVersionId,
          to: input.applicationVersionId,
          reason: input.reason,
        },
        traceId: ctx.traceId,
      });
      return this.detail(tx, await this.load(tx, roundId));
    });
  }

  async basisHistory(
    ctx: RequestContext,
    roundId: string,
  ): Promise<FundingRoundBasisHistoryEntry[]> {
    return this.db.readOnly(ctx, async (tx) => {
      await this.load(tx, roundId);
      const { rows } = await tx.query<HistoryRow>(
        `SELECT id, round_id, from_version_id, to_version_id, changed_by, changed_at, reason
           FROM lab.funding_round_basis_history WHERE round_id = $1 ORDER BY changed_at, id`,
        [roundId],
      );
      return rows.map((r) => ({
        id: r.id,
        roundId: r.round_id,
        fromVersionId: r.from_version_id,
        toVersionId: r.to_version_id,
        changedBy: r.changed_by,
        changedAt: r.changed_at.toISOString(),
        reason: r.reason,
      }));
    });
  }

  // ------------------------------------------------------------------ helpers

  /** Общий каркас перехода: лок проекта, проверка перехода, событие в outbox, проекция. */
  private async transition(
    ctx: RequestContext,
    roundId: string,
    to: FundingRoundStatus,
    apply: (tx: Tx, round: FundingRound) => Promise<void>,
  ): Promise<FundingRoundDetail> {
    return this.db.transaction(ctx, async (tx) => {
      const probe = await this.load(tx, roundId);
      await lockProject(tx, probe.projectId);
      const round = await this.load(tx, roundId);
      if (round.status === to) return this.detail(tx, round); // идемпотентно
      if (!FUNDING_ROUND_TRANSITIONS[round.status].includes(to)) {
        throw errors.stateTransition(`Переход ${round.status} → ${to} невозможен`);
      }
      try {
        await apply(tx, round);
      } catch (e) {
        if (isUnfinishedConflict(e)) {
          throw errors.conflict(
            'У проекта уже есть незавершённый раунд (открытый или приостановленный): закройте или отмените его',
          );
        }
        throw e;
      }
      const verb = VERB_BY_TRANSITION[`${round.status}→${to}`] ?? `lab.funding_round.${to}`;
      const aggregateVersion = await this.audit.nextAggregateVersion(
        tx,
        'funding_round',
        roundId,
        verb,
      );
      await this.audit.record(tx, {
        verb,
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        aggregateType: 'funding_round',
        aggregateId: roundId,
        aggregateVersion,
        payload: {
          projectId: round.projectId,
          from: round.status,
          to,
          commercial: COMMERCIAL_MODE,
        },
        traceId: ctx.traceId,
      });
      await recomputeProjectProjection(tx, round.projectId);
      return this.detail(tx, await this.load(tx, roundId));
    });
  }

  private async detail(tx: Tx, round: FundingRound): Promise<FundingRoundDetail> {
    return { round, readiness: await this.readiness(tx, round) };
  }

  /** Готовность по стадии основания; у черновика без основания — по текущей заявке проекта. */
  private async readiness(tx: Tx, round: FundingRound): Promise<FundingRoundReadiness> {
    const form = await loadFormConfig(tx, round.schemaVersion);
    const stage = await stageFor(tx, round);
    return computeRoundReadiness(form, stage, {
      fundingScope: round.fundingScope,
      fundingScopeNote: round.fundingScopeNote,
      target: round.target,
      currency: round.currency,
      answers: round.answers,
      evidence: round.evidence,
    });
  }

  private async load(tx: Tx, roundId: string): Promise<FundingRound> {
    const { rows } = await tx.query<RoundRow>(
      `SELECT ${ROUND_COLUMNS} FROM lab.funding_rounds WHERE id = $1`,
      [roundId],
    );
    const row = rows[0];
    if (!row) throw errors.notFound({ subject: 'funding_round' });
    return mapRound(row);
  }

  private async writeBasisHistory(
    tx: Tx,
    ctx: RequestContext,
    roundId: string,
    from: string | null,
    to: string,
    reason: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO lab.funding_round_basis_history (id, round_id, from_version_id, to_version_id, changed_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv7(), roundId, from, to, ctx.userId, reason],
    );
  }
}

/**
 * Временный режим коммерческих условий до пакетов раунда (этап 5.9, план 0.2
 * §0г.2 п.2–3): открытие, возобновление и увеличение суммы бесплатны, пока в
 * условиях страны выключены и платные пакеты, и бесплатная граница. Это ОДНО
 * место проверки: в 5.9 сюда встанет расчёт пакета и оплаты, и ни один из
 * трёх маршрутов не станет обходом. Включённая, но не реализованная
 * настройка — отказ (fail-closed), а не молчаливое «бесплатно».
 */
export const COMMERCIAL_MODE = 'free_until_packages' as const;

export function assertCommercialConditions(
  policy: { version: number; config: ServiceCountryPolicy },
  action: 'open' | 'resume' | 'increase',
): typeof COMMERCIAL_MODE {
  if (policy.config.paidPackages.enabled) {
    throw errors.validation([
      {
        path: 'serviceCountry',
        message: `платные пакеты раунда включены в условиях страны (версия ${policy.version}), но ещё не реализованы: действие «${action}» недоступно`,
      },
    ]);
  }
  if (policy.config.freeAttraction.enabled) {
    throw errors.validation([
      {
        path: 'serviceCountry',
        message: `бесплатная граница включена в условиях страны (версия ${policy.version}), но учёт ещё не реализован: действие «${action}» недоступно`,
      },
    ]);
  }
  return COMMERCIAL_MODE;
}

const VERB_BY_TRANSITION: Record<string, string> = {
  'draft→open': 'lab.funding_round.opened',
  'paused→open': 'lab.funding_round.resumed',
  'open→paused': 'lab.funding_round.paused',
  'open→closed': 'lab.funding_round.closed',
  'paused→closed': 'lab.funding_round.closed',
  'draft→cancelled': 'lab.funding_round.cancelled',
  'open→cancelled': 'lab.funding_round.cancelled',
  'paused→cancelled': 'lab.funding_round.cancelled',
};

async function lockProject(tx: Tx, projectId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `project-write:${projectId}`,
  ]);
}

async function assertVersionOfProject(tx: Tx, projectId: string, versionId: string): Promise<void> {
  const { rows } = await tx.query(
    `SELECT 1 FROM lab.project_versions WHERE id = $1 AND project_id = $2`,
    [versionId, projectId],
  );
  if (rows.length === 0) {
    throw errors.validation([
      {
        path: 'applicationVersionId',
        message: 'версия профиля не принадлежит проекту или не подана',
      },
    ]);
  }
}

/** Стадия для готовности: из снимка основания, иначе — текущей заявки проекта. */
async function stageFor(tx: Tx, round: FundingRound): Promise<ProjectStage> {
  if (round.applicationVersionId) {
    const { rows } = await tx.query<{ stage: string | null }>(
      `SELECT snapshot_jsonb->'core'->>'stage' AS stage FROM lab.project_versions WHERE id = $1`,
      [round.applicationVersionId],
    );
    if (rows[0]?.stage) return rows[0].stage as ProjectStage;
  }
  const { rows } = await tx.query<{ stage: string }>(
    `SELECT a.stage FROM lab.investment_applications a
      WHERE a.project_id = $1 AND a.status <> 'archived'
      ORDER BY (a.status = 'submitted') DESC, a.submitted_at DESC NULLS LAST, a.created_at DESC
      LIMIT 1`,
    [round.projectId],
  );
  return (rows[0]?.stage ?? 'idea') as ProjectStage;
}

/**
 * Заготовка раунда из заявки проекта: черновики и снимки v1 хранили сумму,
 * предмет финансирования и ответы вопросов раунда в самой заявке
 * (заявка-03 §2.7). Берётся последняя незаархивированная заявка; из ответов —
 * только ключи разделов раунда формы её версии. Заявка не переписывается.
 */
async function prefillFromApplication(
  tx: Tx,
  projectId: string,
): Promise<{
  fundingScope: string | null;
  fundingScopeNote: string | null;
  target: string | null;
  currency: string | null;
  answers: Record<string, unknown>;
  evidence: Record<string, string[]>;
  prefilled: boolean;
}> {
  const { rows } = await tx.query<{
    schema_version: number;
    funding_scope: string | null;
    funding_scope_note: string | null;
    investment_ask: string | null;
    ask_currency: string;
    answers_jsonb: Record<string, unknown>;
    evidence_jsonb: Record<string, string[]>;
  }>(
    `SELECT schema_version, funding_scope, funding_scope_note, investment_ask::text AS investment_ask,
            ask_currency, answers_jsonb, evidence_jsonb
       FROM lab.investment_applications
      WHERE project_id = $1 AND status <> 'archived' AND schema_version > 0
      ORDER BY (status = 'submitted') DESC, submitted_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [projectId],
  );
  const app = rows[0];
  if (!app) {
    return {
      fundingScope: null,
      fundingScopeNote: null,
      target: null,
      currency: null,
      answers: {},
      evidence: {},
      prefilled: false,
    };
  }
  const form = await loadFormConfig(tx, app.schema_version);
  const roundKeys = new Set(
    form.questions
      .filter((q) => {
        const section = form.sections.find((s) => s.key === q.section);
        return section !== undefined && sectionScope(section) === 'round' && !q.coreField;
      })
      .map((q) => q.key),
  );
  const answers: Record<string, unknown> = {};
  const evidence: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(app.answers_jsonb ?? {})) {
    if (roundKeys.has(key)) answers[key] = value;
  }
  for (const [key, ids] of Object.entries(app.evidence_jsonb ?? {})) {
    if (roundKeys.has(key)) evidence[key] = ids;
  }
  return {
    fundingScope: app.funding_scope,
    fundingScopeNote: app.funding_scope_note,
    target: app.investment_ask,
    currency: app.investment_ask ? app.ask_currency.trim() : null,
    answers,
    evidence,
    prefilled: true,
  };
}

function isUnfinishedConflict(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string };
  return err?.code === '23505' && err?.constraint === 'funding_rounds_one_unfinished';
}

function actorRole(ctx: RequestContext): string {
  return ctx.roles.includes('admin') ? 'admin' : 'founder';
}

const ROUND_COLUMNS = `
  id, project_id, application_version_id, schema_version, status, funding_scope,
  funding_scope_note, target::text AS target, currency, investor_mode,
  ticket_min::text AS ticket_min, ticket_max::text AS ticket_max, committed::text AS committed,
  committed_source, answers_jsonb, evidence_jsonb, service_country, policy_version, close_reason,
  created_at, updated_at, opened_at, paused_at, closed_at, cancelled_at`;

interface RoundRow {
  id: string;
  project_id: string;
  application_version_id: string | null;
  schema_version: number;
  status: FundingRoundStatus;
  funding_scope: FundingRound['fundingScope'];
  funding_scope_note: string | null;
  target: string | null;
  currency: string | null;
  investor_mode: FundingRound['investorMode'];
  ticket_min: string | null;
  ticket_max: string | null;
  committed: string;
  committed_source: 'self_reported';
  answers_jsonb: Record<string, unknown>;
  evidence_jsonb: Record<string, string[]>;
  service_country: string | null;
  policy_version: number | null;
  close_reason: FundingRound['closeReason'];
  created_at: Date;
  updated_at: Date;
  opened_at: Date | null;
  paused_at: Date | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
}

interface HistoryRow {
  id: string;
  round_id: string;
  from_version_id: string | null;
  to_version_id: string;
  changed_by: string | null;
  changed_at: Date;
  reason: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function mapRound(row: RoundRow): FundingRound {
  return {
    id: row.id,
    projectId: row.project_id,
    applicationVersionId: row.application_version_id,
    schemaVersion: row.schema_version,
    status: row.status,
    fundingScope: row.funding_scope,
    fundingScopeNote: row.funding_scope_note,
    target: row.target,
    currency: row.currency ? row.currency.trim() : null,
    investorMode: row.investor_mode,
    ticketMin: row.ticket_min,
    ticketMax: row.ticket_max,
    committed: row.committed,
    committedSource: row.committed_source,
    answers: row.answers_jsonb ?? {},
    evidence: row.evidence_jsonb ?? {},
    serviceCountry: row.service_country,
    policyVersion: row.policy_version,
    closeReason: row.close_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    openedAt: iso(row.opened_at),
    pausedAt: iso(row.paused_at),
    closedAt: iso(row.closed_at),
    cancelledAt: iso(row.cancelled_at),
  };
}

export type { ServiceCountryPolicy };
