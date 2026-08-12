import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getEnv } from '../config/env';
import { Database } from '../db/unit-of-work';
import { S3Service } from '../storage/s3.service';

/**
 * Уборка брошенных билетов на загрузку (остаток SEC-14).
 *
 * Билет на загрузку выдаётся вместе со строкой материала, но загрузка может не
 * состояться: пользователь закрыл вкладку, сеть оборвалась, файл не подошёл под
 * условия подписанной формы. С M037 такой материал наружу не выдаётся — но и не
 * исчезает: строка остаётся навсегда, а объект, если его всё-таки успели
 * положить, не принадлежит уже ничему и не будет удалён никогда.
 *
 * Порядок здесь имеет значение и выбран сознательно: **сначала объект, потом
 * строка**. При обратном порядке падение между шагами оставляет объект без
 * единой ссылки на него — то есть мусор, который уже нечем найти. При выбранном
 * порядке падение оставляет строку, и следующий проход просто повторит попытку.
 *
 * Что уборка НЕ может тронуть: подтверждённый материал ей не виден вовсе, и
 * прав на него у роли обслуживания нет — это ограничено политиками БД (M039),
 * а не аккуратностью этого кода.
 */
@Injectable()
export class StorageJanitorService {
  private readonly logger = new Logger(StorageJanitorService.name);

  constructor(
    private readonly db: Database,
    private readonly s3: S3Service,
  ) {}

  /** Возвращает число убранных билетов. */
  async purgeAbandonedUploads(): Promise<number> {
    const env = getEnv();
    if (!env.DATABASE_URL_APP_MAINTENANCE) {
      this.logger.warn(
        'DATABASE_URL_APP_MAINTENANCE не задан: уборка брошенных загрузок не выполняется',
      );
      return 0;
    }

    const candidates = await this.db.asServiceRole(
      'app_maintenance',
      { traceId: `uploads-purge-${randomUUID()}` },
      async (tx) => {
        const { rows } = await tx.query<{ id: string; s3_key: string | null }>(
          // Отбор ограничен и по возрасту, и по числу: уборка не должна
          // превращаться в длинную транзакцию, держащую соединение.
          `SELECT id, s3_key FROM lab.project_materials
            WHERE uploaded_at IS NULL
              AND created_at < now() - ($1 || ' hours')::interval
            ORDER BY created_at
            LIMIT $2`,
          [String(env.MATERIAL_ABANDONED_TTL_HOURS), BATCH_SIZE],
        );
        return rows;
      },
    );
    if (candidates.length === 0) return 0;

    let removed = 0;
    for (const candidate of candidates) {
      try {
        if (candidate.s3_key && this.s3.isConfigured) {
          await this.s3.deleteObject(candidate.s3_key);
        }
        const deleted = await this.db.asServiceRole(
          'app_maintenance',
          { traceId: `uploads-purge-${candidate.id}` },
          async (tx) => {
            const { rowCount } = await tx.query(
              // Условие повторяется и здесь: между выборкой и удалением
              // подтверждение могло состояться, и тогда трогать строку нельзя.
              // Политика это тоже не позволит — но полагаться на единственный
              // барьер в удалении данных не стоит.
              `DELETE FROM lab.project_materials
                WHERE id = $1 AND uploaded_at IS NULL`,
              [candidate.id],
            );
            return rowCount ?? 0;
          },
        );
        removed += deleted;
      } catch (error) {
        // Один неудачный объект не должен останавливать весь проход: следующий
        // тик повторит попытку по тому же условию.
        this.logger.error({
          msg: 'не удалось убрать брошенный билет на загрузку',
          materialId: candidate.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (removed > 0) {
      this.logger.log(`убрано брошенных билетов на загрузку: ${removed}`);
    }
    return removed;
  }
}

/**
 * Сколько билетов убирается за один проход. Сто — компромисс: проход остаётся
 * коротким, а накопленный мусор разбирается за несколько тиков, а не за один
 * длинный.
 */
const BATCH_SIZE = 100;
