/**
 * Конкурентные инварианты. Обязательный гейт (docs/architecture/Database_Launch.md §16).
 *
 * Проверяется то, что нельзя проверить последовательным тестом: поведение под
 * реальными параллельными транзакциями и блокировками. Здесь транзакции
 * КОММИТЯТСЯ — иначе гонки не воспроизводятся. Утверждения привязаны к
 * конкретным идентификаторам, поэтому остаточные данные ни на что не влияют.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  approveKyc,
  closePool,
  createEntity,
  createOffer,
  createProject,
  createSignedAgreement,
  createUser,
  getPool,
  inCommittedTx,
  uuidv7,
} from './helpers.ts';

afterAll(async () => {
  await closePool();
});

/** Готовит подписанный договор в закоммиченном виде. */
async function prepareSignedAgreement(amount = 1_000_000): Promise<string> {
  return inCommittedTx(async (c) => {
    const founder = await createUser(c);
    const investor = await createUser(c, { role: 'investor' });
    await approveKyc(c, investor.id);
    const entity = await createEntity(c, founder.id);
    const project = await createProject(c, founder.id, { listed: true });
    const offer = await createOffer(c, {
      projectId: project,
      entityId: entity,
      createdBy: founder.id,
      target: amount * 5,
      min: 1000,
    });
    return createSignedAgreement(c, { offerId: offer, investorId: investor.id, amount });
  });
}

/** Один вызов confirm_tranche в отдельном соединении. */
async function callConfirm(
  agreementId: string,
  bankRef: string,
  amount: number,
): Promise<{ ok: true; alreadyProcessed: boolean } | { ok: false; error: string }> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_investments');
    const { rows } = await client.query<{ already_processed: boolean }>(
      `SELECT * FROM billing.confirm_tranche($1, $2, $3, now(), digest('stmt','sha256'), NULL, 'race')`,
      [agreementId, bankRef, amount],
    );
    await client.query('COMMIT');
    return { ok: true, alreadyProcessed: rows[0]!.already_processed };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client.release();
  }
}

