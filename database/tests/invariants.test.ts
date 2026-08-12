/**
 * Инварианты схемы: то, что БД обязана не дать сломать даже при ошибке в
 * сервисном слое. Каждый тест — про конкретное правило из спецификации.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  actAs,
  approveKyc,
  closePool,
  createEntity,
  createOffer,
  createProject,
  createSignedAgreement,
  createFounderSubscription,
  createUser,
  getPool,
  inRollbackTx,
  uuidv7,
} from './helpers.ts';
import { readdirSync } from 'node:fs';
import { MIGRATIONS_DIR } from '../src/env.ts';

afterAll(async () => {
  await closePool();
});

describe('Согласия: append-only и блокирующая активация', () => {
  it('акцепт нельзя изменить', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await expect(
        c.query(`UPDATE identity.consents SET accepted_at = now() WHERE user_id = $1`, [user.id]),
      ).rejects.toThrow(/immutable/i);
    });
  });

  it('акцепт нельзя удалить', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await expect(
        c.query(`DELETE FROM identity.consents WHERE user_id = $1`, [user.id]),
      ).rejects.toThrow(/immutable/i);
    });
  });

  it('аккаунт НЕ активируется без акцепта commission_terms', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { activate: false });
      // Три из четырёх документов — активации быть не должно.
      await c.query(
        `INSERT INTO identity.consents (id, user_id, kind, version, locale, ip_hash)
         SELECT public.uuid_generate_v7(), $1, t.kind, t.version, t.locale, digest('ip','sha256')
         FROM identity.consent_templates t
         WHERE t.superseded_at IS NULL AND t.locale = 'ru-RU'
           AND t.kind IN ('platform_rules','tos','pdn')`,
        [user.id],
      );
      await expect(
        c.query(`UPDATE identity.users SET status = 'active' WHERE id = $1`, [user.id]),
      ).rejects.toThrow(/commission_terms/);
    });
  });

  it('аккаунт активируется при полном наборе акцептов', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { activate: true });
      const { rows } = await c.query<{ status: string }>(
        `SELECT status FROM identity.users WHERE id = $1`,
        [user.id],
      );
      expect(rows[0]!.status).toBe('active');
    });
  });

  it('has_required_consents отражает фактическое состояние', async () => {
    await inRollbackTx(async (c) => {
      const noConsents = await createUser(c, { activate: false });
      const full = await createUser(c, { activate: true });
      const { rows } = await c.query<{ a: boolean; b: boolean }>(
        `SELECT identity.has_required_consents($1) AS a, identity.has_required_consents($2) AS b`,
        [noConsents.id, full.id],
      );
      expect(rows[0]!.a).toBe(false);
      expect(rows[0]!.b).toBe(true);
    });
  });
});

describe('Журнал событий: append-only и hash-chain', () => {
  it('событие нельзя изменить', async () => {
    await inRollbackTx(async (c) => {
      await c.query(
        `SELECT audit.app_emit_event('lab.season.opened', NULL, 'admin', 'season', NULL,
                                     '{}'::jsonb, 'trace-inv')`,
      );
      await expect(c.query(`UPDATE audit.events SET verb = 'lab.season.closed'`)).rejects.toThrow(
        /append-only/i,
      );
    });
  });

  // Отдельная транзакция: первая же ошибка переводит текущую в aborted, и
  // следующий запрос упал бы с «current transaction is aborted» — тест был бы
  // зелёным по неверной причине.
  it('событие нельзя удалить', async () => {
    await inRollbackTx(async (c) => {
      await c.query(
        `SELECT audit.app_emit_event('lab.season.opened', NULL, 'admin', 'season', NULL,
                                     '{}'::jsonb, 'trace-inv-2')`,
      );
      await expect(c.query(`DELETE FROM audit.events`)).rejects.toThrow(/append-only/i);
    });
  });

  it('недопустимая роль актора отвергается', async () => {
    await inRollbackTx(async (c) => {
      await expect(
        c.query(
          `SELECT audit.app_emit_event('billing.commission.accrued', NULL, 'founder', 'x', NULL,
                                       '{}'::jsonb, 't')`,
        ),
      ).rejects.toThrow(/not allowed/i);
    });
  });

  it('цепочка хешей цела после серии событий', async () => {
    await inRollbackTx(async (c) => {
      for (let i = 0; i < 5; i += 1) {
        await c.query(
          `SELECT audit.app_emit_event('lab.season.opened', NULL, 'admin', 'season', NULL,
                                       $1::jsonb, 'chain')`,
          [JSON.stringify({ i })],
        );
      }
      const { rows } = await c.query(`SELECT * FROM audit.verify_event_chain()`);
      expect(rows).toEqual([]);
    });
  });
});

describe('IRS и рейтинг не переписываются', () => {
  it('irs_scores append-only', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      await c.query(
        `INSERT INTO scoring.irs_scores (id, project_id, value) VALUES (public.uuid_generate_v7(), $1, 42)`,
        [project],
      );
      await expect(
        c.query(`UPDATE scoring.irs_scores SET value = 99 WHERE project_id = $1`, [project]),
      ).rejects.toThrow(/append-only|not for sale/i);
    });
  });

  it('delta обязана соответствовать value - previous_value', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      await expect(
        c.query(
          `INSERT INTO scoring.irs_scores (id, project_id, value, previous_value, delta)
           VALUES (public.uuid_generate_v7(), $1, 50, 40, 99)`,
          [project],
        ),
      ).rejects.toThrow();
    });
  });
});

describe('Тарифы: резолвер и неизменяемость', () => {
  it.each([
    [500_000, 'founder_t1'],
    [1_000_000, 'founder_t1'],
    [1_000_001, 'founder_t2'],
    [10_000_000, 'founder_t2'],
    [10_000_001, 'founder_t3'],
    [100_000_000, 'founder_t3'],
    [100_000_001, 'founder_t4'],
    [1_000_000_000, 'founder_t4'],
    [1_000_000_001, 'founder_t5'],
  ])('запрос %s ₽ резолвится в %s', async (ask, expectedCode) => {
    const { rows } = await getPool().query<{ code: string }>(
      `SELECT code FROM billing.subscription_plans WHERE id = billing.resolve_founder_plan($1)`,
      [ask],
    );
    expect(rows[0]?.code).toBe(expectedCode);
  });

  it('условия вознаграждения неизменяемы — только новая версия', async () => {
    await inRollbackTx(async (c) => {
      await expect(
        c.query(
          `UPDATE billing.fee_schedules SET investor_fee_pct = 20 WHERE code = 'operator_success_fee'`,
        ),
      ).rejects.toThrow(/immutable/i);
    });
  });

  it('fee schedule нельзя удалить', async () => {
    await inRollbackTx(async (c) => {
      await expect(
        c.query(`DELETE FROM billing.fee_schedules WHERE code = 'operator_success_fee'`),
      ).rejects.toThrow(/cannot be deleted/i);
    });
  });

  it('пересекающиеся периоды действия одного тарифа отвергаются', async () => {
    await inRollbackTx(async (c) => {
      await expect(
        c.query(
          `INSERT INTO billing.subscription_plans
             (id, code, version, audience, name, ask_limit, price, valid_from)
           VALUES (public.uuid_generate_v7(), 'founder_t1', 2, 'founder', 'Дубль', 1000000, 5990,
                   '2026-09-01T00:00:00Z')`,
        ),
      ).rejects.toThrow(/overlapping/i);
    });
  });

  it('сид содержит ровно 10%/5%', async () => {
    const { rows } = await getPool().query<{ investor: string; issuer: string }>(
      `SELECT investor_fee_pct::text AS investor, issuer_fee_pct::text AS issuer
         FROM billing.fee_schedules WHERE code = 'operator_success_fee' AND version = 1`,
    );
    expect(rows[0]!.investor).toBe('10.00');
    expect(rows[0]!.issuer).toBe('5.00');
  });
});

describe('Подписки: форма и листинг', () => {
  it('подписка основателя без проекта отвергается', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await expect(
        c.query(
          `INSERT INTO billing.subscriptions
             (id, user_id, plan_id, project_id, price_snapshot, terms_version, status)
           SELECT public.uuid_generate_v7(), $1, id, NULL, price, 'v1', 'active'
             FROM billing.subscription_plans WHERE code = 'founder_t1' AND version = 1`,
          [user.id],
        ),
      ).rejects.toThrow(/requires project_id/i);
    });
  });

  it('подписка инвестора с проектом отвергается', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      const project = await createProject(c, user.id);
      await expect(
        c.query(
          `INSERT INTO billing.subscriptions
             (id, user_id, plan_id, project_id, price_snapshot, terms_version, status)
           SELECT public.uuid_generate_v7(), $1, id, $2, price, 'v1', 'active'
             FROM billing.subscription_plans WHERE code = 'investor_membership' AND version = 1`,
          [user.id, project],
        ),
      ).rejects.toThrow(/must not reference a project/i);
    });
  });

  it('снапшот цены обязан совпадать с ценой тарифа', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await expect(
        c.query(
          `INSERT INTO billing.subscriptions
             (id, user_id, plan_id, project_id, price_snapshot, terms_version, status)
           SELECT public.uuid_generate_v7(), $1, id, NULL, 1, 'v1', 'active'
             FROM billing.subscription_plans WHERE code = 'investor_membership' AND version = 1`,
          [user.id],
        ),
      ).rejects.toThrow(/does not match plan price/i);
    });
  });

  it('тариф t5 требует утверждённой индивидуальной цены по правилу 4 глаз', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      const project = await createProject(c, user.id, { ask: 2_000_000_000 });
      await expect(
        c.query(
          `INSERT INTO billing.subscriptions
             (id, user_id, plan_id, project_id, price_snapshot, terms_version, status)
           SELECT public.uuid_generate_v7(), $1, id, $2, 500000, 'v1', 'active'
             FROM billing.subscription_plans WHERE code = 'founder_t5' AND version = 1`,
          [user.id, project],
        ),
      ).rejects.toThrow(/custom_price/i);
    });
  });

  it('один и тот же человек не может назначить и утвердить индивидуальную цену', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      const admin = await createUser(c, { role: 'admin' });
      const project = await createProject(c, user.id, { ask: 2_000_000_000 });
      await expect(
        c.query(
          `INSERT INTO billing.subscriptions
             (id, user_id, plan_id, project_id, price_snapshot, terms_version, status,
              custom_price, custom_price_set_by, custom_price_approved_by)
           SELECT public.uuid_generate_v7(), $1, id, $2, 500000, 'v1', 'active', 500000, $3, $3
             FROM billing.subscription_plans WHERE code = 'founder_t5' AND version = 1`,
          [user.id, project, admin.id],
        ),
      ).rejects.toThrow();
    });
  });

  // Триггер публикации листинга — DEFERRABLE INITIALLY DEFERRED: в проде он
  // срабатывает на COMMIT, поэтому в тесте его нужно принудительно
  // материализовать через SET CONSTRAINTS ALL IMMEDIATE. Без этого тест был бы
  // зелёным просто потому, что проверка ещё не выполнялась.
  it('листинг без активной подписки невозможен', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id, { listed: false });
      await c.query(
        `UPDATE lab.projects SET listing_status = 'listed', listed_at = now() WHERE id = $1`,
        [project],
      );
      await expect(c.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(
        /active subscription/i,
      );
    });
  });

  it('рост запроса инвестиций сверх лимита тарифа блокирует публикацию', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id, { ask: 500_000, listed: true });
      // Запрос вырос до уровня t3, а подписка и required_plan_id остались t1.
      await c.query(`UPDATE lab.projects SET investment_ask = 50000000 WHERE id = $1`, [project]);
      await expect(c.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(
        /upgrade needed|active subscription/i,
      );
    });
  });
});

describe('Регулируемый контур: лимиты и антифрод', () => {
  it('инвестор не может инвестировать в проект, где он в команде', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const investor = await createUser(c, { role: 'investor' });
      await approveKyc(c, investor.id);
      const entity = await createEntity(c, founder.id);
      const project = await createProject(c, founder.id, { listed: true });
      // Инвестор — сооснователь того же проекта.
      await c.query(
        `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'cofounder')`,
        [project, investor.id],
      );
      const offer = await createOffer(c, {
        projectId: project,
        entityId: entity,
        createdBy: founder.id,
      });
      await expect(
        createSignedAgreement(c, { offerId: offer, investorId: investor.id }),
      ).rejects.toThrow(/self-deal/i);
    });
  });

  it('инвестор без действующего KYC не может заключить договор', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const investor = await createUser(c, { role: 'investor' });
      const entity = await createEntity(c, founder.id);
      const project = await createProject(c, founder.id, { listed: true });
      const offer = await createOffer(c, {
        projectId: project,
        entityId: entity,
        createdBy: founder.id,
      });
      await expect(
        createSignedAgreement(c, { offerId: offer, investorId: investor.id }),
      ).rejects.toThrow(/KYC is not valid/i);
    });
  });

  it('ЛПИ без действующего KYB не может привлекать инвестиции', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const investor = await createUser(c, { role: 'investor' });
      await approveKyc(c, investor.id);
      const entity = await createEntity(c, founder.id, { approvedKyb: false });
      const project = await createProject(c, founder.id, { listed: true });
      const offer = await createOffer(c, {
        projectId: project,
        entityId: entity,
        createdBy: founder.id,
      });
      await expect(
        createSignedAgreement(c, { offerId: offer, investorId: investor.id }),
      ).rejects.toThrow(/KYB is not valid/i);
    });
  });

  it('сумма договоров не превышает цель предложения', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const investor = await createUser(c, { role: 'investor' });
      await approveKyc(c, investor.id);
      const entity = await createEntity(c, founder.id);
      const project = await createProject(c, founder.id, { listed: true });
      const offer = await createOffer(c, {
        projectId: project,
        entityId: entity,
        createdBy: founder.id,
        target: 1_000_000,
        min: 100_000,
      });
      await createSignedAgreement(c, { offerId: offer, investorId: investor.id, amount: 900_000 });
      const other = await createUser(c, { role: 'investor' });
      await approveKyc(c, other.id);
      await expect(
        createSignedAgreement(c, { offerId: offer, investorId: other.id, amount: 200_000 }),
      ).rejects.toThrow(/capacity exceeded/i);
    });
  });

  it('сумма траншей не превышает сумму договора', async () => {
    await inRollbackTx(async (c) => {
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
      const agreement = await createSignedAgreement(c, {
        offerId: offer,
        investorId: investor.id,
        amount: 1_000_000,
      });
      await expect(
        c.query(
          `INSERT INTO investments.investment_tranches (id, agreement_id, tranche_no, amount)
           VALUES (public.uuid_generate_v7(), $1, 1, 2000000)`,
          [agreement],
        ),
      ).rejects.toThrow(/exceeds contract_amount/i);
    });
  });

  it('недопустимый переход статуса договора отвергается', async () => {
    await inRollbackTx(async (c) => {
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
      const agreement = await createSignedAgreement(c, { offerId: offer, investorId: investor.id });
      // signed → completed напрямую недопустим.
      await expect(
        c.query(
          `UPDATE investments.investment_agreements SET status = 'completed', effective_at = now()
            WHERE id = $1`,
          [agreement],
        ),
      ).rejects.toThrow(/illegal agreement transition/i);
    });
  });

  it('сумма договора неизменяема после подписания', async () => {
    await inRollbackTx(async (c) => {
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
      const agreement = await createSignedAgreement(c, { offerId: offer, investorId: investor.id });
      await expect(
        c.query(`UPDATE investments.investment_agreements SET contract_amount = 1 WHERE id = $1`, [
          agreement,
        ]),
      ).rejects.toThrow(/immutable after signing/i);
    });
  });

  it('банковская операция append-only', async () => {
    await inRollbackTx(async (c) => {
      await c.query(
        `INSERT INTO investments.nominal_account_transactions
           (id, bank_transaction_ref, direction, amount, booked_at, raw_statement_sha256)
         VALUES (public.uuid_generate_v7(), 'inv-ref-1', 'incoming', 100, now(), digest('s','sha256'))`,
      );
      await expect(
        c.query(
          `UPDATE investments.nominal_account_transactions SET amount = 1 WHERE bank_transaction_ref = 'inv-ref-1'`,
        ),
      ).rejects.toThrow(/append-only/i);
    });
  });
});

describe('Прочие доменные инварианты', () => {
  it('доли бенефициаров не превышают 100%', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c);
      const second = await createUser(c);
      const entity = await createEntity(c, owner.id);
      await c.query(
        `INSERT INTO kyc.entity_members (entity_id, user_id, member_role, share_pct)
         VALUES ($1, $2, 'beneficial_owner', 60)`,
        [entity, owner.id],
      );
      await expect(
        c.query(
          `INSERT INTO kyc.entity_members (entity_id, user_id, member_role, share_pct)
           VALUES ($1, $2, 'beneficial_owner', 50)`,
          [entity, second.id],
        ),
      ).rejects.toThrow(/exceed 100/i);
    });
  });

  it('лимит золотых билетов — 2 на организатора за сезон', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const founder = await createUser(c);
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM seasons.seasons LIMIT 1`);
      const seasonId = rows[0]!.id;
      for (let i = 0; i < 2; i += 1) {
        const project = await createProject(c, founder.id);
        await c.query(
          `INSERT INTO seasons.golden_tickets (id, project_id, season_id, granted_by, reason)
           VALUES (public.uuid_generate_v7(), $1, $2, $3, 'тест')`,
          [project, seasonId, admin.id],
        );
      }
      const third = await createProject(c, founder.id);
      await expect(
        c.query(
          `INSERT INTO seasons.golden_tickets (id, project_id, season_id, granted_by, reason)
           VALUES (public.uuid_generate_v7(), $1, $2, $3, 'третий')`,
          [third, seasonId, admin.id],
        ),
      ).rejects.toThrow(/limit reached/i);
    });
  });

  it('версия заявки append-only', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM seasons.seasons LIMIT 1`);
      await c.query(
        `INSERT INTO lab.project_versions (id, project_id, season_id, version_no, snapshot_jsonb)
         VALUES (public.uuid_generate_v7(), $1, $2, 1, '{}'::jsonb)`,
        [project, rows[0]!.id],
      );
      await expect(
        c.query(
          `UPDATE lab.project_versions SET snapshot_jsonb = '{"x":1}'::jsonb WHERE project_id = $1`,
          [project],
        ),
      ).rejects.toThrow(/append-only/i);
    });
  });

  it('вебхук на внутренний адрес отвергается (защита от SSRF)', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const accountId = uuidv7();
      await c.query(
        `INSERT INTO integration.service_accounts
           (id, client_id, name, client_secret_hash, mtls_cert_fingerprint, scopes, created_by)
         VALUES ($1, $2, 'test', 'argon2id$hash', 'fp', ARRAY['deals:read'], $3)`,
        [accountId, `client-${accountId.slice(0, 8)}`, admin.id],
      );
      for (const url of [
        'https://127.0.0.1/hook',
        'https://169.254.169.254/latest/meta-data',
        'https://10.0.0.5/hook',
        'https://metadata.internal/hook',
        'http://example.com/hook',
      ]) {
        await expect(
          c.query(
            `INSERT INTO integration.webhook_endpoints
               (id, service_account_id, url, subscribed_verbs, secret_ciphertext,
                secret_kms_key_id, secret_fingerprint)
             VALUES (public.uuid_generate_v7(), $1, $2, ARRAY['lab.project.graduated'],
                     '\\x00'::bytea, 'kms', '\\x00'::bytea)`,
            [accountId, url],
          ),
        ).rejects.toThrow();
      }
    });
  });

  it('скоуп вне allowlist отвергается', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      await expect(
        c.query(
          `INSERT INTO integration.service_accounts
             (id, client_id, name, client_secret_hash, mtls_cert_fingerprint, scopes, created_by)
           VALUES (public.uuid_generate_v7(), 'c-evil', 'evil', 'h', 'fp',
                   ARRAY['deals:read','admin:all'], $1)`,
          [admin.id],
        ),
      ).rejects.toThrow();
    });
  });

  it('security и billing уведомления нельзя отключить', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await actAs(c, { userId: user.id, roles: ['founder'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO comms.notification_preferences (user_id, channel, topic, enabled)
           VALUES ($1, 'email', 'security', false)`,
          [user.id],
        ),
      ).rejects.toThrow();
    });
  });

  it('регулируемый контур закрыт фичефлагом до гейта A', async () => {
    const { rows } = await getPool().query<{ key: string; enabled: boolean }>(
      `SELECT key, enabled FROM audit.feature_flags WHERE key LIKE 'investments%' ORDER BY key`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.enabled === false)).toBe(true);
  });
});

describe('Комплаенс: барьеры самоодобрения (M013)', () => {
  it('решение по верификации без проверяющего отвергается', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await expect(
        c.query(
          `INSERT INTO kyc.kyc_verifications (id, user_id, kind, status, decided_at)
           VALUES (public.uuid_generate_v7(), $1, 'identity', 'approved', now())`,
          [user.id],
        ),
      ).rejects.toThrow(/проверяющего/);
    });
  });

  it('администратор не может одобрить СВОЮ верификацию', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      await expect(
        c.query(
          `INSERT INTO kyc.kyc_verifications (id, user_id, kind, status, reviewed_by, decided_at)
           VALUES (public.uuid_generate_v7(), $1, 'identity', 'approved', $1, now())`,
          [admin.id],
        ),
      ).rejects.toThrow(/самоодобрение/);
    });
  });

  it('заявка в статусе pending проверяющего не требует', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await c.query(
        `INSERT INTO kyc.kyc_verifications (id, user_id, kind, status)
         VALUES (public.uuid_generate_v7(), $1, 'identity', 'pending')`,
        [user.id],
      );
      const { rows } = await c.query(
        'SELECT status FROM kyc.kyc_verifications WHERE user_id = $1',
        [user.id],
      );
      expect(rows[0]?.status).toBe('pending');
    });
  });

  it('владелец юрлица не может одобрить его проверку', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c);
      const entityId = await createEntity(c, owner.id, { approvedKyb: false });
      await expect(
        c.query(
          `INSERT INTO kyc.kyb_verifications (id, entity_id, kind, status, reviewed_by, decided_at)
           VALUES (public.uuid_generate_v7(), $1, 'registry_check', 'approved', $2, now())`,
          [entityId, owner.id],
        ),
      ).rejects.toThrow(/связан с юрлицом/);
    });
  });
});

describe('Публичный поиск не раскрывает непубличные поля (M013)', () => {
  it('описание проекта в публичный поисковый вектор не попадает', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      await c.query(
        `UPDATE lab.projects
            SET title = 'Публичный заголовок', tagline = 'Публичный слоган',
                description = 'Секретнаяметрика выручки'
          WHERE id = $1`,
        [project],
      );

      const { rows } = await c.query<{ public_hit: boolean; private_hit: boolean }>(
        `SELECT public_search_tsv @@ plainto_tsquery('russian', 'секретнаяметрика') AS public_hit,
                search_tsv        @@ plainto_tsquery('russian', 'секретнаяметрика') AS private_hit
           FROM lab.projects WHERE id = $1`,
        [project],
      );
      expect(rows[0]?.private_hit).toBe(true);
      expect(rows[0]?.public_hit).toBe(false);
    });
  });

  it('публичной роли выданы права ровно на allowlist колонок каталога', async () => {
    const { rows } = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'app_public_read' AND table_schema = 'lab' AND table_name = 'projects'
        ORDER BY column_name`,
    );
    const granted = rows.map((r) => r.column_name);
    expect(granted).toContain('public_search_tsv');
    // Описание и свободный teaser_jsonb публичной роли недоступны.
    expect(granted).not.toContain('description');
    expect(granted).not.toContain('teaser_jsonb');
    expect(granted).not.toContain('search_tsv');
  });
});

describe('Тарифы: история цен неизменяема (M015–M016)', () => {
  it('цену действующей версии переписать нельзя', async () => {
    await inRollbackTx(async (c) => {
      const [plan] = (
        await c.query(`SELECT id FROM billing.subscription_plans
                        WHERE valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
                        LIMIT 1`)
      ).rows;
      await expect(
        c.query('UPDATE billing.subscription_plans SET price = 1 WHERE id = $1', [plan.id]),
      ).rejects.toThrow(/immutable/);
    });
  });

  it('снять с продажи (проставить valid_to) действующую версию можно', async () => {
    await inRollbackTx(async (c) => {
      const [plan] = (
        await c.query(`SELECT id FROM billing.subscription_plans
                        WHERE valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
                        LIMIT 1`)
      ).rows;
      await c.query(
        `UPDATE billing.subscription_plans SET valid_to = now() + interval '1 day' WHERE id = $1`,
        [plan.id],
      );
      const { rows } = await c.query(
        'SELECT valid_to FROM billing.subscription_plans WHERE id = $1',
        [plan.id],
      );
      expect(rows[0]?.valid_to).not.toBeNull();
    });
  });

  it('объявленную будущую версию можно править и удалить', async () => {
    await inRollbackTx(async (c) => {
      const id = uuidv7();
      // Периоды версий одного тарифа не пересекаются: как и сервис, сначала
      // закрываем действующую версию тем моментом, с которого начнётся новая.
      await c.query(
        `UPDATE billing.subscription_plans SET valid_to = now() + interval '10 days'
          WHERE code = 'founder_t3' AND valid_to IS NULL`,
      );
      await c.query(
        `INSERT INTO billing.subscription_plans
           (id, code, version, audience, name, price, valid_from)
         VALUES ($1, 'founder_t3', 99, 'founder', 'Будущая цена', 31990,
                 now() + interval '10 days')`,
        [id],
      );
      await c.query('UPDATE billing.subscription_plans SET price = 32990 WHERE id = $1', [id]);
      await c.query('DELETE FROM billing.subscription_plans WHERE id = $1', [id]);
      const { rows } = await c.query('SELECT 1 FROM billing.subscription_plans WHERE id = $1', [
        id,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  it('удалить действующую версию нельзя', async () => {
    await inRollbackTx(async (c) => {
      const [plan] = (
        await c.query(`SELECT id FROM billing.subscription_plans
                        WHERE valid_from <= now() LIMIT 1`)
      ).rows;
      await expect(
        c.query('DELETE FROM billing.subscription_plans WHERE id = $1', [plan.id]),
      ).rejects.toThrow(/уже действует|действовала/);
    });
  });
});

describe('Индивидуальная цена: четыре глаза (M017)', () => {
  it('предложивший цену не может утвердить её сам', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const admin = await createUser(c, { role: 'admin' });
      const project = await createProject(c, founder.id);
      const subscription = await createFounderSubscription(c, founder.id, project);

      await expect(
        c.query(
          `INSERT INTO billing.custom_price_proposals
             (id, subscription_id, price, reason, proposed_by, approved_by, approved_at, status)
           VALUES (public.uuid_generate_v7(), $1, 1000, 'пилот', $2, $2, now(), 'approved')`,
          [subscription, admin.id],
        ),
      ).rejects.toThrow();
    });
  });

  it('два ожидающих предложения на одну подписку невозможны', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const admin = await createUser(c, { role: 'admin' });
      const project = await createProject(c, founder.id);
      const subscription = await createFounderSubscription(c, founder.id, project);

      const insert = () =>
        c.query(
          `INSERT INTO billing.custom_price_proposals
             (id, subscription_id, price, reason, proposed_by)
           VALUES (public.uuid_generate_v7(), $1, 1000, 'пилот', $2)`,
          [subscription, admin.id],
        );
      await insert();
      await expect(insert()).rejects.toThrow();
    });
  });

  it('подписка с назначенной, но не утверждённой ценой невозможна', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const admin = await createUser(c, { role: 'admin' });
      const project = await createProject(c, founder.id);
      const subscription = await createFounderSubscription(c, founder.id, project);

      await expect(
        c.query(
          `UPDATE billing.subscriptions
              SET custom_price = 1000, custom_price_set_by = $2, price_snapshot = 1000
            WHERE id = $1`,
          [subscription, admin.id],
        ),
      ).rejects.toThrow();
    });
  });
});

describe('Тестовая БД соответствует дереву миграций', () => {
  it('в журнале миграций нет пропусков относительно каталога', async () => {
    // Локальная тестовая БД отставала на 14 миграций, и весь набор тестов был
    // зелёным по неверной причине: проверки шли против СТАРОЙ схемы. Один
    // прыжок статуса `draft -> graduated` и число таблиц 61 держались именно
    // на этом. Проверка обязана падать первой, а не оставлять разбираться в
    // странных отказах ниже по списку.
    const applied = await getPool().query<{ id: string }>(
      'SELECT id FROM public.schema_migrations ORDER BY id',
    );
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
    const missing = onDisk.filter((id) => !applied.rows.some((r) => r.id === id));
    expect(
      missing,
      'не применены миграции — прогони NODE_ENV=test npm run migrate -w database',
    ).toEqual([]);
  });
});
