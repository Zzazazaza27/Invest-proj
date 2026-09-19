import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers.ts';
import {
  actAs,
  approveKyc,
  closePool,
  createEntity,
  createOffer,
  createProject,
  createSignedAgreement,
  createUser,
  inRollbackTx,
  resetRole,
  uuidv7,
} from './helpers.ts';

/**
 * M097 (полномочия и ручные денежные записи).
 *
 * Проверяется то, ради чего слои разделены:
 *
 *  - роль `expert` сама по себе не даёт ни полномочия, ни области работы;
 *  - полномочие без назначения не открывает чужую сделку, а назначение без
 *    полномочия не даёт трогать деньги;
 *  - отзыв полномочия закрывает доступ при следующем запросе;
 *  - сотрудник не может выдать полномочие сам себе;
 *  - возвраты частичные, в сумме не больше транша, запись неизменяема;
 *  - уменьшение начисления и возврат уплаченного — разные записи и разные
 *    полномочия.
 */

afterAll(async () => {
  await closePool();
});

/** Подтверждённый транш с начислением: обстановка для ручных записей. */
async function dealWithTranche(
  c: Client,
  amount = 1_000_000,
): Promise<{ projectId: string; agreementId: string; trancheId: string; accrualId: string }> {
  const founder = await createUser(c);
  const investor = await createUser(c, { role: 'investor' });
  await approveKyc(c, investor.id);
  const entity = await createEntity(c, founder.id);
  const projectId = await createProject(c, founder.id, { listed: true });
  const offer = await createOffer(c, {
    projectId,
    entityId: entity,
    createdBy: founder.id,
    target: amount * 5,
    min: 1000,
  });
  const agreementId = await createSignedAgreement(c, {
    offerId: offer,
    investorId: investor.id,
    amount,
  });
  const { rows } = await c.query<{ tranche_id: string; accrual_id: string }>(
    `SELECT tranche_id, accrual_id
       FROM billing.confirm_tranche($1, $2, $3, now(), digest('stmt','sha256'), NULL, 'test')`,
    [agreementId, `bank-${uuidv7()}`, amount],
  );
  return {
    projectId,
    agreementId,
    trancheId: rows[0]!.tranche_id,
    accrualId: rows[0]!.accrual_id,
  };
}

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

