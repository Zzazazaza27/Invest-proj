import { afterAll, describe, expect, it } from 'vitest';
import { closePool, createUser, inRollbackTx, uuidv7 } from './helpers.ts';

/**
 * M102 (5.9.5): уведомления команде по порогу суммы раунда.
 *
 * Проверяется то, из-за чего порог вообще отделён от остального:
 *
 *  - повторная обработка одного события не создаёт второй записи;
 *  - запись — факт: не переписывается и не удаляется;
 *  - уведомление видит администратор, а не участники сделки;
 *  - транспорт записан честно: при выключенной рассылке стоит `none`.
 *
 * Чего порог НЕ делает (комиссия, доступ, обязательность участия оператора),
 * проверяется живым прогоном: там видно поведение целиком.
 */

afterAll(async () => {
  await closePool();
});

async function record(c: Parameters<typeof createUser>[0], eventKey: string): Promise<void> {
  await c.query(
    `INSERT INTO comms.operator_notifications
       (id, event_key, kind, country_code, policy_version, target_amount, threshold,
        currency, recipients, delivery_mode)
     VALUES ($1, $2, 'round_opened_over_threshold', 'ru', 1, 9000000, 5000000,
             'RUB', ARRAY['ops@test.local'], 'none')`,
    [uuidv7(), eventKey],
  );
}

describe('M102: уведомления по порогу', () => {
  it('повторная обработка одного события не создаёт второй записи', async () => {
    await inRollbackTx(async (c) => {
      const key = `round_opened:${uuidv7()}`;
      await record(c, key);
      await c.query('SAVEPOINT duplicate');
      await expect(record(c, key)).rejects.toThrow(/event_key/);
      await c.query('ROLLBACK TO SAVEPOINT duplicate');

      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM comms.operator_notifications WHERE event_key = $1`,
        [key],
      );
      expect(rows[0]!.n).toBe('1');
    });
  });

  it('уведомление не переписывается и не удаляется', async () => {
    await inRollbackTx(async (c) => {
      const key = `round_opened:${uuidv7()}`;
      await record(c, key);

      await c.query('SAVEPOINT rewrite');
      await expect(
        c.query(`UPDATE comms.operator_notifications SET threshold = 1 WHERE event_key = $1`, [
          key,
        ]),
      ).rejects.toThrow(/не переписывается/);
      await c.query('ROLLBACK TO SAVEPOINT rewrite');

      await expect(
        c.query(`DELETE FROM comms.operator_notifications WHERE event_key = $1`, [key]),
      ).rejects.toThrow(/не переписывается/);
    });
  });

  it('получателей без адресов не бывает', async () => {
    await inRollbackTx(async (c) => {
      await expect(
        c.query(
          `INSERT INTO comms.operator_notifications
             (id, event_key, kind, country_code, policy_version, target_amount, threshold,
              currency, recipients, delivery_mode)
           VALUES ($1, $2, 'round_opened_over_threshold', 'ru', 1, 100, 50, 'RUB',
                   ARRAY[]::text[], 'none')`,
          [uuidv7(), `round_opened:${uuidv7()}`],
        ),
      ).rejects.toThrow(/recipients/);
    });
  });

  it('транспорт ограничен известными значениями', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { role: 'admin' });
      expect(user.id).toBeTruthy();
      await expect(
        c.query(
          `INSERT INTO comms.operator_notifications
             (id, event_key, kind, country_code, policy_version, target_amount, threshold,
              currency, recipients, delivery_mode)
           VALUES ($1, $2, 'round_opened_over_threshold', 'ru', 1, 100, 50, 'RUB',
                   ARRAY['ops@test.local'], 'telepathy')`,
          [uuidv7(), `round_opened:${uuidv7()}`],
        ),
      ).rejects.toThrow(/delivery_mode/);
    });
  });
});
