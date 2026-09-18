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
 * M089 (5.7.2): проекции для Public View и Investor View.
 *
 *  - `lab.disclosed_profile`: без согласия владельца — пусто; с согласием —
 *    снимок и эффективная видимость = строже(активная, версия согласия);
 *    доступ — по предикату profile (аноним в public — public);
 *  - `lab.visible_materials`: доступ по предикату materials, состав — по
 *    отметке владельца; private — только команде;
 *  - `lab.visible_passport`: явный состав, только опубликованные teaser|full;
 *  - `lab.project_view_base`: пусто без тизера; описание — только с profile.
 */

afterAll(async () => {
  await closePool();
});

type Viewer = { userId: string | null; roles: string[]; dbRole: 'app_backend' | 'app_public_read' };
const anon: Viewer = { userId: null, roles: [], dbRole: 'app_public_read' };
const asUser = (userId: string, ...roles: string[]): Viewer => ({
  userId,
  roles,
  dbRole: 'app_backend',
});

async function as<T>(c: Client, v: Viewer, fn: () => Promise<T>): Promise<T> {
  await actAs(c, { userId: v.userId, roles: v.roles, dbRole: v.dbRole });
  try {
    return await fn();
  } finally {
    await resetRole(c);
    await actAs(c, { userId: null, roles: [] });
  }
}

async function publishConfig(c: Client, questions: Record<string, string>): Promise<number> {
  await c.query(`UPDATE lab.application_form_versions SET is_active = false WHERE is_active`);
  const config = {
    locales: ['ru-RU'],
    defaultLocale: 'ru-RU',
    sections: [{ key: 'problem', order: 1, texts: { 'ru-RU': { title: 'Проблема' } } }],
    questions: Object.entries(questions).map(([key, visibility], i) => ({
      key,
      section: 'problem',
      order: i + 1,
      type: 'text',
      visibility,
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      texts: { 'ru-RU': { label: key } },
    })),
  };
  const { rows } = await c.query<{ version: number }>(
    `INSERT INTO lab.application_form_versions
       (id, version, status, is_active, config_jsonb, reason, published_at, activated_at)
     VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM lab.application_form_versions),
             'published', true, $2::jsonb, 'тест представлений', now(), now())
     RETURNING version`,
    [uuidv7(), JSON.stringify(config)],
  );
  return rows[0]!.version;
}

