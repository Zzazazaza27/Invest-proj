import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AvailabilityService } from '../availability/availability.service';
import { BackgroundJobsService } from '../background/background-jobs.service';
import { getEnv } from '../config/env';
import { Database } from '../db/unit-of-work';
import { S3Service } from '../storage/s3.service';

/** Раз в сутки (3.3). */
const INTERVAL_MS = 24 * 3_600_000;
/** Простой транзакции под блокировкой: одно удаление (таймаут 10 с) с большим запасом. */
const HOLD_IDLE_MS = 120_000;
/** Материалов за проход: очередь копится медленно, проход не должен держать фон часами. */
const BATCH = 200;

export const UPLOAD_COPY_CLEANUP_JOB = 'uploads.copy-cleanup';

interface Claimed {
  target: 'upload' | 'attempt' | null;
  ref: string;
  object_key: string | null;
  defer_reason: string | null;
}

/**
 * Очистка служебных копий завершённых загрузок (3.3, работа № 8; M179).
 *
 * Удаляются только временный исходник и копии невыбранных попыток готового материала, не
 * раньше срока после «готово». Объект удаляется ВНУТРИ транзакции, в которой
 * `lab.upload_cleanup_claim` заблокировала строку материала и проверила условия (готовность,
 * выбранный ключ, ссылки, активные попытки, неистёкшее разрешение, утрата, запрет, ворота
 * восстановления), — между проверкой и удалением условие не может измениться. Отметка — той же
 * транзакцией; если она не записалась, следующий проход удалит ещё раз (404 — успех).
 *
 * Ошибка хранилища по ключу — ключ остаётся, ошибка отмечена (сигнал `uploads.cleanupFailed`),
 * проход завершается отказом (видно в `/jobs`). Ошибка БД — кандидат пропущен, проход — отказ.
 */
@Injectable()
export class UploadCopyCleanupService implements OnModuleInit {
  private readonly logger = new Logger(UploadCopyCleanupService.name);

  constructor(
    private readonly db: Database,
    private readonly s3: S3Service,
    private readonly jobs: BackgroundJobsService,
    @Optional() private readonly availability?: AvailabilityService,
  ) {}

  onModuleInit(): void {
    const env = getEnv();
    if (env.UPLOAD_COPY_CLEANUP_ENABLED !== 'true' || !this.s3.isConfigured) return;
    this.jobs.register({
      name: UPLOAD_COPY_CLEANUP_JOB,
      intervalMs: INTERVAL_MS,
      coordination: 'advisory',
      runAtStart: false,
      run: async ({ signal }) => {
        // Запись файлов недоступна или ограничена вручную — удаление тоже откладывается.
        if (this.availability && !(await this.availability.allows('write'))) {
          return { status: 'idle' };
        }
        const r = await this.pass(signal);
        if (r.failed > 0) {
          throw new Error(
            `очистка служебных копий: ошибок ${r.failed}, удалено ${r.deleted}, отложено ${r.deferred}`,
          );
        }
        return r.deleted > 0 ? { status: 'done', processed: r.deleted } : { status: 'idle' };
      },
    });
  }

  async pass(signal: AbortSignal): Promise<{ deleted: number; deferred: number; failed: number }> {
    const after = `${getEnv().UPLOAD_COPY_CLEANUP_DAYS} days`;
    const traceId = `uploads-copy-cleanup-${randomUUID()}`;
    const ids = await this.db.asServiceRole('app_maintenance', { traceId }, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'SELECT lab.upload_cleanup_candidates($1::interval, $2) AS id',
        [after, BATCH],
      );
      return rows.map((r) => r.id);
    });

    let deleted = 0;
    let deferred = 0;
    let failed = 0;
    for (const id of ids) {
      if (signal.aborted) break;
      try {
        await this.db.asServiceRole('app_maintenance', { traceId }, async (tx) => {
          const { rows } = await tx.query<Claimed>(
            'SELECT target, ref, object_key, defer_reason FROM lab.upload_cleanup_claim($1, $2::interval)',
            [id, after],
          );
          const defer = rows.find((r) => r.defer_reason);
          if (defer) {
            deferred += 1;
            this.logger.log({
              msg: 'очистка отложена',
              materialId: id,
              reason: defer.defer_reason,
            });
            return;
          }
          // Строка материала заблокирована до конца этой транзакции: удаление — под ней.
          // Пул закрывает простаивающую транзакцию через 30 с, а между запросами идут
          // удаления в хранилище: срок простоя этой транзакции — с запасом на одно удаление
          // (у него свой таймаут), и перед КАЖДЫМ удалением транзакция подтверждается
          // запросом. Не подтвердилась — блокировки больше нет: следующие удаления не
          // начинаются, ошибка уходит наверх, отметок нет (повтор — следующим проходом).
          await tx.query(`SET LOCAL idle_in_transaction_session_timeout = '${HOLD_IDLE_MS}'`);
          const results: { target: string; ref: string; ok: boolean; error?: string }[] = [];
          for (const r of rows) {
            if (signal.aborted) break;
            await tx.query('SELECT 1');
            try {
              await this.s3.deleteObject(r.object_key!);
              results.push({ target: r.target!, ref: r.ref, ok: true });
              deleted += 1;
            } catch (error) {
              failed += 1;
              results.push({ target: r.target!, ref: r.ref, ok: false, error: String(error) });
            }
          }
          await tx.query('SELECT lab.upload_cleanup_done($1, $2::jsonb)', [
            id,
            JSON.stringify(results),
          ]);
        });
      } catch (error) {
        // Ошибка БД — кандидат не тронут этим проходом.
        failed += 1;
        this.logger.error({
          msg: 'очистка служебных копий: кандидат пропущен',
          materialId: id,
          error,
        });
      }
    }
    if (deleted || failed) {
      this.logger.log({ msg: 'очистка служебных копий', deleted, deferred, failed });
    }
    return { deleted, deferred, failed };
  }
}
