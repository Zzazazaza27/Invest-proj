import { Injectable } from '@nestjs/common';
import {
  EventVerb,
  REVIEW_DISCREPANCY_THRESHOLD,
  RUBRIC_KEYS,
  uuidv7,
  type ExpertAssignment,
  type ExpertConflict,
  type ExpertReview,
  type ReviewConsensus,
  type SubmitReviewRequest,
} from '@unicorn/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { NotificationsService } from '../comms/notifications.service';
import { errors } from '../common/errors';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Экспертный совет.
 *
 * Три правила задают всю конструкцию модуля:
 *
 *  1. **Конфликт интересов сильнее назначения.** Заявленный и не разрешённый
 *     конфликт блокирует работу эксперта по проекту — это триггер в БД, а не
 *     проверка в сервисе: обойти её из другого пути кода нельзя.
 *  2. **Рецензия принадлежит эксперту.** Написать её может только тот, на кого
 *     назначение выписано, и только после того, как он его принял. Повторная
 *     рецензия невозможна — уникальность по назначению в схеме.
 *  3. **Решение принимает человек.** Расхождение оценок считает сервер, но
 *     финальный вердикт подписывает организатор своим идентификатором из
 *     контекста запроса. При слишком большом расхождении вердикт без третьего
 *     рецензента не принимается вовсе.
 */
