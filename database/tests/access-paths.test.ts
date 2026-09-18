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
 * M090 (5.7.5): старые пути закрыты — RLS и вью на предикате доступа.
 *
 *  - инвестор (даже с членством) не читает строки проектов, паспортов,
 *    оценок и IRS напрямую; данные — только через проекции по предикату;
 *  - материалы: по предикату materials И отметке владельца; grant {materials}
 *    в selected_investors читает только отмеченные; исключённый — ничего;
 *  - пользователь с несколькими ролями (founder + investor) на чужом
 *    закрытом проекте — ничего, на своём — всё;
 *  - каталог (v_public_catalog) — по сессии зрителя: registered_investors
 *    анониму не виден, допущенному инвестору виден; исключённому — нет;
 *  - избранное: добавить можно только проект с доступным тизером.
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

async function count(c: Client, v: Viewer, sql: string, params: unknown[]): Promise<number> {
  return as(c, v, async () => (await c.query(sql, params)).rowCount ?? 0);
}

async function addMaterial(
  c: Client,
  projectId: string,
  ownerId: string,
  visibility: 'private' | 'investors',
  version: number,
): Promise<string> {
  const id = uuidv7();
  await c.query(
    `INSERT INTO lab.project_materials
       (id, project_id, type, version, url, uploaded_at, visibility, uploaded_by)
     VALUES ($1, $2, 'product_link', $3, $4, now(), $5, $6)`,
    [id, projectId, version, `https://example.com/${version}`, visibility, ownerId],
  );
  return id;
}

async function scoring(c: Client, projectId: string): Promise<void> {
  const passportId = uuidv7();
  await c.query(
    `INSERT INTO scoring.investment_passports (id, project_id, version, jsonb_data, disclosure_tier, published_at)
     VALUES ($1, $2, 1, '{}'::jsonb, 'teaser', now())`,
    [passportId, projectId],
  );
  await c.query(
    `INSERT INTO scoring.scores (id, project_id, passport_id, axis, value, confidence_low, confidence_high, explanation)
     VALUES ($1, $2, $3, 'market', 70, 60, 80, 'тест')`,
    [uuidv7(), projectId, passportId],
  );
  await c.query(`INSERT INTO scoring.irs_scores (id, project_id, value) VALUES ($1, $2, 60)`, [
    uuidv7(),
    projectId,
  ]);
}

describe('M090: строки проектов и скоринга инвестору не читаются', () => {
  it('инвестор с членством: projects, passports, scores, irs — пусто; проекции — по предикату', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      await scoring(c, projectId);
      const memberInv = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, memberInv.id);
      const v = asUser(memberInv.id, 'investor');

      expect(await count(c, v, `SELECT 1 FROM lab.projects WHERE id = $1`, [projectId])).toBe(0);
      expect(
        await count(c, v, `SELECT 1 FROM scoring.investment_passports WHERE project_id = $1`, [
          projectId,
        ]),
      ).toBe(0);
      expect(
        await count(c, v, `SELECT 1 FROM scoring.scores WHERE project_id = $1`, [projectId]),
      ).toBe(0);
      expect(
        await count(c, v, `SELECT 1 FROM scoring.irs_scores WHERE project_id = $1`, [projectId]),
      ).toBe(0);
      expect(
        await count(c, v, `SELECT 1 FROM lab.project_versions WHERE project_id = $1`, [projectId]),
      ).toBe(0);
      // Проекции — есть, по предикату.
      expect(await count(c, v, `SELECT 1 FROM lab.project_view_base($1)`, [projectId])).toBe(1);
      expect(await count(c, v, `SELECT 1 FROM lab.visible_passport($1)`, [projectId])).toBe(1);
      // Команда — строки как прежде.
      const team = asUser(owner.id, 'founder');
      expect(await count(c, team, `SELECT 1 FROM lab.projects WHERE id = $1`, [projectId])).toBe(1);
      expect(
        await count(c, team, `SELECT 1 FROM scoring.irs_scores WHERE project_id = $1`, [projectId]),
      ).toBe(1);
    });
  });

  it('несколько ролей: founder+investor на чужом private — ничего, на своём — всё; исключённый — ничего', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const foreignPrivate = await createProject(c, owner.id, { listed: false });
      const foreignPublic = await createProject(c, owner.id, { listed: true });
      const dual = await createUser(c, { role: 'founder' });
      await c.query(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'investor')`, [
        dual.id,
      ]);
      await createInvestorSubscription(c, dual.id);
      const own = await createProject(c, dual.id, { listed: false });
      const v = asUser(dual.id, 'founder', 'investor');

      expect(await count(c, v, `SELECT 1 FROM lab.project_view_base($1)`, [foreignPrivate])).toBe(
        0,
      );
      expect(await count(c, v, `SELECT 1 FROM lab.projects WHERE id = $1`, [foreignPrivate])).toBe(
        0,
      );
      expect(await count(c, v, `SELECT 1 FROM lab.project_view_base($1)`, [foreignPublic])).toBe(1);
      expect(await count(c, v, `SELECT 1 FROM lab.projects WHERE id = $1`, [own])).toBe(1);
      expect(
        (
          await as(c, v, () =>
            c.query<{ profile_audience: string }>(
              `SELECT profile_audience FROM lab.project_view_base($1)`,
              [own],
            ),
          )
        ).rows[0]!.profile_audience,
      ).toBe('private');

      // Исключение закрывает и допущенному с членством, и в каталоге.
      await c.query(
        `INSERT INTO lab.project_access_exclusions (id, project_id, excluded_user_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [uuidv7(), foreignPublic, dual.id, owner.id],
      );
      expect(await count(c, v, `SELECT 1 FROM lab.project_view_base($1)`, [foreignPublic])).toBe(0);
      expect(
        await count(c, v, `SELECT 1 FROM lab.v_public_catalog WHERE id = $1`, [foreignPublic]),
      ).toBe(0);
    });
  });
});