describe('confirm_tranche под конкуренцией', () => {
  it('8 параллельных доставок ОДНОГО банковского события дают ровно одно начисление', async () => {
    const amount = 1_000_000;
    const agreementId = await prepareSignedAgreement(amount);
    const bankRef = `bank-${uuidv7()}`;

    const results = await Promise.all(
      Array.from({ length: 8 }, () => callConfirm(agreementId, bankRef, amount)),
    );

    const succeeded = results.filter((r) => r.ok);
    expect(succeeded.length).toBeGreaterThan(0);

    const pool = getPool();
    const tranches = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM investments.investment_tranches WHERE agreement_id = $1`,
      [agreementId],
    );
    const accruals = await pool.query<{
      count: string;
      base: string;
      investor_fee: string;
      issuer_fee: string;
    }>(
      `SELECT count(*)::text AS count,
              max(base_amount)::text AS base,
              max(investor_fee_amount)::text AS investor_fee,
              max(issuer_fee_amount)::text AS issuer_fee
         FROM billing.commission_accruals WHERE agreement_id = $1`,
      [agreementId],
    );
    const nominal = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM investments.nominal_account_transactions
        WHERE bank_transaction_ref = $1`,
      [bankRef],
    );
    const agreement = await pool.query<{ status: string }>(
      `SELECT status FROM investments.investment_agreements WHERE id = $1`,
      [agreementId],
    );

    expect(tranches.rows[0]!.count).toBe('1');
    expect(accruals.rows[0]!.count).toBe('1');
    expect(nominal.rows[0]!.count).toBe('1');
    expect(agreement.rows[0]!.status).toBe('effective');

    // База — сумма ПОДТВЕРЖДЁННОГО транша (5.9.3): здесь транш равен всей
    // сумме договора, доли — процентные пункты общей ставки.
    expect(Number(accruals.rows[0]!.base)).toBe(amount);
    expect(Number(accruals.rows[0]!.investor_fee)).toBe(amount * 0.1);
    expect(Number(accruals.rows[0]!.issuer_fee)).toBe(amount * 0.05);
  });

  it('повторный вызов возвращает прежний результат, а не создаёт дубликат', async () => {
    const amount = 500_000;
    const agreementId = await prepareSignedAgreement(amount);
    const bankRef = `bank-${uuidv7()}`;

    const first = await callConfirm(agreementId, bankRef, amount);
    const second = await callConfirm(agreementId, bankRef, amount);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.alreadyProcessed).toBe(false);
      expect(second.alreadyProcessed).toBe(true);
    }

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM billing.commission_accruals WHERE agreement_id = $1`,
      [agreementId],
    );
    expect(rows[0]!.count).toBe('1');
  });

  /**
   * Модель 5.9.3: вознаграждение берётся с КАЖДОГО подтверждённого транша, а
   * не разово со всей суммы договора. Прежний тест требовал обратного — это
   * и есть отменённое поведение, а не регрессия.
   */
  it('второй транш начисляется отдельно, на свою сумму', async () => {
    const amount = 800_000;
    const agreementId = await prepareSignedAgreement(amount);

    const first = await callConfirm(agreementId, `bank-${uuidv7()}`, amount / 2);
    const second = await callConfirm(agreementId, `bank-${uuidv7()}`, amount / 2);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const { rows } = await getPool().query<{
      count: string;
      base_sum: string;
      investor_sum: string;
    }>(
      `SELECT count(*)::text AS count,
              sum(base_amount)::text AS base_sum,
              sum(investor_fee_amount)::text AS investor_sum
         FROM billing.commission_accruals WHERE agreement_id = $1`,
      [agreementId],
    );
    expect(rows[0]!.count).toBe('2');
    // Итог совпадает с расчётом по полной сумме, только деньги берутся по
    // мере поступления, а не авансом.
    expect(Number(rows[0]!.base_sum)).toBe(amount);
    expect(Number(rows[0]!.investor_sum)).toBe(amount * 0.1);

    const tranches = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM investments.investment_tranches WHERE agreement_id = $1`,
      [agreementId],
    );
    expect(tranches.rows[0]!.count).toBe('2');
  });

  it('транши сверх суммы договора не принимаются', async () => {
    const amount = 400_000;
    const agreementId = await prepareSignedAgreement(amount);

    const first = await callConfirm(agreementId, `bank-${uuidv7()}`, amount);
    const excess = await callConfirm(agreementId, `bank-${uuidv7()}`, 1);

    expect(first.ok).toBe(true);
    expect(excess.ok).toBe(false);
    if (!excess.ok) expect(excess.error).toMatch(/exceed contract amount/i);
  });

  it('неподписанный договор не принимает транш', async () => {
    const agreementId = await inCommittedTx(async (c) => {
      const founder = await createUser(c);
      const investor = await createUser(c, { role: 'investor' });
      await approveKyc(c, investor.id);
      const entity = await createEntity(c, founder.id);
      const project = await createProject(c, founder.id, { listed: true });
      const offer = await createOffer(c, {
        projectId: project,
        entityId: entity,
        createdBy: founder.id,
      });
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM billing.fee_schedules WHERE code = 'operator_success_fee' AND version = 1`,
      );
      const id = uuidv7();
      await c.query(
        `INSERT INTO investments.investment_agreements
           (id, offer_id, investor_id, contract_amount, fee_schedule_id, document_s3_key,
            document_sha256, document_wrapped_dek, idempotency_key, status)
         VALUES ($1, $2, $3, 300000, $4, 'd', digest('d','sha256'), '\\x00'::bytea, $5,
                 'pending_signatures')`,
        [id, offer, investor.id, rows[0]!.id, `idem-${id}`],
      );
      return id;
    });

    const result = await callConfirm(agreementId, `bank-${uuidv7()}`, 300_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not signed by both parties/i);
  });
});

describe('Конкурентные доменные лимиты', () => {
  it('параллельные договоры не пробивают цель предложения', async () => {
    const { offerId, investors } = await inCommittedTx(async (c) => {
      const founder = await createUser(c);
      const entity = await createEntity(c, founder.id);
      const project = await createProject(c, founder.id, { listed: true });
      const offer = await createOffer(c, {
        projectId: project,
        entityId: entity,
        createdBy: founder.id,
        target: 1_000_000,
        min: 100_000,
      });
      const list: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const inv = await createUser(c, { role: 'investor' });
        await approveKyc(c, inv.id);
        list.push(inv.id);
      }
      return { offerId: offer, investors: list };
    });

    // Каждый пытается взять 400 000 при цели 1 000 000 — пройти должны максимум двое.
    const results = await Promise.all(
      investors.map(async (investorId) => {
        const client = await getPool().connect();
        try {
          await client.query('BEGIN');
          await createSignedAgreement(client, { offerId, investorId, amount: 400_000 });
          await client.query('COMMIT');
          return true;
        } catch {
          await client.query('ROLLBACK').catch(() => undefined);
          return false;
        } finally {
          client.release();
        }
      }),
    );

    const { rows } = await getPool().query<{ total: string }>(
      `SELECT coalesce(sum(contract_amount), 0)::text AS total
         FROM investments.investment_agreements
        WHERE offer_id = $1 AND status <> 'cancelled'`,
      [offerId],
    );
    expect(Number(rows[0]!.total)).toBeLessThanOrEqual(1_000_000);
    expect(results.filter(Boolean).length).toBe(2);
  });

  it('параллельная эмиссия событий не рвёт hash-chain', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        inCommittedTx(async (c) => {
          await c.query(
            `SELECT audit.app_emit_event('lab.season.opened', NULL, 'admin', 'season', NULL,
                                         $1::jsonb, 'parallel')`,
            [JSON.stringify({ i })],
          );
        }),
      ),
    );

    const { rows } = await getPool().query(`SELECT * FROM audit.verify_event_chain()`);
    expect(rows).toEqual([]);
  });

  it('параллельная выдача золотых билетов соблюдает лимит 2 за сезон', async () => {
    const { adminId, seasonId, projects } = await inCommittedTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const founder = await createUser(c);
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM seasons.seasons LIMIT 1`);
      const list: string[] = [];
      for (let i = 0; i < 5; i += 1) list.push(await createProject(c, founder.id));
      return { adminId: admin.id, seasonId: rows[0]!.id, projects: list };
    });

    const results = await Promise.all(
      projects.map(async (projectId) => {
        const client = await getPool().connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO seasons.golden_tickets (id, project_id, season_id, granted_by, reason)
             VALUES (public.uuid_generate_v7(), $1, $2, $3, 'гонка')`,
            [projectId, seasonId, adminId],
          );
          await client.query('COMMIT');
          return true;
        } catch {
          await client.query('ROLLBACK').catch(() => undefined);
          return false;
        } finally {
          client.release();
        }
      }),
    );

    expect(results.filter(Boolean).length).toBe(2);
  });
});