@Injectable()
export class ExpertsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------- назначения

  /** Назначения текущего эксперта. Чужие не видны ни здесь, ни на уровне RLS. */
  async myAssignments(ctx: RequestContext): Promise<ExpertAssignment[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<AssignmentRow>(
        `SELECT a.id, a.project_id, p.title, a.status, a.due_at, a.created_at
           FROM experts.expert_assignments a
           JOIN lab.projects p ON p.id = a.project_id
          WHERE a.expert_id = $1
          ORDER BY a.due_at ASC
          LIMIT 200`,
        [ctx.userId],
      );
      return rows.map(mapAssignment);
    });
  }

  /**
   * Назначить рецензентов. Только организатор: самоназначение эксперта на
   * интересный ему проект — это и есть конфликт интересов в чистом виде.
   */
  async assign(
    ctx: RequestContext,
    input: {
      projectId: string;
      expertIds: string[];
      dueAt: string;
      reason: 'auto_taxonomy' | 'manual' | 'third_reviewer';
    },
  ): Promise<ExpertAssignment[]> {
    const due = new Date(input.dueAt);
    if (Number.isNaN(due.getTime()) || due.getTime() <= Date.now()) {
      throw errors.validation([{ path: 'dueAt', message: 'срок рецензии должен быть в будущем' }]);
    }
    const uniqueExperts = [...new Set(input.expertIds)];

    return this.db.transaction(ctx, async (tx) => {
      const project = await this.loadProject(tx, input.projectId);
      const actorRole = ctx.roles.includes('admin') ? 'admin' : 'organizer';
      const created: ExpertAssignment[] = [];

      for (const expertId of uniqueExperts) {
        const assignmentId = uuidv7();
        try {
          const { rows } = await tx.query<AssignmentRow>(
            `INSERT INTO experts.expert_assignments
               (id, project_id, expert_id, season_id, assigned_reason, due_at, assigned_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, project_id, status, due_at, created_at`,
            [
              assignmentId,
              input.projectId,
              expertId,
              project.seasonId,
              input.reason,
              input.dueAt,
              ctx.userId,
            ],
          );
          created.push(mapAssignment({ ...rows[0]!, title: project.title }));
        } catch (error) {
          throw this.translate(error);
        }

        await this.audit.record(tx, {
          verb: EventVerb.EXPERT_ASSIGNED,
          actorId: ctx.userId,
          actorRole,
          aggregateType: 'expert_assignment',
          aggregateId: assignmentId,
          aggregateVersion: 1,
          payload: { projectId: input.projectId, expertId, dueAt: input.dueAt },
          traceId: ctx.traceId,
        });

        await this.notifications.enqueue(tx, {
          userId: expertId,
          code: 'expert.assignment.created',
          payload: {
            project_title: project.title,
            due_at: input.dueAt,
            project_id: input.projectId,
          },
          dedupKey: `assignment:${assignmentId}`,
        });
      }

      return created;
    });
  }

  /**
   * Ответ эксперта на назначение.
   *
   * Решение принимается один раз: переигрывать «отказался» на «принял» после
   * того, как организатор нашёл замену, — значит получить двух рецензентов там,
   * где планировался один.
   */
  async decideAssignment(
    ctx: RequestContext,
    assignmentId: string,
    decision: 'accepted' | 'declined',
  ): Promise<ExpertAssignment> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<AssignmentRow & { expert_id: string }>(
        `SELECT a.id, a.project_id, a.expert_id, p.title, a.status, a.due_at, a.created_at
           FROM experts.expert_assignments a
           JOIN lab.projects p ON p.id = a.project_id
          WHERE a.id = $1
          FOR UPDATE OF a`,
        [assignmentId],
      );
      const current = rows[0];
      // Чужое назначение не видно политикой — ответ такой же, как для
      // несуществующего: разница между 403 и 404 выдавала бы состав рецензентов.
      if (!current || current.expert_id !== ctx.userId) {
        throw errors.notFound({ subject: 'assignment' });
      }
      if (current.status !== 'assigned') {
        throw errors.stateTransition('Решение по этому назначению уже принято');
      }

      const { rows: updated } = await tx.query<AssignmentRow>(
        `UPDATE experts.expert_assignments SET status = $2 WHERE id = $1
         RETURNING id, project_id, status, due_at, created_at`,
        [assignmentId, decision],
      );

      await this.audit.record(tx, {
        verb: EventVerb.EXPERT_ASSIGNMENT_CLOSED,
        actorId: ctx.userId,
        actorRole: 'expert',
        aggregateType: 'expert_assignment',
        aggregateId: assignmentId,
        aggregateVersion: 2,
        payload: { projectId: current.project_id, status: decision },
        traceId: ctx.traceId,
      });

      return mapAssignment({ ...updated[0]!, title: current.title });
    });
  }

  // ---------------------------------------------------------------- рецензии

  /**
   * Подать рецензию. Назначение переводится в `completed` той же транзакцией:
   * рецензия без закрытого назначения означала бы, что эксперту всё ещё
   * «нужно поработать» над тем, что он уже сделал.
   */
  async submitReview(ctx: RequestContext, input: SubmitReviewRequest): Promise<ExpertReview> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        project_id: string;
        expert_id: string;
        status: string;
      }>(
        `SELECT id, project_id, expert_id, status FROM experts.expert_assignments
          WHERE id = $1 FOR UPDATE`,
        [input.assignmentId],
      );
      const assignment = rows[0];
      if (!assignment || assignment.expert_id !== ctx.userId) {
        throw errors.notFound({ subject: 'assignment' });
      }
      if (assignment.status !== 'accepted') {
        throw errors.stateTransition(
          'Рецензию можно подать только по принятому и незавершённому назначению',
        );
      }

      let review: ExpertReview;
      try {
        const { rows: inserted } = await tx.query<ReviewRow>(
          `INSERT INTO experts.expert_reviews
             (id, assignment_id, rubric_scores_jsonb, comment, recommendation)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           RETURNING assignment_id, rubric_scores_jsonb, comment, recommendation, submitted_at`,
          [
            uuidv7(),
            input.assignmentId,
            JSON.stringify(input.rubricScores),
            input.comment ?? null,
            input.recommendation,
          ],
        );
        review = mapReview({ ...inserted[0]!, expert_id: ctx.userId! });
      } catch (error) {
        throw this.translate(error);
      }

      await tx.query(`UPDATE experts.expert_assignments SET status = 'completed' WHERE id = $1`, [
        input.assignmentId,
      ]);

      await this.audit.record(tx, {
        verb: EventVerb.EXPERT_REVIEW_SUBMITTED,
        actorId: ctx.userId,
        actorRole: 'expert',
        aggregateType: 'expert_assignment',
        aggregateId: input.assignmentId,
        aggregateVersion: 3,
        // Оценки в событие не кладутся: рубрики — внутренняя кухня совета,
        // наружу идёт факт рецензии и рекомендация.
        payload: { projectId: assignment.project_id, recommendation: input.recommendation },
        traceId: ctx.traceId,
      });

      return review;
    });
  }

  /** Сводка рецензий по проекту для организатора: сами оценки и их разброс. */
  async projectReviews(
    ctx: RequestContext,
    projectId: string,
  ): Promise<{ items: ExpertReview[]; discrepancyScore: number | null }> {
    return this.db.readOnly(ctx, async (tx) => {
      const items = await loadReviews(tx, projectId);
      return { items, discrepancyScore: discrepancy(items.map((r) => r.rubricScores)) };
    });
  }

  // --------------------------------------------------------------- конфликты

  /**
   * Декларация конфликта интересов. Заявляет её только сам эксперт и только за
   * себя: «заявить конфликт» за другого — это способ снять неудобного
   * рецензента с проекта.
   */
  async declareConflict(
    ctx: RequestContext,
    input: { projectId: string; description: string },
  ): Promise<ExpertConflict> {
    return this.db.transaction(ctx, async (tx) => {
      let conflict: ExpertConflict;
      try {
        const { rows } = await tx.query<ConflictRow>(
          `INSERT INTO experts.expert_conflict_declarations
             (id, expert_id, project_id, description)
           VALUES ($1, $2, $3, $4)
           RETURNING id, expert_id, project_id, description, resolution, created_at`,
          [uuidv7(), ctx.userId, input.projectId, input.description],
        );
        conflict = mapConflict(rows[0]!);
      } catch (error) {
        throw this.translate(error);
      }

      await this.audit.record(tx, {
        verb: EventVerb.EXPERT_CONFLICT_DECLARED,
        actorId: ctx.userId,
        actorRole: 'expert',
        aggregateType: 'expert_conflict',
        aggregateId: conflict.id,
        aggregateVersion: 1,
        payload: { projectId: input.projectId },
        traceId: ctx.traceId,
      });
      return conflict;
    });
  }

  async resolveConflict(
    ctx: RequestContext,
    conflictId: string,
    resolution: 'recused' | 'approved_with_disclosure',
  ): Promise<ExpertConflict> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<ConflictRow>(
        `UPDATE experts.expert_conflict_declarations
            SET resolution = $2, resolved_by = $3
          WHERE id = $1 AND resolution IS NULL
          RETURNING id, expert_id, project_id, description, resolution, created_at`,
        [conflictId, resolution, ctx.userId],
      );
      const conflict = rows[0];
      if (!conflict) throw errors.notFound({ subject: 'conflict' });

      await this.audit.record(tx, {
        verb: EventVerb.EXPERT_CONFLICT_RESOLVED,
        actorId: ctx.userId,
        actorRole: ctx.roles.includes('admin') ? 'admin' : 'organizer',
        aggregateType: 'expert_conflict',
        aggregateId: conflictId,
        aggregateVersion: 2,
        payload: { projectId: conflict.project_id, resolution },
        traceId: ctx.traceId,
      });
      return mapConflict(conflict);
    });
  }

  async listConflicts(ctx: RequestContext, projectId: string): Promise<ExpertConflict[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<ConflictRow>(
        `SELECT id, expert_id, project_id, description, resolution, created_at
           FROM experts.expert_conflict_declarations
          WHERE project_id = $1
          ORDER BY created_at DESC
          LIMIT 200`,
        [projectId],
      );
      return rows.map(mapConflict);
    });
  }

  // --------------------------------------------------------------- консенсус

  /**
   * Зафиксировать решение по проекту.
   *
   * Два условия, без которых решение не является решением: рецензий не меньше
   * двух и, если рецензенты разошлись сильнее порога, в деле есть третий
   * рецензент. Иначе «консенсус» — это подпись организатора под спором, о
   * котором в записи не останется следа.
   */
  async decideConsensus(
    ctx: RequestContext,
    input: {
      projectId: string;
      finalDecision: 'pass' | 'fail' | 'needs_review';
      thirdReviewerId?: string;
    },
  ): Promise<ReviewConsensus> {
    return this.db.transaction(ctx, async (tx) => {
      const project = await this.loadProject(tx, input.projectId);
      const reviews = await loadReviews(tx, input.projectId);
      if (reviews.length < 2) {
        throw errors.stateTransition(
          'Решение принимается не менее чем по двум рецензиям: одна оценка не даёт консенсуса',
        );
      }

      const score = discrepancy(reviews.map((r) => r.rubricScores));
      if (
        score !== null &&
        score > REVIEW_DISCREPANCY_THRESHOLD &&
        !input.thirdReviewerId &&
        reviews.length < 3
      ) {
        throw errors.stateTransition(
          `Расхождение оценок ${score} превышает порог ${REVIEW_DISCREPANCY_THRESHOLD}: ` +
            'требуется третий рецензент',
        );
      }

      const consensusId = uuidv7();
      const { rows } = await tx.query<ConsensusRow>(
        `INSERT INTO experts.review_consensus
           (id, project_id, season_id, discrepancy_score, third_reviewer_id,
            final_decision, decided_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, project_id, season_id, discrepancy_score, final_decision, decided_at`,
        [
          consensusId,
          input.projectId,
          project.seasonId,
          score,
          input.thirdReviewerId ?? null,
          input.finalDecision,
          ctx.userId,
        ],
      );

      const actorRole = ctx.roles.includes('admin') ? 'admin' : 'organizer';
      await this.audit.record(tx, {
        verb: EventVerb.CONSENSUS_DECIDED,
        actorId: ctx.userId,
        actorRole,
        // Агрегат — само решение, а не проект: у проекта своя нумерация версий
        // в модуле lab, и совпадение (агрегат, версия, тип) молча погасило бы
        // одно из двух событий в outbox.
        aggregateType: 'review_consensus',
        aggregateId: consensusId,
        aggregateVersion: 1,
        payload: {
          projectId: input.projectId,
          finalDecision: input.finalDecision,
          discrepancyScore: score,
          reviewCount: reviews.length,
        },
        traceId: ctx.traceId,
      });

      for (const founderId of await founderIds(tx, input.projectId)) {
        await this.notifications.enqueue(tx, {
          userId: founderId,
          code: 'expert.consensus.decided',
          payload: {
            project_title: project.title,
            decision: input.finalDecision,
            project_id: input.projectId,
          },
          dedupKey: `consensus:${consensusId}`,
        });
      }

      return mapConsensus(rows[0]!);
    });
  }

  // ---------------------------------------------------------------- частное

  private async loadProject(
    tx: Tx,
    projectId: string,
  ): Promise<{ title: string; seasonId: string | null }> {
    const { rows } = await tx.query<{ title: string; season_id: string | null }>(
      `SELECT title, season_id FROM lab.projects WHERE id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    const project = rows[0];
    if (!project) throw errors.notFound({ subject: 'project' });
    return { title: project.title, seasonId: project.season_id };
  }

  /**
   * Перевод ошибок БД в доменные.
   *
   * Триггер конфликта интересов поднимает 42501 — тот же код, что и отказ
   * политики. Различает их только текст, поэтому конфликт разбирается ДО общей
   * ветки прав доступа: иначе честная блокировка выглядела бы как поломка.
   */
  private translate(error: unknown): unknown {
    const pg = error as { code?: string; message?: string };
    const message = pg.message ?? '';

    if (message.includes('conflict on project')) {
      return errors.conflict(
        'По этому проекту у эксперта заявлен неразрешённый конфликт интересов',
      );
    }
    if (pg.code === '23503') {
      return errors.validation([
        { path: 'expertIds', message: 'эксперт или проект не существует' },
      ]);
    }
    if (pg.code === '23505') {
      return errors.conflict('Такое назначение или рецензия уже существует');
    }
    if (pg.code === '42501') {
      return errors.forbidden({ stage: 'db-policy' });
    }
    return error;
  }
}

/**
 * Разброс оценок рецензентов, 0–10.
 *
 * Считается по средним рубрикам: разница между самой высокой и самой низкой
 * средней оценкой. Дисперсия здесь была бы точнее статистически, но хуже по
 * назначению — организатору нужно знать «насколько далеко разошлись крайние»,
 * а не «как распределены все».
 */
export function discrepancy(scores: readonly Record<string, number>[]): number | null {
  if (scores.length < 2) return null;
  const means = scores.map((entry) => {
    const values = RUBRIC_KEYS.map((key) => entry[key]).filter(
      (value): value is number => typeof value === 'number',
    );
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  });
  const spread = Math.max(...means) - Math.min(...means);
  return Math.round(spread * 100) / 100;
}

async function loadReviews(tx: Tx, projectId: string): Promise<ExpertReview[]> {
  const { rows } = await tx.query<ReviewRow & { expert_id: string }>(
    `SELECT r.assignment_id, a.expert_id, r.rubric_scores_jsonb, r.comment,
            r.recommendation, r.submitted_at
       FROM experts.expert_reviews r
       JOIN experts.expert_assignments a ON a.id = r.assignment_id
      WHERE a.project_id = $1
      ORDER BY r.submitted_at ASC
      LIMIT 50`,
    [projectId],
  );
  return rows.map(mapReview);
}

async function founderIds(tx: Tx, projectId: string): Promise<string[]> {
  const { rows } = await tx.query<{ user_id: string }>(
    `SELECT user_id FROM lab.founders_projects WHERE project_id = $1`,
    [projectId],
  );
  return rows.map((row) => row.user_id);
}

interface AssignmentRow {
  id: string;
  project_id: string;
  title: string;
  status: ExpertAssignment['status'];
  due_at: Date;
  created_at: Date;
}

function mapAssignment(row: AssignmentRow): ExpertAssignment {
  return {
    id: row.id,
    projectId: row.project_id,
    projectTitle: row.title,
    status: row.status,
    dueAt: row.due_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

interface ReviewRow {
  assignment_id: string;
  expert_id: string;
  rubric_scores_jsonb: Record<string, number>;
  comment: string | null;
  recommendation: ExpertReview['recommendation'];
  submitted_at: Date;
}

function mapReview(row: ReviewRow): ExpertReview {
  return {
    assignmentId: row.assignment_id,
    expertId: row.expert_id,
    rubricScores: row.rubric_scores_jsonb,
    comment: row.comment,
    recommendation: row.recommendation,
    submittedAt: row.submitted_at.toISOString(),
  };
}

interface ConflictRow {
  id: string;
  expert_id: string;
  project_id: string;
  description: string;
  resolution: ExpertConflict['resolution'];
  created_at: Date;
}

function mapConflict(row: ConflictRow): ExpertConflict {
  return {
    id: row.id,
    expertId: row.expert_id,
    projectId: row.project_id,
    description: row.description,
    resolution: row.resolution,
    createdAt: row.created_at.toISOString(),
  };
}

interface ConsensusRow {
  id: string;
  project_id: string;
  season_id: string | null;
  discrepancy_score: string | null;
  final_decision: ReviewConsensus['finalDecision'];
  decided_at: Date;
}

function mapConsensus(row: ConsensusRow): ReviewConsensus {
  return {
    id: row.id,
    projectId: row.project_id,
    seasonId: row.season_id,
    // NUMERIC приходит строкой (драйвер настроен так намеренно): в контракте
    // это доля, а не деньги, поэтому приведение к number безопасно.
    discrepancyScore: row.discrepancy_score === null ? null : Number(row.discrepancy_score),
    finalDecision: row.final_decision,
    decidedAt: row.decided_at.toISOString(),
  };
}