/** Снимок с ответами и согласие владельца на него. */
async function consent(
  c: Client,
  projectId: string,
  schemaVersion: number,
  answers: Record<string, unknown>,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM lab.investment_applications WHERE project_id = $1 LIMIT 1`,
    [projectId],
  );
  const versionId = uuidv7();
  await c.query(
    `INSERT INTO lab.project_versions (id, project_id, application_id, version_no, snapshot_jsonb, schema_version)
     VALUES ($1, $2, $3, 1, $4::jsonb, $5)`,
    [
      versionId,
      projectId,
      rows[0]!.id,
      JSON.stringify({ core: { stage: 'mvp' }, answers, evidence: {} }),
      schemaVersion,
    ],
  );
  await c.query(
    `UPDATE lab.projects SET disclosed_version_id = $2, disclosure_form_version = $3, disclosed_at = now()
      WHERE id = $1`,
    [projectId, versionId, schemaVersion],
  );
  return versionId;
}

describe('M089: disclosed_profile — снимок по согласию и эффективная видимость', () => {
  it('без согласия — пусто даже для допущенного инвестора; с согласием — по предикату и строже из двух', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const memberInv = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, memberInv.id);
      const v1 = await publishConfig(c, { problem_statement: 'public', secret: 'investors' });

      const empty = await as(c, asUser(memberInv.id, 'investor'), () =>
        c.query(`SELECT * FROM lab.disclosed_profile($1)`, [projectId]),
      );
      expect(empty.rowCount).toBe(0);

      await consent(c, projectId, v1, { problem_statement: 'Боль', secret: 'Тайна' });
      const forAnon = await as(c, anon, () =>
        c.query<{
          audience: string;
          effective_visibility: Record<string, string>;
          consent_version: number;
        }>(
          `SELECT audience, effective_visibility, consent_version FROM lab.disclosed_profile($1)`,
          [projectId],
        ),
      );
      expect(forAnon.rows[0]!.audience).toBe('public');
      expect(forAnon.rows[0]!.consent_version).toBe(v1);
      expect(forAnon.rows[0]!.effective_visibility).toEqual({
        problem_statement: 'public',
        secret: 'investors',
      });

      // Администратор смягчил secret → public: согласие v1 держит investors.
      await publishConfig(c, { problem_statement: 'public', secret: 'public' });
      const afterWiden = await as(c, anon, () =>
        c.query<{ effective_visibility: Record<string, string> }>(
          `SELECT effective_visibility FROM lab.disclosed_profile($1)`,
          [projectId],
        ),
      );
      expect(afterWiden.rows[0]!.effective_visibility.secret).toBe('investors');

      // Ужесточил problem_statement → platform: сразу.
      await publishConfig(c, { problem_statement: 'platform', secret: 'public' });
      const afterNarrow = await as(c, anon, () =>
        c.query<{ effective_visibility: Record<string, string> }>(
          `SELECT effective_visibility FROM lab.disclosed_profile($1)`,
          [projectId],
        ),
      );
      expect(afterNarrow.rows[0]!.effective_visibility.problem_statement).toBe('platform');

      // Режим private закрывает снимок анониму и инвестору, но не команде.
      await c.query(`UPDATE lab.projects SET visibility = 'private' WHERE id = $1`, [projectId]);
      expect(
        (await as(c, anon, () => c.query(`SELECT 1 FROM lab.disclosed_profile($1)`, [projectId])))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await as(c, asUser(memberInv.id, 'investor'), () =>
            c.query(`SELECT 1 FROM lab.disclosed_profile($1)`, [projectId]),
          )
        ).rowCount,
      ).toBe(0);
      const team = await as(c, asUser(owner.id, 'founder'), () =>
        c.query<{ audience: string }>(`SELECT audience FROM lab.disclosed_profile($1)`, [
          projectId,
        ]),
      );
      expect(team.rows[0]!.audience).toBe('private');
    });
  });
});

describe('M089: visible_materials и visible_passport', () => {
  it('материалы: private только команде; investors — допущенному инвестору; анониму в public — ничего', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const memberInv = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, memberInv.id);
      for (const [vis, version] of [
        ['private', 1],
        ['investors', 2],
      ] as const) {
        await c.query(
          `INSERT INTO lab.project_materials
             (id, project_id, type, version, url, uploaded_at, visibility, uploaded_by)
           VALUES ($1, $2, 'product_link', $3, $5, now(), $4, $6)`,
          [uuidv7(), projectId, version, vis, `https://example.com/${version}`, owner.id],
        );
      }
      const forInvestor = await as(c, asUser(memberInv.id, 'investor'), () =>
        c.query<{ visibility: string; audience: string }>(
          `SELECT visibility, audience FROM lab.visible_materials($1)`,
          [projectId],
        ),
      );
      expect(forInvestor.rows.map((r) => r.visibility)).toEqual(['investors']);
      expect(forInvestor.rows[0]!.audience).toBe('investors');
      const forAnon = await as(c, anon, () =>
        c.query(`SELECT 1 FROM lab.visible_materials($1)`, [projectId]),
      );
      expect(forAnon.rowCount).toBe(0);
      const forOwner = await as(c, asUser(owner.id, 'founder'), () =>
        c.query<{ visibility: string }>(`SELECT visibility FROM lab.visible_materials($1)`, [
          projectId,
        ]),
      );
      expect(forOwner.rows.map((r) => r.visibility).sort()).toEqual(['investors', 'private']);

      // Grant {materials} в режиме selected_investors: материалы есть, профиль — нет.
      await c.query(`UPDATE lab.projects SET visibility = 'selected_investors' WHERE id = $1`, [
        projectId,
      ]);
      const grantee = await createUser(c, { role: 'investor' });
      await c.query(
        `INSERT INTO lab.project_access_grants (id, project_id, grantee_user_id, permissions, granted_by)
         VALUES ($1, $2, $3, ARRAY['materials'], $4)`,
        [uuidv7(), projectId, grantee.id, owner.id],
      );
      const base = await as(c, asUser(grantee.id, 'investor'), () =>
        c.query<{
          profile_audience: string | null;
          materials_audience: string | null;
          description: string | null;
        }>(
          `SELECT profile_audience, materials_audience, description FROM lab.project_view_base($1)`,
          [projectId],
        ),
      );
      expect(base.rows[0]).toEqual({
        profile_audience: null,
        materials_audience: 'investors',
        description: null,
      });
      const mats = await as(c, asUser(grantee.id, 'investor'), () =>
        c.query(`SELECT 1 FROM lab.visible_materials($1)`, [projectId]),
      );
      expect(mats.rowCount).toBe(1);
      expect(
        (
          await as(c, asUser(memberInv.id, 'investor'), () =>
            c.query(`SELECT 1 FROM lab.project_view_base($1)`, [projectId]),
          )
        ).rowCount,
      ).toBe(0);
    });
  });

  it('паспорт: явный состав только допущенному; dataroom внешним не отдаётся', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const memberInv = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, memberInv.id);
      const passportId = uuidv7();
      await c.query(
        `INSERT INTO scoring.investment_passports (id, project_id, version, jsonb_data, disclosure_tier, published_at)
         VALUES ($1, $2, 1, '{}'::jsonb, 'teaser', now())`,
        [passportId, projectId],
      );
      await c.query(
        `INSERT INTO scoring.scores (id, project_id, passport_id, axis, value, confidence_low, confidence_high, explanation)
         VALUES ($1, $2, $3, 'market', 71.5, 60, 80, 'тест')`,
        [uuidv7(), projectId, passportId],
      );
      await c.query(
        `INSERT INTO scoring.irs_scores (id, project_id, value) VALUES ($1, $2, 64.25)`,
        [uuidv7(), projectId],
      );
      const forInvestor = await as(c, asUser(memberInv.id, 'investor'), () =>
        c.query<{
          version: number;
          disclosure_tier: string;
          irs: string;
          axes: { axis: string; value: number }[];
        }>(`SELECT version, disclosure_tier, irs, axes FROM lab.visible_passport($1)`, [projectId]),
      );
      expect(forInvestor.rows[0]!.disclosure_tier).toBe('teaser');
      expect(Number(forInvestor.rows[0]!.irs)).toBe(64.25);
      expect(forInvestor.rows[0]!.axes).toEqual([{ axis: 'market', value: 71.5 }]);
      const forAnon = await as(c, anon, () =>
        c.query(`SELECT 1 FROM lab.visible_passport($1)`, [projectId]),
      );
      expect(forAnon.rowCount).toBe(0);

      await c.query(
        `UPDATE scoring.investment_passports SET disclosure_tier = 'dataroom' WHERE id = $1`,
        [passportId],
      );
      const dataroom = await as(c, asUser(memberInv.id, 'investor'), () =>
        c.query(`SELECT 1 FROM lab.visible_passport($1)`, [projectId]),
      );
      expect(dataroom.rowCount).toBe(0);
      const ownerSees = await as(c, asUser(owner.id, 'founder'), () =>
        c.query(`SELECT 1 FROM lab.visible_passport($1)`, [projectId]),
      );
      expect(ownerSees.rowCount).toBe(1);
    });
  });

  it('project_view_base: пусто без тизера; описание только с profile; раунд по предикату', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      await c.query(`UPDATE lab.projects SET description = 'Описание' WHERE id = $1`, [projectId]);
      const forAnon = await as(c, anon, () =>
        c.query<{
          teaser_audience: string;
          profile_audience: string;
          description: string | null;
          raising: string;
        }>(
          `SELECT teaser_audience, profile_audience, description, raising FROM lab.project_view_base($1)`,
          [projectId],
        ),
      );
      expect(forAnon.rows[0]).toMatchObject({
        teaser_audience: 'public',
        profile_audience: 'public',
        description: 'Описание',
      });
      // Раунда нет: анониму — «не раскрывается» или «не привлекает» по
      // настройке `raising_status` активной конфигурации (M086), не сумма.
      expect(['none', 'undisclosed']).toContain(forAnon.rows[0]!.raising);
      await c.query(`UPDATE lab.projects SET visibility = 'registered_investors' WHERE id = $1`, [
        projectId,
      ]);
      expect(
        (await as(c, anon, () => c.query(`SELECT 1 FROM lab.project_view_base($1)`, [projectId])))
          .rowCount,
      ).toBe(0);
    });
  });
});
