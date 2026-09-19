/**
 * Инвестиционная заявка как отдельная сущность (M071/M072).
 *
 * Проверяется ровно то, что обещает план 0.2: черновик свободен, обязательность
 * — при подаче; заявку видят члены проекта и администратор, инвестор — нет;
 * публикация не требует оплаты (подписка основателя удалена, M094) и не
 *   касается доступа инвестора;
 * версии без сезона нумеруются внутри заявки; политика ограничений — одна
 * активная версия.
 *
 * Все проверки доступа — под настоящей ролью app_backend через SET ROLE.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers.ts';
import {
  actAs,
  closePool,
  createInvestorSubscription,
  createProject,
  createUser,
  expectError,
  getPool,
  inRollbackTx,
  uuidv7,
} from './helpers.ts';

afterAll(async () => {
  await closePool();
});

/**
 * Черновик заявки от имени владельца проекта. Контекст сессии выставляется
 * явно: политики вставки требуют членства в проекте даже от владельца схем.
 */
async function createApplication(
  c: Client,
  projectId: string,
  ownerId: string,
  opts: { ask?: number | null; status?: 'draft' | 'submitted' } = {},
): Promise<string> {
  const id = uuidv7();
  await actAs(c, { userId: ownerId, roles: ['founder'] });
  const status = opts.status ?? 'draft';
  await c.query(
    `INSERT INTO lab.investment_applications
       (id, project_id, status, stage, investment_ask, schema_version, created_by, submitted_at)
     VALUES ($1, $2, $3, 'mvp', $4, 0, $5, CASE WHEN $3 = 'submitted' THEN now() END)`,
    [id, projectId, status, opts.ask === undefined ? 1_000_000 : opts.ask, ownerId],
  );
  return id;
}

describe('M071: перенос данных', () => {
  it('у каждого проекта есть текущая заявка, у каждой версии — заявка', async () => {
    // Проверяются строки, существовавшие на момент применения M071: именно их
    // переносила миграция. Фикстуры других тестов создаются позже и через
    // createProject, который повторяет перенос сам.
    const { rows } = await getPool().query<{ no_app: string; orphan_versions: string }>(
      `WITH m AS (SELECT applied_at FROM public.schema_migrations WHERE id LIKE 'M071%')
       SELECT (SELECT count(*) FROM lab.projects p, m
                WHERE p.current_application_id IS NULL AND p.created_at <= m.applied_at)::text AS no_app,
              (SELECT count(*) FROM lab.project_versions v, m
                WHERE v.application_id IS NULL AND v.submitted_at <= m.applied_at)::text AS orphan_versions`,
    );
    expect(rows[0]!.no_app).toBe('0');
    expect(rows[0]!.orphan_versions).toBe('0');
  });

  it('политика ограничений: ровно одна активная версия со стартовыми значениями', async () => {
    const { rows } = await getPool().query<{
      version: number;
      config_jsonb: Record<string, unknown>;
    }>(`SELECT version, config_jsonb FROM lab.application_policies WHERE is_active`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.config_jsonb).toMatchObject({
      maxApplicationsPerProject: 3,
      maxAskPerApplication: '5000000.00',
      count: { draft: true, submitted: true, archived: false },
    });
  });

  it('флага платёжного барьера основателя больше нет (M094)', async () => {
    // Барьер удалён вместе с подпиской основателя: публикация проекта не
    // зависит от денег, запуск раунда оплачивается разово (5.9).
    const { rows } = await getPool().query(
      `SELECT 1 FROM audit.feature_flags WHERE key = 'billing.listing_requires_subscription'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('Заявка: черновик свободен, обязательность при подаче', () => {
  it('черновик без суммы создаётся', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      const app = await createApplication(c, project, founder.id, { ask: null });
      const { rows } = await c.query(
        `SELECT investment_ask FROM lab.investment_applications WHERE id = $1`,
        [app],
      );
      expect(rows[0]!.investment_ask).toBeNull();
    });
  });

  it('профиль подаётся без суммы: CHECK подачи сняты в M081, сумма — у раунда', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      const app = await createApplication(c, project, founder.id, {
        ask: null,
        status: 'submitted',
      });
      const { rows } = await c.query<{ status: string; ask: string | null }>(
        `SELECT status, investment_ask::text AS ask FROM lab.investment_applications WHERE id = $1`,
        [app],
      );
      expect(rows[0]!.status).toBe('submitted');
      expect(rows[0]!.ask).toBeNull();
    });
  });

  it('направление без уточнения при подаче не отвергается БД: предмет финансирования — у раунда (M081)', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      const app = await createApplication(c, project, founder.id);
      await c.query(
        `UPDATE lab.investment_applications SET funding_scope = 'direction' WHERE id = $1`,
        [app],
      );
      await c.query(
        `UPDATE lab.investment_applications
            SET status = 'submitted', submitted_at = now() WHERE id = $1`,
        [app],
      );
      const { rows } = await c.query<{ status: string }>(
        `SELECT status FROM lab.investment_applications WHERE id = $1`,
        [app],
      );
      expect(rows[0]!.status).toBe('submitted');
    });
  });

  it('у проекта может быть несколько заявок', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      await createApplication(c, project, founder.id, { ask: 800_000 });
      await createApplication(c, project, founder.id, { ask: 5_000_000 });
      const { rows } = await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM lab.investment_applications WHERE project_id = $1`,
        [project],
      );
      // Одна заявка приходит с фикстурой проекта (перенос M071) плюс две здесь.
      expect(rows[0]!.count).toBe('3');
    });
  });
});

