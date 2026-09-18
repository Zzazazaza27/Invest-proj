/**
 * Раунды привлечения и страны обслуживания (M081/M082, план 0.2 §0г).
 *
 * Проверяется то, что обещают решения владельца 2026-09-18: одна
 * незавершённая кампания на проект (open ИЛИ paused занимают место);
 * основание раунда — версия того же проекта; незавершённый раунд обязан быть
 * заполнен; смена основания оставляет тот же раунд и пишет историю; профиль
 * подаётся без суммы; раунд не виден постороннему и инвестору (до 5.7);
 * условия страны читает вошедший, пишет администратор; список стран доступен
 * анонимной регистрации.
 *
 * Все проверки доступа — под настоящей ролью app_backend через SET ROLE.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers.ts';
import {
  actAs,
  closePool,
  createProject,
  createUser,
  expectError,
  inRollbackTx,
  resetRole,
  uuidv7,
} from './helpers.ts';

afterAll(async () => {
  await closePool();
});

/**
 * Ожидаемая ошибка внутри транзакции теста: без SAVEPOINT PostgreSQL
 * отвергает все последующие запросы («current transaction is aborted»).
 */
async function failing(c: Client, fn: () => Promise<unknown>): Promise<Error> {
  await c.query('SAVEPOINT expect_fail');
  try {
    return await expectError(fn);
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT expect_fail');
  }
}

