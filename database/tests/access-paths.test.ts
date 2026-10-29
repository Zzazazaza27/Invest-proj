import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers.ts';
import {
  actAs,
  closePool,
  createProject,
  createUser,
  inRollbackTx,
  resetRole,
  uuidv7,
} from './helpers.ts';

/**
 * M090 (5.7.5): старые пути закрыты — RLS и вью на предикате доступа.
 *
 *  - инвестор не читает строки проектов напрямую; данные — только через
 *    проекции по предикату;
 *  - материалы: по предикату materials И отметке владельца; grant {materials}
 *    в selected_investors читает только отмеченные; исключённый — ничего;
 *  - пользователь с несколькими ролями (founder + investor) на чужом
 *    закрытом проекте — ничего, на своём — всё;
 *  - каталог (v_public_catalog) — по сессии зрителя; избранное — только
 *    проект с доступным тизером.
 *
 * Допуска инвестора по роли нет с 2.1-W05 (он держался на подписке):
 * инвестор без личного разрешения видит ровно то, что аноним.
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

describe('M090: строки проектов инвестору не читаются', () => {
  it('инвестор: строки projects — пусто; проекция — по предикату, как анониму', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const investor = await createUser(c, { role: 'investor' });
      const v = asUser(investor.id, 'investor');

      expect(await count(c, v, `SELECT 1 FROM lab.projects WHERE id = $1`, [projectId])).toBe(0);
      const view = await as(c, v, () =>
        c.query<{ profile_audience: string }>(
          `SELECT profile_audience FROM lab.project_view_base($1)`,
          [projectId],
        ),
      );
      expect(view.rows).toEqual([{ profile_audience: 'public' }]);
      // Команда — строки как прежде.
      const team = asUser(owner.id, 'founder');
      expect(await count(c, team, `SELECT 1 FROM lab.projects WHERE id = $1`, [projectId])).toBe(1);
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

      // Исключение закрывает и проекцию, и каталог.
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
  it('в режиме «все» материалов вне команды не видит никто; grant {materials} — только отмеченные; исключённый — ничего', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const privateId = await addMaterial(c, projectId, owner.id, 'private', 1);
      const openId = await addMaterial(c, projectId, owner.id, 'investors', 2);
      const investor = await createUser(c, { role: 'investor' });
      const rowsOf = (v: Viewer) =>
        as(c, v, async () =>
          (
            await c.query<{ id: string }>(
              `SELECT id FROM lab.project_materials WHERE project_id = $1 ORDER BY version`,
              [projectId],
            )
          ).rows.map((r) => r.id),
        );

      // Допуска по роли нет: отметка «инвесторам» в режиме «все» ничего не
      // открывает без личного разрешения.
      expect(await rowsOf(asUser(investor.id, 'investor'))).toEqual([]);
      expect(await rowsOf(asUser(owner.id, 'founder'))).toEqual([privateId, openId]);

      await c.query(`UPDATE lab.projects SET visibility = 'selected_investors' WHERE id = $1`, [
        projectId,
      ]);
      expect(await rowsOf(asUser(investor.id, 'investor'))).toEqual([]);
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
  it('каталог и избранное: в режиме «все» — всем; «зарегистрированные инвесторы» — никому вне команды', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const investor = await createUser(c, { role: 'investor' });
      const inCatalog = (v: Viewer) =>
        count(c, v, `SELECT 1 FROM lab.v_public_catalog WHERE id = $1`, [projectId]);
      const investorPublic = {
        ...asUser(investor.id, 'investor'),
        dbRole: 'app_public_read' as const,
      };

      expect(await inCatalog(anon)).toBe(1);
      expect(await inCatalog(investorPublic)).toBe(1);
      await as(c, asUser(investor.id, 'investor'), () =>
        c.query(`INSERT INTO lab.project_favorites (user_id, project_id) VALUES ($1, $2)`, [
          investor.id,
          projectId,
        ]),
      );

      await c.query(`UPDATE lab.projects SET visibility = 'registered_investors' WHERE id = $1`, [
        projectId,
      ]);
      expect(await inCatalog(anon)).toBe(0);
      expect(await inCatalog(investorPublic)).toBe(0);

      // Ожидаемая ошибка — под SAVEPOINT; контекст роли снимается после отката.
      const other = await createUser(c, { role: 'investor' });
      await c.query('SAVEPOINT f');
      await actAs(c, { userId: other.id, roles: ['investor'], dbRole: 'app_backend' });
      let code: string | null = null;
      try {
        await c.query(`INSERT INTO lab.project_favorites (user_id, project_id) VALUES ($1, $2)`, [
          other.id,
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