describe('RLS: заявка', () => {
  it('владелец видит свою заявку, чужой основатель — нет', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c);
      const bob = await createUser(c);
      const project = await createProject(c, alice.id);
      const app = await createApplication(c, project, alice.id);

      await actAs(c, { userId: alice.id, roles: ['founder'], dbRole: 'app_backend' });
      const own = await c.query(`SELECT id FROM lab.investment_applications WHERE id = $1`, [app]);
      expect(own.rows).toHaveLength(1);

      await c.query('RESET ROLE');
      await actAs(c, { userId: bob.id, roles: ['founder'], dbRole: 'app_backend' });
      const foreign = await c.query(`SELECT id FROM lab.investment_applications WHERE id = $1`, [
        app,
      ]);
      expect(foreign.rows).toHaveLength(0);
    });
  });

  it('инвестор с подпиской не видит заявку напрямую даже у опубликованного проекта', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const investor = await createUser(c, { role: 'investor' });
      const project = await createProject(c, founder.id, { listed: true });
      const app = await createApplication(c, project, founder.id);
      await createInvestorSubscription(c, investor.id);

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query(`SELECT id FROM lab.investment_applications WHERE id = $1`, [
        app,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  it('администратор видит любую заявку', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const admin = await createUser(c, { role: 'admin' });
      const project = await createProject(c, founder.id);
      const app = await createApplication(c, project, founder.id);

      await actAs(c, { userId: admin.id, roles: ['admin'], dbRole: 'app_backend' });
      const { rows } = await c.query(`SELECT id FROM lab.investment_applications WHERE id = $1`, [
        app,
      ]);
      expect(rows).toHaveLength(1);
    });
  });

  it('политику ограничений читает основатель, пишет только администратор', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      await actAs(c, { userId: founder.id, roles: ['founder'], dbRole: 'app_backend' });
      const read = await c.query(`SELECT version FROM lab.application_policies WHERE is_active`);
      expect(read.rows).toHaveLength(1);

      const error = await expectError(() =>
        c.query(
          `INSERT INTO lab.application_policies (id, version, config_jsonb, is_active, reason)
           VALUES ($1, 999, '{}'::jsonb, false, 'попытка основателя')`,
          [uuidv7()],
        ),
      );
      expect(error.message).toMatch(/row-level security|policy/i);
    });
  });
});

describe('Версии заявки', () => {
  it('версия без сезона создаётся и нумеруется внутри заявки', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      const app = await createApplication(c, project, founder.id);
      await actAs(c, { userId: founder.id, roles: ['founder'] });
      const insert = (no: number) =>
        c.query(
          `INSERT INTO lab.project_versions
             (id, project_id, season_id, version_no, snapshot_jsonb, application_id, schema_version)
           VALUES ($1, $2, NULL, $3, '{}'::jsonb, $4, 0)`,
          [uuidv7(), project, no, app],
        );
      await insert(1);
      await insert(2);
      const dup = await expectError(() => insert(2));
      expect(dup.message).toMatch(/project_versions_application_no/);
    });
  });
});

describe('Публикация без денег: подписка основателя удалена (M094)', () => {
  it('листинг без подписки разрешён', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id, { listed: false });
      await c.query(
        `UPDATE lab.projects SET listing_status = 'listed', listed_at = now() WHERE id = $1`,
        [project],
      );
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const { rows } = await c.query<{ listing_status: string }>(
        `SELECT listing_status FROM lab.projects WHERE id = $1`,
        [project],
      );
      expect(rows[0]!.listing_status).toBe('listed');
    });
  });

  it('рост суммы у опубликованного проекта ничего не ломает: тарифа основателя нет (M094)', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id, { ask: 500_000, listed: false });
      await c.query(
        `UPDATE lab.projects SET listing_status = 'listed', listed_at = now() WHERE id = $1`,
        [project],
      );
      await c.query(`UPDATE lab.projects SET investment_ask = 50000000 WHERE id = $1`, [project]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const { rows } = await c.query<{ listing_status: string }>(
        `SELECT listing_status FROM lab.projects WHERE id = $1`,
        [project],
      );
      expect(rows[0]!.listing_status).toBe('listed');
    });
  });

  it('доступ инвестора от барьера не зависит: без подписки — нет, с подпиской — да', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const investor = await createUser(c, { role: 'investor' });
      // Опубликован бесплатно: барьер выключен, подписки основателя нет.
      const project = await createProject(c, founder.id, { listed: false });
      await c.query(
        `UPDATE lab.projects SET listing_status = 'listed', listed_at = now(),
                visibility = 'public' WHERE id = $1`,
        [project],
      );
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');

      // С M090 инвестор строку проекта не читает вовсе — доступ идёт через
      // проекцию по предикату; барьер подписки инвестора (M087) решает, с
      // какой аудиторией: без членства — public (тизер), с членством — investors.
      const audience = async (): Promise<string | null> => {
        await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
        const { rows } = await c.query<{ a: string | null }>(
          `SELECT lab.project_audience($1, $2, 'profile') AS a`,
          [project, investor.id],
        );
        await c.query('RESET ROLE');
        return rows[0]!.a;
      };
      expect(await audience()).toBe('public');
      await createInvestorSubscription(c, investor.id);
      expect(await audience()).toBe('investors');
    });
  });
});
