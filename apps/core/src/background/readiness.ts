import { getEnv } from '../config/env';

/**
 * Готовность процесса и очереди для наблюдения (блок 8, 8.2–8.3; 2.1-W08a).
 *
 * Правило блока 4.9: общая готовность core — завершён запуск, доступна
 * основная БД и обязательные счётчики ограничений (Valkey, если он
 * настроен). Хранилище и NATS проверяются на уровне функций (4.11): их отказ
 * показывается отдельно и общую готовность НЕ снимает. Фоновые задачи тоже
 * показываются отдельно. При остановке экземпляр сначала выводится из
 * готовности — до остановки фона и закрытия соединений.
 *
 * Живость (`/live`) отвечает «процесс не завис» и от зависимостей не зависит.
 * Каждая проверка ограничена по времени: зависшая зависимость — fail.
 * Разметки групп функций по 4.11 здесь нет — это отдельная работа.
 */
export type CheckState = 'ok' | 'fail' | 'not_configured';
export type Lifecycle = 'starting' | 'running' | 'stopping';

export interface ReadinessProbes {
  /** Состояние процесса: запуск завершён, идёт остановка. */
  lifecycle: () => Lifecycle;
  database: () => Promise<boolean>;
  /** Обязательные счётчики ограничений; null — не настроены. */
  valkey: (() => Promise<boolean>) | null;
  storage: (() => Promise<boolean>) | null;
  nats: (() => Promise<boolean>) | null;
  background: () => { required: boolean; running: boolean };
  queues: () => Promise<Record<string, Record<string, number>>>;
  /** Контрольная операция: запись через БД приложения и файл из хранилища. */
  control: () => Promise<ControlReport>;
}

export interface ControlReport {
  ok: boolean;
  record: 'ok' | 'missing' | 'fail';
  file: 'ok' | 'missing' | 'mismatch' | 'fail' | 'skipped';
  ms: number;
}

/**
 * Контрольная операция (блок 8, 8.2; 2.5): прочитать контрольную запись
 * обычным пулом приложения, скачать контрольный файл своими учётными
 * данными хранилища и сверить размер и SHA-256. Хранилище «здорово», а файл
 * недоступен или испорчен — это провал операции, а не зелёная отметка.
 */
export async function runControl(
  read: () => Promise<{ s3Key: string; sizeBytes: number; sha256: string } | null>,
  digest: (key: string) => Promise<{ exists: boolean; sizeBytes: number; sha256: string | null }>,
): Promise<ControlReport> {
  const started = Date.now();
  const timeout = getEnv().READINESS_CHECK_TIMEOUT_MS * 5;
  const done = (record: ControlReport['record'], file: ControlReport['file']): ControlReport => ({
    ok: record === 'ok' && file === 'ok',
    record,
    file,
    ms: Date.now() - started,
  });
  let rec;
  try {
    rec = await withTimeout(timeout, read());
  } catch {
    return done('fail', 'skipped');
  }
  if (!rec) return done('missing', 'skipped');
  try {
    const d = await withTimeout(timeout, digest(rec.s3Key));
    if (!d.exists) return done('ok', 'missing');
    return done('ok', d.sizeBytes === rec.sizeBytes && d.sha256 === rec.sha256 ? 'ok' : 'mismatch');
  } catch {
    return done('ok', 'fail');
  }
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => timer && clearTimeout(timer));
}

export interface ReadyReport {
  ready: boolean;
  lifecycle: Lifecycle;
  /** Условия общей готовности (4.9). */
  required: { database: CheckState; valkey: CheckState };
  /** Зависимости функций (4.11): видны отдельно, общую готовность не снимают. */
  functions: { storage: CheckState; nats: CheckState };
  background: CheckState;
  checkedInMs: number;
}

/** Не дольше `ms`: зависшая зависимость — это fail, а не ожидание без конца. */
async function within(ms: number, probe: () => Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe().catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkReadiness(probes: ReadinessProbes): Promise<ReadyReport> {
  const started = Date.now();
  const timeout = getEnv().READINESS_CHECK_TIMEOUT_MS;
  const run = async (probe: (() => Promise<boolean>) | null): Promise<CheckState> =>
    probe ? ((await within(timeout, probe)) ? 'ok' : 'fail') : 'not_configured';

  const [database, valkey, storage, nats] = await Promise.all([
    run(probes.database),
    run(probes.valkey),
    run(probes.storage),
    run(probes.nats),
  ]);
  // Состояние читается ПОСЛЕ ожидания зависимостей: остановка, начавшаяся во
  // время проверки, снимает готовность в этом же ответе (замечание Тэнка).
  const lifecycle = probes.lifecycle();
  const bg = probes.background();
  const required = { database, valkey };
  return {
    ready: lifecycle === 'running' && Object.values(required).every((s) => s !== 'fail'),
    lifecycle,
    required,
    functions: { storage, nats },
    background: bg.required ? (bg.running ? 'ok' : 'fail') : 'not_configured',
    checkedInMs: Date.now() - started,
  };
}
