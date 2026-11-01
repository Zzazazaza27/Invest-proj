import { getEnv } from '../config/env';

/**
 * Готовность процесса и очереди для наблюдения (блок 8, 8.2–8.3; 2.1-W08a).
 *
 * Живость (`/live`) отвечает «процесс не завис». Готовность — «процесс может
 * выполнять операции»: каждая зависимость проверяется с ограниченным
 * ожиданием и даёт ok / fail / not_configured. Общий ответ 200 — только если
 * все НАСТРОЕННЫЕ зависимости ok; HTTP 200 сам по себе зелёной отметкой не
 * считается — Zabbix читает каждую строку.
 *
 * Чего здесь нет: доступности групп функций по блоку 4 (4.11) — отказ одной
 * зависимости ограничивает зависимые операции, а не весь процесс; эта
 * разметка — отдельная работа.
 */
export type CheckState = 'ok' | 'fail' | 'not_configured';

export interface ReadinessProbes {
  database: () => Promise<boolean>;
  storage: (() => Promise<boolean>) | null;
  valkey: (() => Promise<boolean>) | null;
  nats: (() => Promise<boolean>) | null;
  background: () => { required: boolean; running: boolean };
  queues: () => Promise<Record<string, Record<string, number>>>;
}

export interface ReadyReport {
  ready: boolean;
  checks: Record<string, CheckState>;
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

  const [database, storage, valkey, nats] = await Promise.all([
    run(probes.database),
    run(probes.storage),
    run(probes.valkey),
    run(probes.nats),
  ]);
  const bg = probes.background();
  const checks: Record<string, CheckState> = {
    database,
    storage,
    valkey,
    nats,
    background: bg.required ? (bg.running ? 'ok' : 'fail') : 'not_configured',
  };
  return {
    ready: Object.values(checks).every((s) => s !== 'fail'),
    checks,
    checkedInMs: Date.now() - started,
  };
}
