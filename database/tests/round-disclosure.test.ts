import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers.ts';
import {
  actAs,
  closePool,
  createInvestorSubscription,
  createProject,
  createUser,
  inRollbackTx,
  resetRole,
  uuidv7,
} from './helpers.ts';

/**
 * M086: статус привлечения — отдельная настройка; версия условий у раунда.
 *
 *  - `disclosure.raising_status` показывает статус, скрывая сумму;
 *  - расширение публичности (investors → public) не касается раундов,
 *    открытых на прежней версии условий; новый раунд — по новой;
 *  - ограничение (public → investors) действует сразу на все раунды;
 *  - версия без блока disclosure: статус наследует видимость investment_ask;
 *  - интеграционная роль — публичная аудитория, а не инвесторская.
 */

afterAll(async () => {
  await closePool();
});

async function publishConfig(
  c: Client,
  questions: Record<string, string>,
  disclosure: Record<string, string> | null,
): Promise<number> {
  await c.query(`UPDATE lab.application_form_versions SET is_active = false WHERE is_active`);
  const config: Record<string, unknown> = {
    questions: Object.entries(questions).map(([key, visibility]) => ({ key, visibility })),
  };
  if (disclosure) config.disclosure = disclosure;
  const { rows } = await c.query<{ version: number }>(
    `INSERT INTO lab.application_form_versions
       (id, version, status, is_active, config_jsonb, reason, published_at, activated_at)
     VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM lab.application_form_versions),
             'published', true, $2::jsonb, 'тест раскрытия раунда', now(), now())
     RETURNING version`,
    [uuidv7(), JSON.stringify(config)],
  );
  return rows[0]!.version;
}

async function openRound(
  c: Client,
  projectId: string,
  by: string,
  disclosureVersion: number,
): Promise<void> {
  const versionId = uuidv7();
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM lab.investment_applications WHERE project_id = $1 LIMIT 1`,
    [projectId],
  );
  await c.query(
    `INSERT INTO lab.project_versions (id, project_id, application_id, version_no, snapshot_jsonb, schema_version)
     VALUES ($1, $2, $3, 1, '{}', 1)`,
    [versionId, projectId, rows[0]!.id],
  );
  await c.query(
    `INSERT INTO lab.funding_rounds
       (id, project_id, application_version_id, schema_version, disclosure_version, status,
        funding_scope, target, currency, service_country, policy_version, opened_at, created_by)
     VALUES ($1, $2, $3, 1, $5, 'open', 'project', 3000000, 'RUB', 'ru', 1, now(), $4)`,
    [uuidv7(), projectId, versionId, by, disclosureVersion],
  );
}

interface View {
  raising: string;
  target: string | null;
  currency: string | null;
  funding_scope: string | null;
}

async function asAnon(c: Client, projectId: string): Promise<View | null> {
  await actAs(c, { userId: null, roles: [], dbRole: 'app_public_read' });
  const { rows } = await c.query<View>(`SELECT * FROM lab.round_view($1)`, [projectId]);
  await resetRole(c);
  return rows[0] ?? null;
}

describe('M086: статус отдельно от суммы', () => {
  it('raising_status = public при investment_ask = investors: аноним видит статус без суммы', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const v = await publishConfig(
        c,
        { investment_ask: 'investors', funding_scope: 'public' },
        { raising_status: 'public' },
      );
      await openRound(c, projectId, owner.id, v);
      const view = await asAnon(c, projectId);
      expect(view).toEqual({
        raising: 'open',
        target: null,
        currency: null,
        funding_scope: 'project',
        funding_scope_note: null,
      });
    });
  });

  it('сумма без статуса не показывается: статус investors закрывает и сумму public', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const v = await publishConfig(
        c,
        { investment_ask: 'public', funding_scope: 'public' },
        { raising_status: 'investors' },
      );
      await openRound(c, projectId, owner.id, v);
      const view = await asAnon(c, projectId);
      expect(view?.raising).toBe('undisclosed');
      expect(view?.target).toBeNull();
      expect(view?.funding_scope).toBeNull();
    });
  });

  it('версия без блока disclosure: статус наследует видимость investment_ask', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const v = await publishConfig(c, { investment_ask: 'public', funding_scope: 'public' }, null);
      await openRound(c, projectId, owner.id, v);
      expect((await asAnon(c, projectId))?.raising).toBe('open');
    });
  });
});

describe('M086: версия условий раскрытия у раунда', () => {
  it('расширение investors → public не раскрывает уже открытый раунд; новый раунд — по новой версии', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const other = await createUser(c, { role: 'founder' });
      const oldProject = await createProject(c, owner.id, { listed: true });
      const newProject = await createProject(c, other.id, { listed: true });
      const v1 = await publishConfig(
        c,
        { investment_ask: 'investors', funding_scope: 'investors' },
        { raising_status: 'investors' },
      );
      await openRound(c, oldProject, owner.id, v1);
      expect((await asAnon(c, oldProject))?.raising).toBe('undisclosed');

      const v2 = await publishConfig(
        c,
        { investment_ask: 'public', funding_scope: 'public' },
        { raising_status: 'public' },
      );
      await openRound(c, newProject, other.id, v2);
      const old = await asAnon(c, oldProject);
      expect(old?.raising).toBe('undisclosed');
      expect(old?.target).toBeNull();
      const fresh = await asAnon(c, newProject);
      expect(fresh?.raising).toBe('open');
      expect(fresh?.target).toBe('3000000.00');
    });
  });

  it('ограничение public → investors действует сразу на открытый раунд', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const v1 = await publishConfig(
        c,
        { investment_ask: 'public', funding_scope: 'public' },
        { raising_status: 'public' },
      );
      await openRound(c, projectId, owner.id, v1);
      expect((await asAnon(c, projectId))?.target).toBe('3000000.00');
      await publishConfig(
        c,
        { investment_ask: 'investors', funding_scope: 'investors' },
        { raising_status: 'investors' },
      );
      const view = await asAnon(c, projectId);
      expect(view?.raising).toBe('undisclosed');
      expect(view?.target).toBeNull();
    });
  });
});

describe('M086: аудитория интеграции', () => {
  it('интеграционная роль получает публичную проекцию, не инвесторскую', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, investor.id);
      const projectId = await createProject(c, owner.id, { listed: true });
      const v = await publishConfig(
        c,
        { investment_ask: 'investors', funding_scope: 'investors' },
        { raising_status: 'investors' },
      );
      await openRound(c, projectId, owner.id, v);

      await actAs(c, { userId: null, roles: [], dbRole: 'app_integration' });
      const { rows } = await c.query<View>(`SELECT * FROM lab.round_view($1)`, [projectId]);
      await resetRole(c);
      expect(rows[0]?.raising).toBe('undisclosed');
      expect(rows[0]?.target).toBeNull();

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const asInvestor = await c.query<View>(`SELECT * FROM lab.round_view($1)`, [projectId]);
      await resetRole(c);
      expect(asInvestor.rows[0]?.target).toBe('3000000.00');
    });
  });
});
