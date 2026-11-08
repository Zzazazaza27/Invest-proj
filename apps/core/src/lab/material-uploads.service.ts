import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { AvailabilityService } from '../availability/availability.service';
import type { UploadableMaterialType } from '@fifth/contracts';
import { randomUUID } from 'node:crypto';
import { AuditRepository } from '../audit/audit.repository';
import { BackgroundJobsService } from '../background/background-jobs.service';
import { Database } from '../db/unit-of-work';
import { S3Service } from '../storage/s3.service';
import {
  UploadCompletion,
  type CompletionOutcome,
  type UploadTarget,
} from '../storage/upload-completion';
import {
  MATERIAL_FORMAT_REJECTIONS,
  MATERIAL_SIGNATURES,
  detectMaterialContentType,
} from './material-rules';

/**
 * Завершение загрузок материалов проекта — первое подключение общей функции
 * завершения (`storage/upload-completion`, 2.1-W03).
 *
 * Здесь только правила материалов: где таблицы, как строится окончательный
 * ключ, какое содержимое допустимо и какое событие пишется. Порядок,
 * аренда, повторы и отказы — общие.
 *
 * Фоновая сверка `uploads.reconcile` подбирает незавершённые загрузки, у
 * которых подошёл срок проверки: браузер мог закрыться после передачи файла.
 * Удалений нет — ни записей, ни объектов (переходное правило 2.1.2).
 */

const RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_BATCH = 20;

@Injectable()
export class MaterialUploadsService implements OnModuleInit {
  private readonly logger = new Logger(MaterialUploadsService.name);
  readonly completion: UploadCompletion;

  constructor(
    private readonly db: Database,
    private readonly s3: S3Service,
    private readonly audit: AuditRepository,
    private readonly jobs: BackgroundJobsService,
    /** Группа «Файлы» (4.11): сверка не пишет в хранилище, пока запись недоступна. */
    @Optional() private readonly availability?: AvailabilityService,
  ) {
    this.completion = new UploadCompletion(db, s3, this.target());
  }

  onModuleInit(): void {
    if (!this.s3.isConfigured) {
      this.logger.warn({ msg: 'сверка загрузок выключена: хранилище не настроено' });
      return;
    }
    this.jobs.register({
      name: 'uploads.reconcile',
      intervalMs: RECONCILE_INTERVAL_MS,
      coordination: 'local',
      runAtStart: true,
      run: async ({ signal }) => {
        // Запись файлов недоступна или ограничена вручную: проход пропускается. Загрузки
        // остаются «ожидает», выданные билеты не отзываются; сверка завершит их после
        // восстановления, а состояние операции можно узнать в любой момент.
        if (this.availability && !(await this.availability.allows('write'))) {
          return { status: 'idle' };
        }
        const processed = await this.reconcile(signal);
        return processed > 0 ? { status: 'done', processed } : { status: 'idle' };
      },
    });
  }

  /** Завершение из браузера: тот же путь, что у сверки. */
  finalizeFromBrowser(
    materialId: string,
    actorId: string | null,
    traceId: string,
  ): Promise<CompletionOutcome> {
    return this.completion.complete(materialId, { executor: 'browser', actorId, traceId });
  }

  /**
   * Один проход сверки. Записи берутся по одной через общую функцию: аренда
   * строки делит работу между экземплярами, а браузер и сверка не завершают
   * одну загрузку дважды.
   */
  async reconcile(signal: AbortSignal): Promise<number> {
    const traceId = `uploads-reconcile-${randomUUID()}`;
    const due = await this.db.asServiceRole('app_maintenance', { traceId }, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM lab.project_materials
          WHERE upload_state = 'pending' AND type <> 'product_link'
            AND (next_check_at IS NULL OR next_check_at <= now())
            AND (lease_until IS NULL OR lease_until < now())
          ORDER BY next_check_at NULLS FIRST, created_at
          LIMIT $1`,
        [RECONCILE_BATCH],
      );
      return rows;
    });

    let completed = 0;
    for (const { id } of due) {
      if (signal.aborted) break;
      const outcome = await this.completion.complete(id, {
        executor: 'reconcile',
        actorId: null,
        traceId,
        signal,
      });
      if (outcome.state === 'ready') completed += 1;
    }
    if (completed > 0) this.logger.log({ msg: 'сверка завершила загрузки', count: completed });
    return completed;
  }

  private target(): UploadTarget {
    return {
      table: 'lab.project_materials',
      attemptsTable: 'lab.material_upload_attempts',
      finalKey: (row, attemptId) =>
        this.s3.buildMaterialFinalKey(row.project_id, row.id, row.type, attemptId),
      validate: (row, digest) => {
        const type = row.type as UploadableMaterialType;
        const check = MATERIAL_SIGNATURES[type];
        if (!check || !check(digest.head)) {
          return MATERIAL_FORMAT_REJECTIONS[type] ?? 'Формат файла не подходит для этого материала';
        }
        const max = row.upload_max_bytes === null ? null : Number(row.upload_max_bytes);
        if (max !== null && digest.sizeBytes > max) {
          return `Файл больше допустимого размера (${Math.floor(max / (1024 * 1024))} МБ)`;
        }
        return null;
      },
      contentType: (_row, head) => detectMaterialContentType(head),
      emitPublished: async (tx, row, info) => {
        // Исполнитель и лицо, от имени которого шла загрузка, различаются
        // (блок 10): сверка — система, а загрузку начал автор.
        await this.audit.emit(tx, {
          verb: 'lab.material.added',
          actorId: info.executor === 'browser' ? info.actorId : null,
          actorRole: info.executor === 'browser' ? 'founder' : 'system',
          subjectType: 'project',
          subjectId: row.project_id,
          context: {
            materialId: row.id,
            sizeBytes: info.sizeBytes,
            finalized: true,
            executor: info.executor,
            onBehalfOf: row.uploaded_by,
          },
          traceId: info.traceId,
        });
      },
    };
  }
}
