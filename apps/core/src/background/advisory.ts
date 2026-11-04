import pg from 'pg';
import { getEnv } from '../config/env';

/**
 * Advisory-блокировка обслуживания (блок 1, 1.2).
 *
 * Блокировка сессионная: она живёт, пока живо соединение, и освобождается на
 * нём же. Поэтому соединение выделенное — не из пула, где его взял бы чужой
 * запрос, — и без открытой транзакции: длинное обслуживание не держит её.
 *
 * Сама потеря соединения работу не останавливает: PostgreSQL отпустит
 * блокировку, а прикладная функция продолжит как ни в чём не бывало. Поэтому
 * обрыв соединения прерывает `lost`, и задача по нему перестаёт начинать новые
 * изменения. `keepAlive` нужен, чтобы тихий обрыв сети обнаружился, а не висел
 * до первого запроса.
 */
export interface AdvisoryLock {
  /** Прерывается при обрыве соединения, удерживающего блокировку. */
  readonly lost: AbortSignal;
  release(): Promise<void>;
}

export interface AdvisoryLockProvider {
  /** `null` — блокировку держит другой экземпляр, проход пропускается. */
  tryAcquire(name: string): Promise<AdvisoryLock | null>;
}

/**
 * Пространство ключей фоновых задач. Ключ блокировки — пара (класс, хеш
 * имени): так он не пересекается с одиночными advisory-ключами других мест.
 */
const BACKGROUND_LOCK_CLASS = 5001;

export const pgAdvisoryLocks: AdvisoryLockProvider = {
  async tryAcquire(name) {
    const env = getEnv();
    const client = new pg.Client({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
      application_name: 'fifth-core-bg-lock',
      keepAlive: true,
      connectionTimeoutMillis: 5_000,
    });
    const lost = new AbortController();
    let releasing = false;
    const onLost = (): void => {
      if (!releasing) lost.abort(new Error(`соединение блокировки ${name} потеряно`));
    };
    // Без слушателя `error` обрыв выданного соединения роняет процесс (22.09).
    client.on('error', onLost);
    client.on('end', onLost);

    try {
      await client.connect();
      const { rows } = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok',
        [BACKGROUND_LOCK_CLASS, name],
      );
      if (!rows[0]?.ok) {
        releasing = true;
        await client.end().catch(() => undefined);
        return null;
      }
    } catch (error) {
      releasing = true;
      await client.end().catch(() => undefined);
      throw error;
    }

    return {
      lost: lost.signal,
      async release() {
        releasing = true;
        try {
          await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
            BACKGROUND_LOCK_CLASS,
            name,
          ]);
        } catch {
          // Соединение уже потеряно — блокировка отпущена вместе с ним.
        } finally {
          await client.end().catch(() => undefined);
        }
      },
    };
  },
};