describe('M097: полномочия отдельно от области работы', () => {
  it('роль expert сама по себе не даёт полномочия', async () => {
    await inRollbackTx(async (c) => {
      const expert = await createUser(c, { role: 'expert' });
      await actAs(c, { userId: expert.id, roles: ['expert'] });
      const { rows } = await c.query<{ allowed: boolean }>(
        `SELECT app.has_capability('finance.tranche_return.record') AS allowed`,
      );
      expect(rows[0]!.allowed).toBe(false);
    });
  });

  it('выданное полномочие действует, отозванное — нет', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const expert = await createUser(c, { role: 'expert' });
      await grant(c, admin.id, expert.id, 'finance.tranche_return.record');

      await actAs(c, { userId: expert.id, roles: ['expert'] });
      const granted = await c.query<{ allowed: boolean }>(
        `SELECT app.has_capability('finance.tranche_return.record') AS allowed`,
      );
      expect(granted.rows[0]!.allowed).toBe(true);

      await actAs(c, { userId: admin.id, roles: ['admin'], dbRole: 'app_backend' });
      await c.query(
        `UPDATE identity.staff_capability_grants
            SET revoked_at = now(), revoked_by = $1, revoke_reason = 'проверка отзыва'
          WHERE user_id = $2 AND capability = $3 AND revoked_at IS NULL`,
        [admin.id, expert.id, 'finance.tranche_return.record'],
      );
      await resetRole(c);

      await actAs(c, { userId: expert.id, roles: ['expert'] });
      const revoked = await c.query<{ allowed: boolean }>(
        `SELECT app.has_capability('finance.tranche_return.record') AS allowed`,
      );
      expect(revoked.rows[0]!.allowed).toBe(false);
    });
  });

  it('сотрудник не выдаёт полномочие сам себе', async () => {
    await inRollbackTx(async (c) => {
      const expert = await createUser(c, { role: 'expert' });
      await actAs(c, { userId: expert.id, roles: ['expert'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO identity.staff_capability_grants (id, user_id, capability, reason, granted_by)
           VALUES ($1, $2, 'finance.commission.reduce', 'сам себе', $2)`,
          [uuidv7(), expert.id],
        ),
      ).rejects.toThrow(/только администратор/);
    });
  });

  it('полномочие без назначения не открывает чужую сделку', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const expert = await createUser(c, { role: 'expert' });
      await c.query(`INSERT INTO experts.experts (user_id) VALUES ($1)`, [expert.id]);
      const deal = await dealWithTranche(c);
      await grant(c, admin.id, expert.id, 'finance.tranche_return.record');

      await actAs(c, { userId: expert.id, roles: ['expert'], dbRole: 'app_backend' });
      // Полномочие есть, назначения нет: RLS на запись не пропускает.
      await expect(
        c.query(
          `INSERT INTO investments.tranche_returns
             (id, tranche_id, amount, currency, occurred_on, reason, recorded_by, idempotency_key)
           VALUES ($1, $2, 1000, 'RUB', current_date, 'без назначения', $3, $4)`,
          [uuidv7(), deal.trancheId, expert.id, 'idem-' + uuidv7()],
        ),
        // Отказ приходит раньше проверки политики: сама сделка эксперту не
        // видна, поэтому транш «не найден». Это и есть нужное поведение —
        // сообщение не подтверждает даже существование чужого транша.
      ).rejects.toThrow(/не найден|row-level security|политик/i);
    });
  });

  it('назначение без полномочия не даёт трогать деньги', async () => {
    await inRollbackTx(async (c) => {
      const expert = await createUser(c, { role: 'expert' });
      await c.query(`INSERT INTO experts.experts (user_id) VALUES ($1)`, [expert.id]);
      const deal = await dealWithTranche(c);
      await c.query(
        `INSERT INTO experts.expert_assignments
           (id, project_id, expert_id, assigned_reason, status, due_at)
         VALUES ($1, $2, $3, 'manual', 'accepted', now() + interval '7 days')`,
        [uuidv7(), deal.projectId, expert.id],
      );

      await actAs(c, { userId: expert.id, roles: ['expert'] });
      const { rows } = await c.query<{ allowed: boolean }>(
        `SELECT app.has_capability('finance.commission.reduce') AS allowed`,
      );
      expect(rows[0]!.allowed).toBe(false);
    });
  });
});

describe('M097: фиксация возврата', () => {
  it('частичные возвраты складываются и не превышают сумму транша', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const deal = await dealWithTranche(c, 1_000_000);
      await actAs(c, { userId: admin.id, roles: ['admin'] });

      const record = (amount: number) =>
        c.query(
          `INSERT INTO investments.tranche_returns
             (id, tranche_id, amount, currency, occurred_on, reason, recorded_by, idempotency_key)
           VALUES ($1, $2, $3, 'RUB', current_date, 'частичный возврат по договорённости', $4, $5)`,
          [uuidv7(), deal.trancheId, amount, admin.id, `idem-${uuidv7()}`],
        );

      await expect(record(400_000)).resolves.toBeDefined();
      await expect(record(600_000)).resolves.toBeDefined();
      await c.query('SAVEPOINT excess');
      await expect(record(1)).rejects.toThrow(/превышают его сумму/);
      await c.query('ROLLBACK TO SAVEPOINT excess');
    });
  });

  it('запись о возврате не удаляется и не правится — только аннулируется', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const deal = await dealWithTranche(c, 500_000);
      await actAs(c, { userId: admin.id, roles: ['admin'] });
      const id = uuidv7();
      await c.query(
        `INSERT INTO investments.tranche_returns
           (id, tranche_id, amount, currency, occurred_on, reason, recorded_by, idempotency_key)
         VALUES ($1, $2, 100000, 'RUB', current_date, 'возврат по соглашению сторон', $3, $4)`,
        [id, deal.trancheId, admin.id, `idem-${uuidv7()}`],
      );

      await c.query('SAVEPOINT removal');
      await expect(
        c.query('DELETE FROM investments.tranche_returns WHERE id = $1', [id]),
      ).rejects.toThrow(/не удаляется/);
      await c.query('ROLLBACK TO SAVEPOINT removal');

      await c.query('SAVEPOINT rewrite');
      await expect(
        c.query('UPDATE investments.tranche_returns SET amount = 1 WHERE id = $1', [id]),
      ).rejects.toThrow(/неизменяема/);
      await c.query('ROLLBACK TO SAVEPOINT rewrite');

      await expect(
        c.query(
          `UPDATE investments.tranche_returns
              SET cancelled_at = now(), cancelled_by = $2, cancel_reason = 'ошибочная запись'
            WHERE id = $1`,
          [id, admin.id],
        ),
      ).resolves.toBeDefined();

      // Аннулированная запись освобождает сумму: возврат можно записать заново.
      await expect(
        c.query(
          `INSERT INTO investments.tranche_returns
             (id, tranche_id, amount, currency, occurred_on, reason, recorded_by, idempotency_key)
           VALUES ($1, $2, 500000, 'RUB', current_date, 'верная запись', $3, $4)`,
          [uuidv7(), deal.trancheId, admin.id, `idem-${uuidv7()}`],
        ),
      ).resolves.toBeDefined();
    });
  });

  it('повторная отправка с тем же ключом не создаёт дубликат', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const deal = await dealWithTranche(c, 300_000);
      await actAs(c, { userId: admin.id, roles: ['admin'] });
      const key = `idem-${uuidv7()}`;
      const record = () =>
        c.query(
          `INSERT INTO investments.tranche_returns
             (id, tranche_id, amount, currency, occurred_on, reason, recorded_by, idempotency_key)
           VALUES ($1, $2, 1000, 'RUB', current_date, 'двойное нажатие', $3, $4)`,
          [uuidv7(), deal.trancheId, admin.id, key],
        );
      await expect(record()).resolves.toBeDefined();
      await c.query('SAVEPOINT duplicate');
      await expect(record()).rejects.toThrow(/idempotency_key/);
      await c.query('ROLLBACK TO SAVEPOINT duplicate');
    });
  });
});

describe('M097: корректировка вознаграждения', () => {
  it('уменьшение и возврат уплаченного — разные записи, каждая в пределах доли', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const deal = await dealWithTranche(c, 1_000_000);
      await actAs(c, { userId: admin.id, roles: ['admin'] });

      const adjust = (kind: string, amount: number) =>
        c.query(
          `INSERT INTO billing.commission_adjustments
             (id, accrual_id, kind, party, amount, currency, reason, recorded_by, idempotency_key)
           VALUES ($1, $2, $3, 'investor', $4, 'RUB', 'решение по итогам переговоров', $5, $6)`,
          [uuidv7(), deal.accrualId, kind, amount, admin.id, `idem-${uuidv7()}`],
        );

      // Доля инвестора — 10 % от 1 млн = 100 000.
      await expect(adjust('accrual_reduction', 60_000)).resolves.toBeDefined();
      await c.query('SAVEPOINT excess');
      await expect(adjust('accrual_reduction', 40_001)).rejects.toThrow(/превышают долю стороны/);
      await c.query('ROLLBACK TO SAVEPOINT excess');
      // Возврат уплаченного считается отдельно: уменьшение его не исчерпало.
      await expect(adjust('paid_refund', 100_000)).resolves.toBeDefined();
    });
  });

  it('корректировка неизменяема', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const deal = await dealWithTranche(c, 400_000);
      await actAs(c, { userId: admin.id, roles: ['admin'] });
      const id = uuidv7();
      await c.query(
        `INSERT INTO billing.commission_adjustments
           (id, accrual_id, kind, party, amount, currency, reason, recorded_by, idempotency_key)
         VALUES ($1, $2, 'accrual_reduction', 'issuer', 1000, 'RUB', 'основание', $3, $4)`,
        [id, deal.accrualId, admin.id, `idem-${uuidv7()}`],
      );
      await expect(
        c.query('UPDATE billing.commission_adjustments SET amount = 1 WHERE id = $1', [id]),
      ).rejects.toThrow(/неизменяема/);
    });
  });
});