describe('M090: материалы — предикат и отметка владельца', () => {
  it('инвестор читает только отмеченные; grant {materials} — только отмеченные; исключённый — ничего', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const privateId = await addMaterial(c, projectId, owner.id, 'private', 1);
      const openId = await addMaterial(c, projectId, owner.id, 'investors', 2);
      const memberInv = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, memberInv.id);
      const noMember = await createUser(c, { role: 'investor' });
      const rowsOf = (v: Viewer) =>
        as(c, v, async () =>
          (
            await c.query<{ id: string }>(
              `SELECT id FROM lab.project_materials WHERE project_id = $1 ORDER BY version`,
              [projectId],
            )
          ).rows.map((r) => r.id),
        );

      expect(await rowsOf(asUser(memberInv.id, 'investor'))).toEqual([openId]);
      // Барьер включён: инвестор без членства в режиме public материалов не видит.
      expect(await rowsOf(asUser(noMember.id, 'investor'))).toEqual([]);
      expect(await rowsOf(asUser(owner.id, 'founder'))).toEqual([privateId, openId]);

      await c.query(`UPDATE lab.projects SET visibility = 'selected_investors' WHERE id = $1`, [
        projectId,
      ]);
      expect(await rowsOf(asUser(memberInv.id, 'investor'))).toEqual([]);
      const grantee = await createUser(c, { role: 'investor' });
      await c.query(
        `INSERT INTO lab.project_access_grants (id, project_id, grantee_user_id, permissions, granted_by)
         VALUES ($1, $2, $3, ARRAY['materials'], $4)`,
        [uuidv7(), projectId, grantee.id, owner.id],
      );
      expect(await rowsOf(asUser(grantee.id, 'investor'))).toEqual([openId]);
      const profileOnly = await createUser(c, { role: 'investor' });
      await c.query(
        `INSERT INTO lab.project_access_grants (id, project_id, grantee_user_id, permissions, granted_by)
         VALUES ($1, $2, $3, ARRAY['profile'], $4)`,
        [uuidv7(), projectId, profileOnly.id, owner.id],
      );
      expect(await rowsOf(asUser(profileOnly.id, 'investor'))).toEqual([]);

      await c.query(
        `INSERT INTO lab.project_access_exclusions (id, project_id, excluded_user_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [uuidv7(), projectId, grantee.id, owner.id],
      );
      expect(await rowsOf(asUser(grantee.id, 'investor'))).toEqual([]);
    });
  });
});

describe('M090: каталог и избранное по сессии зрителя', () => {
  it('registered_investors: анониму нет, допущенному есть; избранное только при доступном тизере', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      await c.query(`UPDATE lab.projects SET visibility = 'registered_investors' WHERE id = $1`, [
        projectId,
      ]);
      const memberInv = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, memberInv.id);
      const noMember = await createUser(c, { role: 'investor' });

      expect(
        await count(c, anon, `SELECT 1 FROM lab.v_public_catalog WHERE id = $1`, [projectId]),
      ).toBe(0);
      expect(
        await count(
          c,
          { ...asUser(memberInv.id, 'investor'), dbRole: 'app_public_read' },
          `SELECT 1 FROM lab.v_public_catalog WHERE id = $1`,
          [projectId],
        ),
      ).toBe(1);
      expect(
        await count(
          c,
          { ...asUser(noMember.id, 'investor'), dbRole: 'app_public_read' },
          `SELECT 1 FROM lab.v_public_catalog WHERE id = $1`,
          [projectId],
        ),
      ).toBe(0);

      await as(c, asUser(memberInv.id, 'investor'), () =>
        c.query(`INSERT INTO lab.project_favorites (user_id, project_id) VALUES ($1, $2)`, [
          memberInv.id,
          projectId,
        ]),
      );
      // Ожидаемая ошибка — под SAVEPOINT; контекст роли снимается после отката.
      await c.query('SAVEPOINT f');
      await actAs(c, { userId: noMember.id, roles: ['investor'], dbRole: 'app_backend' });
      let code: string | null = null;
      try {
        await c.query(`INSERT INTO lab.project_favorites (user_id, project_id) VALUES ($1, $2)`, [
          noMember.id,
          projectId,
        ]);
      } catch (e) {
        code = (e as { code?: string }).code ?? null;
      }
      await c.query('ROLLBACK TO SAVEPOINT f');
      await resetRole(c);
      await actAs(c, { userId: null, roles: [] });
      expect(code).toBe('42501');
    });
  });
});
