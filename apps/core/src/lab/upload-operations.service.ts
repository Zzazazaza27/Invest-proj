import { Injectable } from '@nestjs/common';
import {
  MATERIAL_UPLOAD_HISTORY_LIMIT as HISTORY_LIMIT,
  type MaterialUploadResult,
  type OperationKind,
  type UserOperation,
} from '@fifth/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { actingOnProject } from './acting-role';
import { errors } from '../common/errors';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Длительные операции пользователя — загрузки материалов (блок 1, 1.5;
 * работа 2.1-W04).
 *
 * Кто видит операцию. Только её ИНИЦИАТОР и только пока у него есть права на
 * проект: условие `uploaded_by = текущий пользователь` здесь, права — политика
 * `materials_member` (участник проекта или администратор) и политика проектов.
 * Ошибка чужой загрузки в общем проекте не становится личным уведомлением
 * каждого участника; потерявший доступ не видит и своих операций.
 *
 * Всё — под контекстом пользователя (app_backend + RLS), без ролей обслуживания.
 */

const OPERATION_COLUMNS = `
  m.id, m.project_id, p.title AS project_title, m.type, m.upload_file_name,
  m.upload_state, m.object_received_at IS NOT NULL AS received,
  CASE WHEN m.upload_state = 'rejected' THEN m.upload_state_reason END AS reason,
  (m.upload_state = 'rejected' AND n.operation_id IS NULL) AS notice_pending,
  m.created_at, m.upload_state_changed_at`;

const OPERATION_FROM = `
  FROM lab.project_materials m
  JOIN lab.projects p ON p.id = m.project_id AND p.deleted_at IS NULL
  LEFT JOIN comms.operation_notices n
         ON n.operation_kind = 'material_upload'
        AND n.operation_id = m.id
        AND n.user_id = app.current_user_id()
 WHERE m.uploaded_by = app.current_user_id()
   AND m.type <> 'product_link'`;

interface OperationRow {
  id: string;
  project_id: string;
  project_title: string;
  type: UserOperation['materialType'];
  upload_file_name: string | null;
  upload_state: UserOperation['state'];
  received: boolean;
  reason: string | null;
  notice_pending: boolean;
  created_at: Date;
  upload_state_changed_at: Date;
}

