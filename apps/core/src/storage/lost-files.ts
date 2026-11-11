import { Logger } from '@nestjs/common';
import type { Database } from '../db/unit-of-work';

/**
 * Утрата готового файла (3.2, работа № 7; M178).
 *
 * Зовётся ТОЛЬКО когда запись прошла проверку прав, указывает на ключ готового файла, а
 * хранилище ответило «нет такого объекта». Недоступность хранилища сюда не попадает: там
 * `getObject` бросает исключение, и это забота наблюдения за доступностью.
 *
 * Строка утраты открывается функцией БД под блокировкой записи: если запись тем временем
 * восстановлена или заменена (ключ уже другой), утрата не открывается — `stale`.
 */
export type LostFileKind = 'material' | 'project_media' | 'avatar';

const logger = new Logger('LostFiles');

export async function reportLostFile(
  db: Database,
  kind: LostFileKind,
  recordId: string,
  key: string,
  traceId: string,
): Promise<'opened' | 'repeated' | 'stale' | 'unrecorded'> {
  try {
    const result = await db.asServiceRole('app_maintenance', { traceId }, async (tx) => {
      const { rows } = await tx.query<{ r: 'opened' | 'repeated' | 'stale' }>(
        'SELECT ops.report_lost_file($1, $2, $3) AS r',
        [kind, recordId, key],
      );
      return rows[0]!.r;
    });
    if (result !== 'stale') {
      logger.error({ msg: 'утрачен готовый файл', kind, recordId, result, traceId });
    }
    return result;
  } catch (error) {
    // Учёт не записался — ответ пользователю всё равно техническая ошибка, не «нет файла».
    logger.error({ msg: 'утрачен готовый файл; учёт не записан', kind, recordId, traceId, error });
    return 'unrecorded';
  }
}
