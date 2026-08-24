import { Injectable } from '@nestjs/common';
import {
  EventVerb,
  REVIEW_DISCREPANCY_THRESHOLD,
  RUBRIC_KEYS,
  uuidv7,
  type ExpertAssignment,
  type ExpertConflict,
  type ExpertHistoryEntry,
  type ExpertNote,
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
        `SELECT a.id, a.project_id, p.title, a.status, a.due_at, a.created_at,
                p.status AS project_status,
                EXISTS (SELECT 1 FROM experts.expert_reviews r
                         WHERE r.assignment_id = a.id) AS review_submitted,
                EXISTS (SELECT 1 FROM experts.review_consensus rc
                         WHERE rc.project_id = a.project_id) AS consensus_decided
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
   * Следующий номер версии агрегата для события по назначению.
   *
   * Версия обязана быть УНИКАЛЬНОЙ в пределах (агрегат, версия, тип события):
   * это ограничение outbox, и оно защищает от двух копий одного факта. Пока
   * событие по назначению случалось ровно один раз каждого вида, номер можно
   * было писать константой — назначение 1, закрытие 2, рецензия 3.
   *
   * Пересмотр рецензии и заметка происходят МНОГОКРАТНО, и константа здесь
   * означала бы, что второй пересмотр падает нарушением уникальности. Поймано
   * прогоном: вторая попытка возвращала 409 вместо 200.
   *
   * Номер считается по журналу того же назначения: он монотонен и не зависит
   * от того, сколько видов событий появится дальше.
   */
  private async nextAggregateVersion(tx: Tx, assignmentId: string): Promise<number> {
    const { rows } = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.events
        WHERE subject_type = 'expert_assignment' AND subject_id = $1`,
      [assignmentId],
    );
    return Number(rows[0]?.n ?? 0) + 1;
  }

  /**
   * Отрицательный исход обязан быть объяснён.
   *
   * ТЗ: «Если проект отправлен на доработку, должна сохраняться
   * причина/комментарий эксперта». Требование шире доработки: `fail` без
   * объяснения так же бесполезен автору проекта и так же не даёт организатору
   * основания для решения. `pass` объяснять не обязательно.
   */
  private assertReasonGiven(recommendation: string, comment?: string | null): void {
    if (recommendation === 'pass') return;
    if ((comment ?? '').trim().length > 0) return;
    throw errors.validation([
      {
        path: 'comment',
        message: 'при рекомендации «доработать» или «отклонить» причина обязательна',
      },
    ]);
  }

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
      this.assertReasonGiven(input.recommendation, input.comment);

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

  /**
   * Пересмотреть собственную рецензию.
   *
   * ТЗ требует «изменить результат рассмотрения в пределах разрешённого
   * workflow». Предел здесь один и он объективный: пока по проекту НЕ принято
   * решение консенсуса. После решения рецензия — основание уже принятого
   * решения, и переписывать её значит переписывать историю.
   *
   * Границу держит триггер `expert_reviews_revision_window` в самой БД, а не
   * эта функция: проверку в коде обходит любой прямой доступ. Здесь остаётся
   * только перевод отказа БД в понятный человеку ответ.
   *
   * Статус назначения при пересмотре НЕ меняется: оно как было `completed`,
   * так и остаётся — работа сделана, изменилось её содержание.
   */
  async reviseReview(
    ctx: RequestContext,
    assignmentId: string,
    input: {
      rubricScores: Record<string, number>;
      comment?: string;
      recommendation: 'pass' | 'fail' | 'needs_review';
    },
  ): Promise<ExpertReview> {
    this.assertReasonGiven(input.recommendation, input.comment);

    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{ project_id: string; expert_id: string }>(
        `SELECT project_id, expert_id FROM experts.expert_assignments WHERE id = $1 FOR UPDATE`,
        [assignmentId],
      );
      const assignment = rows[0];
      // Чужое назначение политикой не видно — ответ такой же, как для
      // несуществующего.
      if (!assignment || assignment.expert_id !== ctx.userId) {
        throw errors.notFound({ subject: 'assignment' });
      }

      let review: ExpertReview;
      try {
        const { rows: updated } = await tx.query<ReviewRow>(
          `UPDATE experts.expert_reviews
              SET rubric_scores_jsonb = $2::jsonb,
                  comment             = $3,
                  recommendation      = $4,
                  submitted_at        = now()
            WHERE assignment_id = $1
        RETURNING assignment_id, rubric_scores_jsonb, comment, recommendation, submitted_at`,
          [
            assignmentId,
            JSON.stringify(input.rubricScores),
            input.comment ?? null,
            input.recommendation,
          ],
        );
        if (updated.length === 0) {
          throw errors.stateTransition('Рецензия ещё не подана — пересматривать нечего');
        }
        review = mapReview({ ...updated[0]!, expert_id: ctx.userId! });
      } catch (error) {
        throw this.translate(error);
      }

      await this.audit.record(tx, {
        verb: EventVerb.EXPERT_REVIEW_REVISED,
        actorId: ctx.userId,
        actorRole: 'expert',
        aggregateType: 'expert_assignment',
        aggregateId: assignmentId,
        aggregateVersion: await this.nextAggregateVersion(tx, assignmentId),
        // Как и при подаче: наружу факт и рекомендация, рубрики остаются
        // внутренней кухней совета.
        payload: { projectId: assignment.project_id, recommendation: input.recommendation },
        traceId: ctx.traceId,
      });

      return review;
    });
  }

  // ------------------------------------------------------ ход рассмотрения

  /**
   * Внутренняя заметка по ходу рассмотрения.
   *
   * Автору проекта не видна — как и рубричные оценки. Это рабочая запись
   * эксперта, а не сообщение основателю; путать их означало бы, что эксперт
   * либо перестанет писать честно, либо случайно напишет автору.
   */
  async addNote(ctx: RequestContext, assignmentId: string, body: string): Promise<ExpertNote> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows: found } = await tx.query<{ project_id: string; expert_id: string }>(
        `SELECT project_id, expert_id FROM experts.expert_assignments WHERE id = $1`,
        [assignmentId],
      );
      const assignment = found[0];
      if (!assignment || assignment.expert_id !== ctx.userId) {
        throw errors.notFound({ subject: 'assignment' });
      }

      let note: ExpertNote;
      try {
        const { rows } = await tx.query<NoteRow>(
          `INSERT INTO experts.expert_notes (id, assignment_id, author_id, body)
                VALUES ($1, $2, $3, $4)
             RETURNING id, body, created_at`,
          [uuidv7(), assignmentId, ctx.userId, body],
        );
        note = {
          id: rows[0]!.id,
          body: rows[0]!.body,
          createdAt: rows[0]!.created_at.toISOString(),
        };
      } catch (error) {
        throw this.translate(error);
      }

      await this.audit.record(tx, {
        verb: EventVerb.EXPERT_NOTE_ADDED,
        actorId: ctx.userId,
        actorRole: 'expert',
        aggregateType: 'expert_assignment',
        aggregateId: assignmentId,
        aggregateVersion: await this.nextAggregateVersion(tx, assignmentId),
        // Текст заметки в журнал НЕ кладётся: журнал хеш-сцеплен и неизменяем,
        // а свободный текст оттуда потом не убрать. В событии — только факт.
        payload: { projectId: assignment.project_id },
        traceId: ctx.traceId,
      });

      return note;
    });
  }

  async listNotes(ctx: RequestContext, assignmentId: string): Promise<ExpertNote[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<NoteRow>(
        // Фильтра по автору нет намеренно: его ставит политика. Условие в
        // запросе выглядело бы защитой, но прямой доступ к БД не покрывает.
        `SELECT id, body, created_at FROM experts.expert_notes
          WHERE assignment_id = $1
          ORDER BY created_at`,
        [assignmentId],
      );
      return rows.map((row) => ({
        id: row.id,
        body: row.body,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  /**
   * История рассмотрения — из журнала `audit.events`.
   *
   * Отдельной таблицы истории нет и не заводится: журнал уже пишет каждое
   * действие эксперта, хеш-сцеплен и неизменяем. Вторая история рядом с ним
   * расходилась бы с ним при первой же ошибке — и молча.
   *
   * Наружу отдаётся РОЛЬ действующего лица, а не его идентификатор: эксперту
   * важно, что назначение сделал организатор, а не кто именно.
   */
  async history(ctx: RequestContext, assignmentId: string): Promise<ExpertHistoryEntry[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<HistoryRow>(
        `SELECT ts, verb, actor_role, context_jsonb
           FROM audit.events
          WHERE subject_type = 'expert_assignment' AND subject_id = $1
          ORDER BY ts`,
        [assignmentId],
      );
      return rows.map((row) => ({
        at: row.ts.toISOString(),
        verb: row.verb,
        actorRole: row.actor_role,
        // Из полезной нагрузки берутся только безопасные поля. Слепое
        // проксирование payload означало бы, что новое поле в событии
        // однажды уедет в кабинет само собой.
        details: pickSafeDetails(row.context_jsonb),
      }));
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
  /**
   * Поля состояния рассмотрения. Необязательные потому, что часть запросов
   * (создание назначения, ответ на него) их не выбирает: там состояние
   * известно из самой операции, и лишний JOIN был бы работой ради формы.
   */
  project_status?: string;
  review_submitted?: boolean;
  consensus_decided?: boolean;
}

function mapAssignment(row: AssignmentRow): ExpertAssignment {
  return {
    id: row.id,
    projectId: row.project_id,
    projectTitle: row.title,
    status: row.status,
    dueAt: row.due_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    projectStatus: row.project_status ?? 'unknown',
    reviewSubmitted: row.review_submitted === true,
    // Пересмотр закрыт, когда по проекту принято решение консенсуса. Значение
    // по умолчанию — «можно»: запросы, не выбирающие это поле, относятся к
    // моментам, когда решения заведомо ещё нет.
    revisable: row.consensus_decided !== true,
  };
}

interface NoteRow {
  id: string;
  body: string;
  created_at: Date;
}

interface HistoryRow {
  ts: Date;
  verb: string;
  actor_role: string;
  context_jsonb: Record<string, unknown> | null;
}

/** Из полезной нагрузки события — только перечисленные поля, и только строками. */
function pickSafeDetails(payload: Record<string, unknown> | null): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const key of ['status', 'recommendation', 'dueAt'] as const) {
    const value = payload?.[key];
    if (typeof value === 'string') details[key] = value;
  }
  return details;
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
