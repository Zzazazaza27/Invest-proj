import pg from 'pg';
import { getEnv } from '../config/env';
import type { BackgroundJobsService } from './background-jobs.service';

/**
 * Слушатель сигнала «в очереди появилась работа» (M175, канал `fifth_queue_wake`).
 *
 * Отдельное соединение вне пула: соединение пула возвращается после запроса и подписку
 * держать не может. PostgreSQL доставляет уведомление только после фиксации вставки и всем
 * слушателям — каждому ядру и слоту; захват работы по-прежнему решают аренды строк.
 *
 * Сигнал — подсказка. Обрыв соединения или пропущенное уведомление работу не теряют:
 * уснувший опрос сам проснётся не позже `idle.maxMs`. Переподключение — с нарастающей
 * паузой; отказ слушателя не роняет процесс и не мешает фону.
 */
export interface QueueWake {
  /** Подписка действует сейчас. */
  readonly listening: () => boolean;
  /** Сколько уведомлений получено с запуска процесса. */
  readonly received: () => number;
  close(): Promise<void>;
}

const CHANNEL = 'fifth_queue_wake';

export function startQueueWake(
  jobs: BackgroundJobsService,
  log: { log(m: object): void; warn(m: object): void },
): QueueWake {
  const env = getEnv();
  let client: pg.Client | null = null;
  let closed = false;
  let listening = false;
  let received = 0;
  let retryMs = 1_000;
  let timer: NodeJS.Timeout | null = null;

  const reconnect = (reason: string): void => {
    listening = false;
    if (closed || timer) return;
    log.warn({ msg: 'сигнал очередей: подписка потеряна, опросы идут по паузе', reason, retryMs });
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, retryMs);
    timer.unref();
    retryMs = Math.min(retryMs * 2, 30_000);
  };

  async function connect(): Promise<void> {
    const c = new pg.Client({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
      application_name: 'fifth-core-queue-wake',
      connectionTimeoutMillis: 5_000,
    });
    client = c;
    // События прежнего соединения после переподключения не трогают новое.
    c.on('error', (error) => {
      void c.end().catch(() => undefined);
      if (c === client) reconnect(error.message);
    });
    c.on('end', () => {
      if (c === client) reconnect('соединение закрыто');
    });
    c.on('notification', (n) => {
      received += 1;
      if (n.payload) jobs.wake(n.payload);
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${CHANNEL}`);
      listening = true;
      retryMs = 1_000;
      // Пока подписки не было, сигналы могли пропасть: будим все очереди один раз.
      for (const queue of jobs.wakeQueues) jobs.wake(queue);
      log.log({ msg: 'сигнал очередей: подписка действует', queues: jobs.wakeQueues });
    } catch (error) {
      void c.end().catch(() => undefined);
      if (c === client) reconnect(error instanceof Error ? error.message : String(error));
    }
  }

  if (jobs.wakeQueues.length > 0) void connect();

  return {
    listening: () => listening,
    received: () => received,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      listening = false;
      if (client) await client.end().catch(() => undefined);
    },
  };
}
