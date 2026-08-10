/**
 * Негативные тесты RLS — обязательный гейт CI (Database_Launch.md §15).
 *
 * Каждый тест отвечает на вопрос «может ли роль X добраться до данных, к
 * которым не должна?». Зелёный тест здесь означает «НЕ может».
 *
 * Все проверки выполняются под настоящими сервисными ролями через SET ROLE.
 * Проверка от имени владителя схем доказывала бы права владельца, а не
 * приложения, и была бы зелёной по неверной причине.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  actAs,
  approveKyc,
  closePool,
  createEntity,
  createInvestorSubscription,
  createOffer,
  createProject,
  createSignedAgreement,
  createUser,
  getPool,
  inRollbackTx,
} from './helpers.ts';

afterAll(async () => {
  await closePool();
});

describe('RLS: изоляция проектов', () => {
  it('основатель не видит чужой проект', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const bob = await createUser(c, { role: 'founder' });
      const aliceProject = await createProject(c, alice.id);

      await actAs(c, { userId: bob.id, roles: ['founder'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [aliceProject]);
      expect(rows).toHaveLength(0);
    });
  });

  it('владелец видит свой проект', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const project = await createProject(c, alice.id);

      await actAs(c, { userId: alice.id, roles: ['founder'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [project]);
      expect(rows).toHaveLength(1);
    });
  });

  it('инвестор БЕЗ подписки не видит листинг', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const project = await createProject(c, founder.id, { listed: true });

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [project]);
      expect(rows).toHaveLength(0);
    });
  });

  it('инвестор С подпиской видит листинг', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const project = await createProject(c, founder.id, { listed: true });
      await createInvestorSubscription(c, investor.id);

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [project]);
      expect(rows).toHaveLength(1);
    });
  });

  it('инвестор с подпиской НЕ видит нелистинговый проект', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const project = await createProject(c, founder.id, { listed: false });
      await createInvestorSubscription(c, investor.id);

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [project]);
      expect(rows).toHaveLength(0);
    });
  });

  it('эксперт не видит неназначенный проект', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const expert = await createUser(c, { role: 'expert' });
      const project = await createProject(c, founder.id);

      await actAs(c, { userId: expert.id, roles: ['expert'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [project]);
      expect(rows).toHaveLength(0);
    });
  });
});

describe('RLS: паспорт и скоринг', () => {
  it('инвестор без подписки не видит полный паспорт', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const project = await createProject(c, founder.id, { listed: true });
      await c.query(
        `INSERT INTO scoring.investment_passports (id, project_id, version, jsonb_data,
                                                   disclosure_tier, published_at)
         VALUES (public.uuid_generate_v7(), $1, 1, '{}'::jsonb, 'full', now())`,
        [project],
      );

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query(
        'SELECT id FROM scoring.investment_passports WHERE project_id = $1',
        [project],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it('tier=dataroom не выдаётся инвестору даже с подпиской', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const project = await createProject(c, founder.id, { listed: true });
      await createInvestorSubscription(c, investor.id);
      await c.query(
        `INSERT INTO scoring.investment_passports (id, project_id, version, jsonb_data,
                                                   disclosure_tier, published_at)
         VALUES (public.uuid_generate_v7(), $1, 1, '{}'::jsonb, 'dataroom', now())`,
        [project],
      );

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query(
        'SELECT id FROM scoring.investment_passports WHERE project_id = $1',
        [project],
      );
      expect(rows).toHaveLength(0);
    });
  });
});

describe('RLS: регулируемый инвестконтур', () => {
  it('посторонний не видит чужой договор', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const stranger = await createUser(c, { role: 'investor' });
      await approveKyc(c, investor.id);
      const entity = await createEntity(c, founder.id);
      const project = await createProject(c, founder.id, { listed: true });
      const offer = await createOffer(c, {
        projectId: project,
        entityId: entity,
        createdBy: founder.id,
      });
      const agreement = await createSignedAgreement(c, { offerId: offer, investorId: investor.id });

      await actAs(c, { userId: stranger.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query(
        'SELECT id FROM investments.investment_agreements WHERE id = $1',
        [agreement],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it('инвестор видит СВОЙ договор', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      await approveKyc(c, investor.id);
      const entity = await createEntity(c, founder.id);
      const project = await createProject(c, founder.id, { listed: true });
      const offer = await createOffer(c, {
        projectId: project,
        entityId: entity,
        createdBy: founder.id,
      });
      const agreement = await createSignedAgreement(c, { offerId: offer, investorId: investor.id });

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query(
        'SELECT id FROM investments.investment_agreements WHERE id = $1',
        [agreement],
      );
      expect(rows).toHaveLength(1);
    });
  });

  it('выписка номинального счёта недоступна роли основного API', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { role: 'investor' });
      await c.query(
        `INSERT INTO investments.nominal_account_transactions
           (id, bank_transaction_ref, direction, amount, booked_at, raw_statement_sha256)
         VALUES (public.uuid_generate_v7(), 'ref-rls-1', 'incoming', 1000, now(), digest('s','sha256'))`,
      );

      // app_backend не получает GRANT на банковскую выписку вовсе — защита
      // срабатывает на уровне привилегий, ещё до RLS. Это сильнее, чем
      // «политика вернула ноль строк».
      await actAs(c, { userId: user.id, roles: ['investor'], dbRole: 'app_backend' });
      await expect(
        c.query('SELECT id FROM investments.nominal_account_transactions'),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});

describe('RLS: разделение денежных прав между ролями БД', () => {
  it('app_backend не может подтвердить транш', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      await approveKyc(c, investor.id);
      const entity = await createEntity(c, founder.id);
      const project = await createProject(c, founder.id, { listed: true });
      const offer = await createOffer(c, {
        projectId: project,
        entityId: entity,
        createdBy: founder.id,
      });
      const agreement = await createSignedAgreement(c, { offerId: offer, investorId: investor.id });

      await actAs(c, { userId: null, roles: ['system'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO investments.investment_tranches
             (id, agreement_id, tranche_no, amount, status, transferred_at, confirmed_at)
           VALUES (public.uuid_generate_v7(), $1, 1, 1000, 'confirmed', now(), now())`,
          [agreement],
        ),
      ).rejects.toThrow();
    });
  });

  it('app_backend не может создать начисление вознаграждения', async () => {
    await inRollbackTx(async (c) => {
      await actAs(c, { userId: null, roles: ['system'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO billing.commission_accruals
             (id, agreement_id, trigger_tranche_id, fee_schedule_id, base_amount,
              investor_fee_pct, issuer_fee_pct)
           VALUES (public.uuid_generate_v7(), public.uuid_generate_v7(), public.uuid_generate_v7(),
                   public.uuid_generate_v7(), 1000, 10, 5)`,
        ),
      ).rejects.toThrow();
    });
  });

  it('ни одна роль приложения не может писать напрямую в журнал событий', async () => {
    for (const role of ['app_backend', 'app_investments', 'app_billing', 'app_integration']) {
      await inRollbackTx(async (c) => {
        await actAs(c, { userId: null, roles: ['system'], dbRole: role });
        await expect(
          c.query(
            `INSERT INTO audit.events (id, verb, actor_role, context_jsonb)
             VALUES (public.uuid_generate_v7(), 'lab.season.opened', 'admin', '{}'::jsonb)`,
          ),
        ).rejects.toThrow();
      });
    }
  });

  it('публичная роль не читает служебные колонки проекта', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      await createProject(c, founder.id, { listed: true });

      await actAs(c, { userId: null, roles: [], dbRole: 'app_public_read' });
      // Разрешённый allowlist читается.
      const allowed = await c.query('SELECT id, title FROM lab.v_public_catalog LIMIT 1');
      expect(allowed.rows.length).toBeGreaterThanOrEqual(0);
      // Служебные колонки — нет.
      await expect(c.query('SELECT teaser_jsonb FROM lab.projects LIMIT 1')).rejects.toThrow();
      await expect(c.query('SELECT status FROM lab.projects LIMIT 1')).rejects.toThrow();
    });
  });

  it('ни одна роль приложения не имеет BYPASSRLS', async () => {
    const { rows } = await getPool().query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname LIKE 'app\\_%' AND rolbypassrls`,
    );
    expect(rows.map((r) => r.rolname)).toEqual([]);
  });
});

describe('RLS: покрытие манифеста', () => {
  it('каждая доменная таблица имеет ENABLE + FORCE RLS и хотя бы одну политику', async () => {
    const { rows } = await getPool().query<{ table_name: string; reason: string }>(
      `SELECT n.nspname || '.' || c.relname AS table_name,
              CASE WHEN NOT c.relrowsecurity THEN 'RLS не включён'
                   WHEN NOT c.relforcerowsecurity THEN 'RLS не FORCE'
                   ELSE 'нет ни одной политики' END AS reason
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('identity','kyc','lab','investments','scoring','experts',
                            'seasons','comms','billing','audit','integration')
          AND c.relkind IN ('r','p')
          AND c.relispartition = false
          AND (NOT c.relrowsecurity
               OR NOT c.relforcerowsecurity
               OR NOT EXISTS (SELECT 1 FROM pg_policies p
                              WHERE p.schemaname = n.nspname AND p.tablename = c.relname))
        ORDER BY 1`,
    );
    expect(rows).toEqual([]);
  });

  it('схема соответствует спецификации: 11 схем и 60 таблиц', async () => {
    const schemas = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.schemata
        WHERE schema_name IN ('identity','kyc','lab','investments','scoring','experts',
                              'seasons','comms','billing','audit','integration')`,
    );
    expect(Number(schemas.rows[0]!.count)).toBe(11);

    const tables = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('identity','kyc','lab','investments','scoring','experts',
                            'seasons','comms','billing','audit','integration')
          AND c.relkind IN ('r','p') AND c.relispartition = false`,
    );
    expect(Number(tables.rows[0]!.count)).toBe(60);
  });
});