/** Поданная версия профиля — основание раунда. */
async function submitVersion(c: Client, projectId: string): Promise<string> {
  const id = uuidv7();
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM lab.investment_applications WHERE project_id = $1 LIMIT 1`,
    [projectId],
  );
  await c.query(
    `INSERT INTO lab.project_versions (id, project_id, application_id, version_no, snapshot_jsonb, schema_version)
     VALUES ($1, $2, $3, (SELECT COALESCE(MAX(version_no), 0) + 1 FROM lab.project_versions WHERE application_id = $3), '{}', 1)`,
    [id, projectId, rows[0]!.id],
  );
  return id;
}

async function insertRound(
  c: Client,
  opts: { projectId: string; versionId: string | null; status: string; by: string },
): Promise<string> {
  const id = uuidv7();
  const unfinished = opts.status === 'open' || opts.status === 'paused';
  await c.query(
    `INSERT INTO lab.funding_rounds
       (id, project_id, application_version_id, schema_version, status, funding_scope,
        target, currency, service_country, policy_version, opened_at, created_by)
     VALUES ($1, $2, $3, 1, $4, 'project',
             CASE WHEN $5 THEN 3000000 END, CASE WHEN $5 THEN 'RUB' END,
             CASE WHEN $5 THEN 'ru' END, CASE WHEN $5 THEN 1 END,
             CASE WHEN $5 THEN now() END, $6)`,
    [id, opts.projectId, opts.versionId, opts.status, unfinished, opts.by],
  );
  return id;
}

describe('Раунды: одна незавершённая кампания на проект', () => {
  it('второй open при open — отказ; paused тоже занимает место; closed освобождает', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const versionId = await submitVersion(c, projectId);
      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });

      await insertRound(c, { projectId, versionId, status: 'open', by: owner.id });
      const second = await failing(c, () =>
        insertRound(c, { projectId, versionId, status: 'open', by: owner.id }),
      );
      expect(second.message).toMatch(/funding_rounds_one_unfinished/);
    });
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const versionId = await submitVersion(c, projectId);
      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });

      const first = await insertRound(c, { projectId, versionId, status: 'open', by: owner.id });
      await c.query(
        `UPDATE lab.funding_rounds SET status = 'paused', paused_at = now() WHERE id = $1`,
        [first],
      );
      const blocked = await failing(c, () =>
        insertRound(c, { projectId, versionId, status: 'open', by: owner.id }),
      );
      expect(blocked.message).toMatch(/funding_rounds_one_unfinished/);

      await c.query(
        `UPDATE lab.funding_rounds SET status = 'closed', closed_at = now(), close_reason = 'withdrawn'
          WHERE id = $1`,
        [first],
      );
      const next = await insertRound(c, { projectId, versionId, status: 'open', by: owner.id });
      expect(next).toBeTruthy();
    });
  });

  it('черновик раунда — не более одного на проект', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });
      await insertRound(c, { projectId, versionId: null, status: 'draft', by: owner.id });
      const dup = await failing(c, () =>
        insertRound(c, { projectId, versionId: null, status: 'draft', by: owner.id }),
      );
      expect(dup.message).toMatch(/funding_rounds_one_draft/);
    });
  });
});

describe('Раунды: основание и заполненность', () => {
  it('основание — версия того же проекта', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectA = await createProject(c, owner.id);
      const projectB = await createProject(c, owner.id);
      const versionOfB = await submitVersion(c, projectB);
      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });
      const err = await failing(c, () =>
        insertRound(c, {
          projectId: projectA,
          versionId: versionOfB,
          status: 'open',
          by: owner.id,
        }),
      );
      expect(err.message).toMatch(/funding_rounds_version_same_project/);
    });
  });

  it('открытый раунд без суммы, основания или условий страны невозможен', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });
      const err = await failing(c, () =>
        c.query(
          `INSERT INTO lab.funding_rounds (id, project_id, schema_version, status, funding_scope, currency, opened_at)
           VALUES ($1, $2, 1, 'open', 'project', 'RUB', now())`,
          [uuidv7(), projectId],
        ),
      );
      expect(err.message).toMatch(/funding_rounds_unfinished_complete/);
    });
  });

  it('смена основания — тем же раундом, история пишется', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const v1 = await submitVersion(c, projectId);
      const v2 = await submitVersion(c, projectId);
      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });
      const roundId = await insertRound(c, {
        projectId,
        versionId: v1,
        status: 'open',
        by: owner.id,
      });
      await c.query(`UPDATE lab.funding_rounds SET application_version_id = $2 WHERE id = $1`, [
        roundId,
        v2,
      ]);
      await c.query(
        `INSERT INTO lab.funding_round_basis_history (id, round_id, from_version_id, to_version_id, changed_by, reason)
         VALUES ($1, $2, $3, $4, $5, 'обновлённый профиль')`,
        [uuidv7(), roundId, v1, v2, owner.id],
      );
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lab.funding_round_basis_history WHERE round_id = $1`,
        [roundId],
      );
      expect(rows[0]!.n).toBe('1');
      const { rows: rounds } = await c.query(
        `SELECT count(*)::text AS n FROM lab.funding_rounds WHERE project_id = $1`,
        [projectId],
      );
      expect(rounds[0]!.n).toBe('1');
    });
  });

  it('профиль подаётся без суммы и предмета финансирования', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      await c.query(
        `UPDATE lab.investment_applications
            SET investment_ask = NULL, funding_scope = NULL, status = 'submitted', submitted_at = now()
          WHERE project_id = $1`,
        [projectId],
      );
      const { rows } = await c.query<{ status: string }>(
        `SELECT status FROM lab.investment_applications WHERE project_id = $1`,
        [projectId],
      );
      expect(rows[0]!.status).toBe('submitted');
    });
  });
});

describe('Раунды: доступ (до этапа 5.7 внешним закрыт)', () => {
  it('владелец видит свой раунд, посторонний основатель и инвестор — нет', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const stranger = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const versionId = await submitVersion(c, projectId);
      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });
      await insertRound(c, { projectId, versionId, status: 'open', by: owner.id });
      const mine = await c.query(`SELECT id FROM lab.funding_rounds WHERE project_id = $1`, [
        projectId,
      ]);
      expect(mine.rows).toHaveLength(1);
      await resetRole(c);

      for (const [user, role] of [
        [stranger, 'founder'],
        [investor, 'investor'],
      ] as const) {
        await actAs(c, { userId: user.id, roles: [role], dbRole: 'app_backend' });
        const { rows } = await c.query(`SELECT id FROM lab.funding_rounds WHERE project_id = $1`, [
          projectId,
        ]);
        expect(rows).toHaveLength(0);
        await resetRole(c);
      }
    });
  });

  it('посторонний не может создать раунд чужому проекту', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const stranger = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      await actAs(c, { userId: stranger.id, roles: ['founder'], dbRole: 'app_backend' });
      const err = await failing(c, () =>
        insertRound(c, { projectId, versionId: null, status: 'draft', by: stranger.id }),
      );
      expect(err.message).toMatch(/row-level security|permission denied/);
    });
  });
});

