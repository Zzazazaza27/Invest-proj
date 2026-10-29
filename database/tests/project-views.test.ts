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
 * M089 (5.7.2): проекции для Public View и Investor View.
 *
 *  - `lab.visible_materials`: доступ по предикату materials, состав — по
 *    отметке владельца; private — только команде;
 *  - `lab.project_view_base`: пусто без тизера; описание — только с profile.
 *
 * Снимок согласия, анкета, паспорт и раунд удалены в 2.1-W05: карточка
 * собирается из данных самого проекта.
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

describe('M089: visible_materials и project_view_base', () => {
  it('материалы: private только команде; инвестору без разрешения и анониму в public — ничего', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const investor = await createUser(c, { role: 'investor' });
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
      // Допуска по роли нет (2.1-W05): инвестор в режиме «все» видит то же,
      // что аноним, — материалов не видит ни тот, ни другой.
      for (const v of [anon, asUser(investor.id, 'investor')]) {
        const rows = await as(c, v, () =>
          c.query(`SELECT 1 FROM lab.visible_materials($1)`, [projectId]),
        );
        expect(rows.rowCount).toBe(0);
      }
      const forOwner = await as(c, asUser(owner.id, 'founder'), () =>
        c.query<{ visibility: string }>(`SELECT visibility FROM lab.visible_materials($1)`, [
          projectId,
        ]),
      );
      expect(forOwner.rows.map((r) => r.visibility).sort()).toEqual(['investors', 'private']);

      // Grant {materials} в режиме selected_investors: отмеченные материалы есть,
      // описания — нет.
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
        c.query<{ visibility: string }>(`SELECT visibility FROM lab.visible_materials($1)`, [
          projectId,
        ]),
      );
      expect(mats.rows.map((r) => r.visibility)).toEqual(['investors']);
      // Инвестор без разрешения в режиме выбранных не получает даже тизера.
      expect(
        (
          await as(c, asUser(investor.id, 'investor'), () =>
            c.query(`SELECT 1 FROM lab.project_view_base($1)`, [projectId]),
          )
        ).rowCount,
      ).toBe(0);
    });
  });

  it('project_view_base: пусто без тизера; описание только с profile', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      await c.query(`UPDATE lab.projects SET description = 'Описание' WHERE id = $1`, [projectId]);
      const forAnon = await as(c, anon, () =>
        c.query<{ teaser_audience: string; profile_audience: string; description: string | null }>(
          `SELECT teaser_audience, profile_audience, description FROM lab.project_view_base($1)`,
          [projectId],
        ),
      );
      expect(forAnon.rows[0]).toEqual({
        teaser_audience: 'public',
        profile_audience: 'public',
        description: 'Описание',
      });

      // «Зарегистрированные инвесторы»: допуска по роли нет — вне команды
      // проект не виден никому.
      await c.query(`UPDATE lab.projects SET visibility = 'registered_investors' WHERE id = $1`, [
        projectId,
      ]);
      const investor = await createUser(c, { role: 'investor' });
      for (const v of [anon, asUser(investor.id, 'investor')]) {
        expect(
          (await as(c, v, () => c.query(`SELECT 1 FROM lab.project_view_base($1)`, [projectId])))
            .rowCount,
        ).toBe(0);
      }

      // selected_investors без разрешения: ни инвестор, ни посторонний
      // основатель не получают даже тизера — факт существования проекта закрыт.
      await c.query(`UPDATE lab.projects SET visibility = 'selected_investors' WHERE id = $1`, [
        projectId,
      ]);
      const stranger = await createUser(c, { role: 'founder' });
      for (const v of [anon, asUser(investor.id, 'investor'), asUser(stranger.id, 'founder')]) {
        expect(
          (await as(c, v, () => c.query(`SELECT 1 FROM lab.project_view_base($1)`, [projectId])))
            .rowCount,
        ).toBe(0);
      }
      // Команда видит всё.
      const forOwner = await as(c, asUser(owner.id, 'founder'), () =>
        c.query<{ profile_audience: string }>(
          `SELECT profile_audience FROM lab.project_view_base($1)`,
          [projectId],
        ),
      );
      expect(forOwner.rows).toEqual([{ profile_audience: 'private' }]);
    });
  });
});
