/**
 * Конкурентные инварианты. Обязательный гейт (docs/architecture/Database_Launch.md §16).
 *
 * Проверяется то, что нельзя проверить последовательным тестом: поведение под
 * реальными параллельными транзакциями и блокировками. Здесь транзакции
 * КОММИТЯТСЯ — иначе гонки не воспроизводятся. Утверждения привязаны к
 * конкретным идентификаторам, поэтому остаточные данные ни на что не влияют.
 */
import type pg from 'pg';
import type { Client } from './helpers.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabase, inCommittedTx } from './helpers.ts';

/*
 * СВОЯ БАЗА НА ПРОГОН.
 *
 * Этому файлу коммит необходим: цепочка хешей проверяется настоящими
 * блокировками, а откат уничтожил бы
 * предмет проверки. Но «нужен коммит» не значит «пусть остаётся навсегда»:
 * раньше строки копились в общей тестовой базе от прогона к прогону.
 * Теперь база одноразовая и удаляется целиком — со всем, что появилось.
 */
const DB_NAME = `unicorn_test_concurrency_${process.pid}`;
let scratch: { pool: pg.Pool; drop: () => Promise<void> };

/** Короткая запись: вся работа файла идёт в одноразовой базе, а не в общей. */
const tx = <T>(fn: (c: Client) => Promise<T>): Promise<T> => inCommittedTx(fn, scratch.pool);

beforeAll(async () => {
  scratch = await createScratchDatabase(DB_NAME);
}, 180_000);

afterAll(async () => {
  await scratch?.drop();
}, 60_000);

describe('Конкурентные инварианты журнала', () => {
  // Гонки траншей, договоров и золотых билетов ушли вместе со сделками и
  // сезонами (2.1-W05); цепочка журнала осталась и проверяется по-прежнему.
  it('параллельная эмиссия событий не рвёт hash-chain', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        tx(async (c) => {
          await c.query(
            `SELECT audit.app_emit_event('lab.project.updated', NULL, 'system', 'project', NULL,
                                         $1::jsonb, 'parallel')`,
            [JSON.stringify({ i })],
          );
        }),
      ),
    );

    const { rows } = await scratch.pool.query(`SELECT * FROM audit.verify_event_chain()`);
    expect(rows).toEqual([]);
  });
});