describe('Страны обслуживания и условия', () => {
  it('сид: страна ru активна, у неё одна активная политика без бесплатной границы', async () => {
    await inRollbackTx(async (c) => {
      const { rows } = await c.query<{ code: string; basis: unknown; enabled: boolean }>(
        `SELECT c.code, p.config_jsonb->'freeAttraction'->'basis' AS basis,
                (p.config_jsonb->'freeAttraction'->>'enabled')::boolean AS enabled
           FROM billing.service_countries c
           JOIN billing.service_country_policies p ON p.country_code = c.code AND p.is_active
          WHERE c.code = 'ru'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.basis).toBeNull();
      expect(rows[0]!.enabled).toBe(false);
    });
  });

  it('вторая активная политика той же страны невозможна', async () => {
    await inRollbackTx(async (c) => {
      const err = await failing(c, () =>
        c.query(
          `INSERT INTO billing.service_country_policies (id, country_code, version, config_jsonb, is_active, reason)
           VALUES ($1, 'ru', 99, '{}', true, 'тест')`,
          [uuidv7()],
        ),
      );
      expect(err.message).toMatch(/service_country_policies_one_active/);
    });
  });

  it('список стран читает анонимная роль; политику — вошедший; пишет только администратор', async () => {
    await inRollbackTx(async (c) => {
      await actAs(c, { dbRole: 'app_public_read' });
      const pub = await c.query(`SELECT code FROM billing.service_countries WHERE is_active`);
      expect(pub.rows.map((r) => r.code)).toContain('ru');
      const noPolicy = await failing(c, () =>
        c.query(`SELECT id FROM billing.service_country_policies`),
      );
      expect(noPolicy.message).toMatch(/permission denied/);
      await resetRole(c);

      const founder = await createUser(c, { role: 'founder' });
      await actAs(c, { userId: founder.id, roles: ['founder'], dbRole: 'app_backend' });
      const seen = await c.query(`SELECT id FROM billing.service_country_policies WHERE is_active`);
      expect(seen.rows.length).toBeGreaterThan(0);
      const denied = await failing(c, () =>
        c.query(
          `INSERT INTO billing.service_country_policies (id, country_code, version, config_jsonb, is_active, reason)
           VALUES ($1, 'ru', 98, '{}', false, 'тест')`,
          [uuidv7()],
        ),
      );
      expect(denied.message).toMatch(/row-level security/);
      await resetRole(c);

      const admin = await createUser(c, { role: 'admin' });
      await actAs(c, { userId: admin.id, roles: ['admin'], dbRole: 'app_backend' });
      await c.query(
        `INSERT INTO billing.service_country_policies (id, country_code, version, config_jsonb, is_active, reason)
         VALUES ($1, 'ru', 97, '{}', false, 'тест администратора')`,
        [uuidv7()],
      );
    });
  });

  it('страна аккаунта: существующие — ru, ссылка только на известную страну', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { role: 'founder' });
      const { rows } = await c.query<{ service_country: string | null }>(
        `SELECT service_country FROM identity.users WHERE id = $1`,
        [user.id],
      );
      // Фикстура создаёт пользователя без страны — так же, как регистрация до 5.6.5.
      expect(rows[0]!.service_country === null || rows[0]!.service_country === 'ru').toBe(true);
      const err = await failing(c, () =>
        c.query(`UPDATE identity.users SET service_country = 'zz' WHERE id = $1`, [user.id]),
      );
      expect(err.message).toMatch(/foreign key/);
    });
  });
});
