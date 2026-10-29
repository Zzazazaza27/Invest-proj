import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers.ts';
import { actAs, closePool, createUser, inRollbackTx, resetRole, uuidv7 } from './helpers.ts';

/**
 * M097 (функциональные полномочия сотрудников).
 *
 * Проверяется механизм, который остался после 2.1-W05:
 *
 *  - роль сама по себе не даёт полномочия;
 *  - выданное полномочие действует, отзыв закрывает его при следующем запросе;
 *  - сотрудник не может выдать полномочие сам себе;
 *  - денежных полномочий finance.* больше нет — ни в каталоге, ни у кого.
 *
 * Денежные записи (возвраты, корректировки вознаграждения) и назначения на
 * объект (рецензия, сопровождение сделки) удалены вместе со сделками и
 * экспертизой — их проверки ушли вместе с ними.
 */

afterAll(async () => {
  await closePool();
});

const CAPABILITY = 'testing.sessions.manage';

/** Выдача идёт от имени администратора: запрет в БД стоит именно на этом. */
async function grant(c: Client, admin: string, userId: string, capability: string): Promise<void> {
  await actAs(c, { userId: admin, roles: ['admin'], dbRole: 'app_backend' });
  await c.query(
    `INSERT INTO identity.staff_capability_grants (id, user_id, capability, reason, granted_by)
     VALUES ($1, $2, $3, 'проверка правил', $4)`,
    [uuidv7(), userId, capability, admin],
  );
  await resetRole(c);
}

async function hasCapability(c: Client, code: string): Promise<boolean> {
  const { rows } = await c.query<{ allowed: boolean }>('SELECT app.has_capability($1) AS allowed', [
    code,
  ]);
  return rows[0]!.allowed;
}

describe('M097: функциональные полномочия', () => {
  it('роль сама по себе не даёт полномочия', async () => {
    await inRollbackTx(async (c) => {
      const investor = await createUser(c, { role: 'investor' });
      await actAs(c, { userId: investor.id, roles: ['investor'] });
      expect(await hasCapability(c, CAPABILITY)).toBe(false);
    });
  });

  it('выданное полномочие действует, отозванное — нет', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const staff = await createUser(c, { role: 'founder' });
      await grant(c, admin.id, staff.id, CAPABILITY);

      await actAs(c, { userId: staff.id, roles: ['founder'] });
      expect(await hasCapability(c, CAPABILITY)).toBe(true);

      await actAs(c, { userId: admin.id, roles: ['admin'], dbRole: 'app_backend' });
      await c.query(
        `UPDATE identity.staff_capability_grants
            SET revoked_at = now(), revoked_by = $1, revoke_reason = 'проверка отзыва'
          WHERE user_id = $2 AND capability = $3 AND revoked_at IS NULL`,
        [admin.id, staff.id, CAPABILITY],
      );
      await resetRole(c);

      await actAs(c, { userId: staff.id, roles: ['founder'] });
      expect(await hasCapability(c, CAPABILITY)).toBe(false);
    });
  });

  it('сотрудник не выдаёт полномочие сам себе', async () => {
    await inRollbackTx(async (c) => {
      const staff = await createUser(c, { role: 'founder' });
      await actAs(c, { userId: staff.id, roles: ['founder'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO identity.staff_capability_grants (id, user_id, capability, reason, granted_by)
           VALUES ($1, $2, $3, 'сам себе', $2)`,
          [uuidv7(), staff.id, CAPABILITY],
        ),
      ).rejects.toThrow(/только администратор/);
    });
  });
});

describe('2.1-W05: денежных полномочий нет', () => {
  it('каталог не содержит finance.*, удалённые роли полномочий не дают', async () => {
    await inRollbackTx(async (c) => {
      const { rows } = await c.query<{ code: string }>(
        `SELECT code FROM identity.staff_capabilities WHERE code LIKE 'finance.%'`,
      );
      expect(rows).toEqual([]);

      const user = await createUser(c, { role: 'founder' });
      await actAs(c, { userId: user.id, roles: ['expert', 'organizer'] });
      expect(await hasCapability(c, CAPABILITY)).toBe(false);
      expect(await hasCapability(c, 'finance.tranche_return.record')).toBe(false);
    });
  });
});