@Injectable()
export class UploadOperationsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * Проверка при загрузке кабинета и возвращении на вкладку: идущие загрузки
   * и окончательные ошибки, ещё не показанные пользователю. «Требует
   * вмешательства» сюда не входит — действия от пользователя не нужно, оно
   * показано в карточке материалов.
   *
   * Идущие и неотмеченные ошибки — разными запросами с отдельными пределами:
   * накопленные ошибки не должны вытеснять идущие загрузки.
   */
  async pending(ctx: RequestContext): Promise<UserOperation[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const active = await tx.query<OperationRow>(
        `SELECT ${OPERATION_COLUMNS} ${OPERATION_FROM}
           AND m.upload_state = 'pending'
         ORDER BY m.created_at DESC
         LIMIT 200`,
      );
      const unreported = await tx.query<OperationRow>(
        `SELECT ${OPERATION_COLUMNS} ${OPERATION_FROM}
           AND m.upload_state = 'rejected' AND n.operation_id IS NULL
         ORDER BY m.upload_state_changed_at
         LIMIT 50`,
      );
      return [...active.rows, ...unreported.rows].map(mapOperation);
    });
  }

  /**
   * Загрузки пользователя в проекте — для карточки материалов.
   *
   * Идущие возвращаются ВСЕ, отдельным запросом: история не должна вытеснять
   * их из списка — вместе со строкой пропали бы кнопка отмены и опрос. Их
   * число ограничено квотой проекта (M149: не больше 50 вместе с готовыми).
   * Завершённые без успеха — «не принят» и «требует проверки» — история: только
   * последние `HISTORY_LIMIT`, после идущих.
   */
  async forProject(ctx: RequestContext, projectId: string): Promise<UserOperation[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const active = await tx.query<OperationRow>(
        `SELECT ${OPERATION_COLUMNS} ${OPERATION_FROM}
           AND m.project_id = $1 AND m.upload_state = 'pending'
         ORDER BY m.created_at DESC`,
        [projectId],
      );
      const history = await tx.query<OperationRow>(
        `SELECT ${OPERATION_COLUMNS} ${OPERATION_FROM}
           AND m.project_id = $1 AND m.upload_state IN ('rejected', 'needs_attention')
         ORDER BY m.upload_state_changed_at DESC
         LIMIT $2`,
        [projectId, HISTORY_LIMIT],
      );
      return [...active.rows, ...history.rows].map(mapOperation);
    });
  }

  /** Состояние одной операции — опрос показанной операции. Чужая неотличима от несуществующей. */
  async one(ctx: RequestContext, kind: OperationKind, id: string): Promise<UserOperation> {
    assertKind(kind);
    return this.db.readOnly(ctx, async (tx) => {
      const row = await this.read(tx, id);
      if (!row) throw errors.notFound({ subject: 'operation' });
      return mapOperation(row);
    });
  }

  /**
   * Отметка «итог показан». Принадлежность операции и доступ проверяются В
   * ТОЙ ЖЕ вставке: строка операции читается под RLS и с условием
   * инициатора. Повторная отметка ничего не меняет.
   */
  async notice(ctx: RequestContext, kind: OperationKind, id: string): Promise<void> {
    assertKind(kind);
    await this.db.transaction(ctx, async (tx) => {
      await tx.query(
        `INSERT INTO comms.operation_notices (operation_kind, operation_id, user_id)
         SELECT 'material_upload', m.id, app.current_user_id()
           FROM lab.project_materials m
           JOIN lab.projects p ON p.id = m.project_id AND p.deleted_at IS NULL
          WHERE m.id = $1
            AND m.uploaded_by = app.current_user_id()
            AND m.upload_state = 'rejected'
         ON CONFLICT DO NOTHING`,
        [id],
      );
      const row = await this.read(tx, id);
      if (!row) throw errors.notFound({ subject: 'operation' });
      if (row.upload_state !== 'rejected') {
        throw errors.conflict('У этой операции нет итога, который нужно показать');
      }
    });
  }

  /**
   * Отмена загрузки автором: «ожидает» → «отменено» одним условным UPDATE,
   * вместе со снятием аренды. Завершение публикует только под действующей
   * арендой и только из «ожидает», поэтому гонка даёт ровно один итог — либо
   * «готово», либо «отменено». Записи и объекты остаются (2.1.2); резерв
   * квоты освобождается сам (M149 считает «готово» и «ожидает»).
   *
   * Загрузка успела завершиться — ответ с её фактическим состоянием, без
   * изменений: отменять уже нечего.
   */
  async cancel(
    ctx: RequestContext,
    projectId: string,
    materialId: string,
  ): Promise<MaterialUploadResult> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{ id: string; received: boolean }>(
        `UPDATE lab.project_materials
            SET upload_state = 'cancelled', upload_state_changed_at = now(),
                cancelled_at = now(), cancelled_by = app.current_user_id(),
                lease_id = NULL, lease_until = NULL, next_check_at = NULL
          WHERE id = $1 AND project_id = $2
            AND uploaded_by = app.current_user_id()
            AND upload_state = 'pending' AND type <> 'product_link'
          RETURNING id, object_received_at IS NOT NULL AS received`,
        [materialId, projectId],
      );
      if (rows[0]) {
        await this.audit.emit(tx, {
          verb: 'lab.material.upload_cancelled',
          actorId: ctx.userId,
          actorRole: await actingOnProject(tx, ctx, projectId),
          subjectType: 'project',
          subjectId: projectId,
          context: { materialId, received: rows[0].received },
          traceId: ctx.traceId,
        });
        return {
          uploadState: 'cancelled',
          received: rows[0].received,
          reason: null,
          material: null,
        };
      }

      const row = await this.read(tx, materialId);
      if (!row || row.project_id !== projectId) throw errors.notFound({ subject: 'material' });
      return {
        uploadState: row.upload_state,
        received: row.received,
        reason: row.reason,
        material: null,
      };
    });
  }

  private async read(tx: Tx, id: string): Promise<OperationRow | null> {
    const { rows } = await tx.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} ${OPERATION_FROM} AND m.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }
}

function assertKind(kind: OperationKind): void {
  if (kind !== 'material_upload') throw errors.notFound({ subject: 'operation' });
}

function mapOperation(row: OperationRow): UserOperation {
  return {
    kind: 'material_upload',
    id: row.id,
    projectId: row.project_id,
    projectTitle: row.project_title,
    materialType: row.type,
    fileName: row.upload_file_name,
    state: row.upload_state,
    received: row.received,
    reason: row.reason,
    noticePending: row.notice_pending,
    startedAt: row.created_at.toISOString(),
    changedAt: row.upload_state_changed_at.toISOString(),
  };
}
