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

  /**
   * Возвращает число убранных билетов.
   *
   * @param signal прерывание остановкой или потерей блокировки обслуживания:
   *   следующий билет не берём, начатое удаление доводим.
   */
  async purgeAbandonedUploads(signal?: AbortSignal): Promise<number> {
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
      if (signal?.aborted) break;
      try {
        const deleted = await this.db.asServiceRole(
          'app_maintenance',
          { traceId: `uploads-purge-${candidate.id}` },
          async (tx) => {
            // Остановка могла прийти, пока ждали соединение: удаление не начинаем.
            signal?.throwIfAborted();
            // Порядок здесь принципиален. Раньше объект удалялся ДО и ВНЕ
            // транзакции: подтверждение, шедшее параллельно, успевало увидеть
            // объект существующим, а затем проставить `uploaded_at` — уборка
            // строку не трогала, но файла уже не было. Получался «готовый»
            // материал без объекта (SEC-04).
            //
            // Теперь строка сначала БЛОКИРУЕТСЯ. Подтверждение берёт ту же
            // блокировку, поэтому одно ждёт другого: либо уборка убеждается,
            // что материал так и не подтверждён, и сносит объект вместе со
            // строкой, либо видит подтверждение и не трогает ничего.
            // Блокировку берёт сам DELETE, а не отдельный `SELECT … FOR UPDATE`:
            // под RLS запрос с блокирующим предложением проверяется ещё и
            // UPDATE-политикой, а у роли обслуживания её нет — строка просто не
            // вернулась бы, и уборка молча перестала бы работать (поймано
            // прогоном).
            //
            // Порядок «строка, затем объект» и общая транзакция дают то же
            // свойство: подтверждение, идущее параллельно, либо успевает раньше
            // — тогда DELETE не находит строки (`uploaded_at` уже проставлен) и
            // объект остаётся на месте, — либо ждёт нас и видит, что материала
            // больше нет.
            const { rows } = await tx.query<{ s3_key: string | null }>(
              `DELETE FROM lab.project_materials
                WHERE id = $1 AND uploaded_at IS NULL
             RETURNING s3_key`,
              [candidate.id],
            );
            if (!rows[0]) return 0;

            // Объект удаляется ВНУТРИ транзакции. Если это не удастся, откат
            // вернёт строку, и следующий проход повторит попытку — иначе
            // остался бы объект, на который уже никто не ссылается.
            if (rows[0].s3_key && this.s3.isConfigured) {
              await this.s3.deleteObject(rows[0].s3_key);
            }
            return 1;
          },
        );
        removed += deleted;
      } catch (error) {
        // Прерывание — не неудача объекта: транзакция откатилась, выходим.
        if (signal?.aborted) break;
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
