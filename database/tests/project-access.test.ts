import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers.ts';
import {
  actAs,
  approveKyc,
  closePool,
  createEntity,
  createProject,
  createUser,
  inRollbackTx,
  resetRole,
  uuidv7,
} from './helpers.ts';

/**
 * M087 (5.7.1): режим видимости проекта и предикат аудитории.
 *
 *  - матрица предикат × режим × зритель совпадает с `projectAudience()` в
 *    @fifth/contracts (та же таблица ожиданий, что в
 *    packages/contracts/tests/visibility.test.ts);
 *  - grant — набор разрешений: {materials} даёт материалы и тизер, не описание;
 *  - исключение перекрывает режим и grant;
 *  - допуска инвестора по роли нет (2.1-W05: держался на подписке) — инвестор
 *    без личного разрешения видит то же, что аноним; удалённые роли прав не
 *    дают.
 */

afterAll(async () => {
  await closePool();
});

type Viewer = { userId: string | null; roles: string[]; dbRole: 'app_backend' | 'app_public_read' };
const PERMS = ['teaser', 'profile', 'materials', 'extended'] as const;
type Perm = (typeof PERMS)[number];

async function audience(
  c: Client,
  v: Viewer,
  projectId: string,
  perm: Perm,
): Promise<string | null> {
  await actAs(c, { userId: v.userId, roles: v.roles, dbRole: v.dbRole });
  const { rows } = await c.query<{ a: string | null }>(
    `SELECT lab.project_audience($1, $2, $3) AS a`,
    [projectId, v.userId, perm],
  );
  await resetRole(c);
  // RESET ROLE не снимает GUC сессии: без этого следующий UPDATE в тесте
  // пошёл бы от роли последнего зрителя.
  await actAs(c, { userId: null, roles: [] });
  return rows[0]!.a;
}

async function setMode(c: Client, projectId: string, mode: string): Promise<void> {
  await c.query(`UPDATE lab.projects SET visibility = $2 WHERE id = $1`, [projectId, mode]);
}

/**
 * Флаг организационных выдач (M092). По умолчанию выключен: пока нет
 * управления составом организации, разрешение организации не создаётся и не
 * действует. Тесты включают его там, где проверяют сохранённую возможность.
 */
async function setEntityGrants(c: Client, enabled: boolean): Promise<void> {
  await actAs(c, { roles: ['admin'] });
  await c.query(`UPDATE audit.feature_flags SET enabled = $1 WHERE key = $2`, [
    enabled,
    'access.entity_grants.enabled',
  ]);
  await actAs(c, { roles: [] });
}

async function grant(
  c: Client,
  projectId: string,
  by: string,
  who: { userId?: string; entityId?: string },
  permissions: string[],
): Promise<void> {
  await c.query(
    `INSERT INTO lab.project_access_grants
       (id, project_id, grantee_user_id, grantee_entity_id, permissions, granted_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv7(), projectId, who.userId ?? null, who.entityId ?? null, permissions, by],
  );
}

async function exclude(
  c: Client,
  projectId: string,
  by: string,
  who: { userId?: string; entityId?: string },
): Promise<void> {
  await c.query(
    `INSERT INTO lab.project_access_exclusions
       (id, project_id, excluded_user_id, excluded_entity_id, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuidv7(), projectId, who.userId ?? null, who.entityId ?? null, by],
  );
}

const anon: Viewer = { userId: null, roles: [], dbRole: 'app_public_read' };
const asUser = (userId: string, ...roles: string[]): Viewer => ({
  userId,
  roles,
  dbRole: 'app_backend',
});

describe('M087: предикат аудитории — матрица режим × зритель', () => {
  it('public: аноним и инвестор без разрешения — public на тизер и профиль, ничего на материалы', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const investor = await createUser(c, { role: 'investor' });

      const expected: Record<Perm, [string | null, string | null]> = {
        // [аноним, инвестор без личного разрешения]
        teaser: ['public', 'public'],
        profile: ['public', 'public'],
        materials: [null, null],
        extended: [null, null],
      };
      for (const perm of PERMS) {
        expect([
          await audience(c, anon, projectId, perm),
          await audience(c, asUser(investor.id, 'investor'), projectId, perm),
        ]).toEqual(expected[perm]);
      }
    });
  });

  it('private и registered_investors: вне команды — ничего; команда и админ — private', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const admin = await createUser(c, { role: 'admin' });
      const investor = await createUser(c, { role: 'investor' });

      for (const mode of ['private', 'registered_investors']) {
        await setMode(c, projectId, mode);
        for (const perm of PERMS) {
          expect(await audience(c, anon, projectId, perm)).toBeNull();
          expect(await audience(c, asUser(investor.id, 'investor'), projectId, perm)).toBeNull();
          expect(await audience(c, asUser(owner.id, 'founder'), projectId, perm)).toBe('private');
          expect(await audience(c, asUser(admin.id, 'admin'), projectId, perm)).toBe('private');
        }
      }
    });
  });

  it('selected_investors: grant — набор разрешений; {materials} не даёт описания; допуск личный', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      await setMode(c, projectId, 'selected_investors');
      const gMaterials = await createUser(c, { role: 'investor' });
      const gProfile = await createUser(c, { role: 'founder' }); // роль не важна — допуск личный
      const investor = await createUser(c, { role: 'investor' });
      await grant(c, projectId, owner.id, { userId: gMaterials.id }, ['materials']);
      await grant(c, projectId, owner.id, { userId: gProfile.id }, ['profile']);

      const m = asUser(gMaterials.id, 'investor');
      expect(await audience(c, m, projectId, 'teaser')).toBe('investors');
      expect(await audience(c, m, projectId, 'materials')).toBe('investors');
      expect(await audience(c, m, projectId, 'profile')).toBeNull();

      const p = asUser(gProfile.id, 'founder');
      expect(await audience(c, p, projectId, 'profile')).toBe('investors');
      expect(await audience(c, p, projectId, 'materials')).toBeNull();

      // Инвестор без grant — ничего; аноним — ничего.
      for (const perm of PERMS) {
        expect(await audience(c, asUser(investor.id, 'investor'), projectId, perm)).toBeNull();
        expect(await audience(c, anon, projectId, perm)).toBeNull();
      }

      // Отзыв закрывает сразу.
      await c.query(
        `UPDATE lab.project_access_grants SET revoked_at = now() WHERE grantee_user_id = $1`,
        [gMaterials.id],
      );
      expect(await audience(c, m, projectId, 'teaser')).toBeNull();
    });
  });

  it('extended — только с разрешением и действующим KYC; аудитория остаётся investors', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      await setMode(c, projectId, 'selected_investors');
      const g = await createUser(c, { role: 'investor' });
      await grant(c, projectId, owner.id, { userId: g.id }, ['extended', 'profile']);
      const v = asUser(g.id, 'investor');
      expect(await audience(c, v, projectId, 'extended')).toBeNull();
      await approveKyc(c, g.id);
      expect(await audience(c, v, projectId, 'extended')).toBe('investors');
      // В открытых режимах extended не выдаётся никому.
      await setMode(c, projectId, 'public');
      expect(await audience(c, v, projectId, 'extended')).toBeNull();
    });
  });

  it('организационная выдача отложена (M092): не создаётся и не даёт доступа, пока флаг выключен', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      await setMode(c, projectId, 'selected_investors');
      const rep = await createUser(c, { role: 'investor' });
      const entityId = await createEntity(c, rep.id); // rep — signatory организации
      const v = asUser(rep.id, 'investor');

      // Путь записи закрыт в БД, а не в интерфейсе: обойти новым маршрутом
      // или служебной консолью нельзя.
      await c.query('SAVEPOINT entity_grant');
      await expect(grant(c, projectId, owner.id, { entityId }, ['profile'])).rejects.toThrow();
      await c.query('ROLLBACK TO SAVEPOINT entity_grant');
      await c.query('SAVEPOINT entity_exclusion');
      await expect(exclude(c, projectId, owner.id, { entityId })).rejects.toThrow();
      await c.query('ROLLBACK TO SAVEPOINT entity_exclusion');

      // Запись, заведённая при включённом флаге, перестаёт давать доступ,
      // как только направление отложено обратно.
      await setEntityGrants(c, true);
      await grant(c, projectId, owner.id, { entityId }, ['profile', 'materials']);
      expect(await audience(c, v, projectId, 'materials')).toBe('investors');
      await setEntityGrants(c, false);
      for (const perm of PERMS) expect(await audience(c, v, projectId, perm)).toBeNull();

      // Отзыв унаследованной записи разрешён и при выключенном флаге: иначе
      // закрыть её было бы нечем.
      await c.query(
        `UPDATE lab.project_access_grants SET revoked_at = now()
          WHERE project_id = $1 AND grantee_entity_id = $2`,
        [projectId, entityId],
      );
      const [row] = (
        await c.query<{ revoked: boolean }>(
          `SELECT revoked_at IS NOT NULL AS revoked FROM lab.project_access_grants
            WHERE project_id = $1 AND grantee_entity_id = $2`,
          [projectId, entityId],
        )
      ).rows;
      expect(row?.revoked).toBe(true);
    });
  });

  it('организационное исключение продолжает запрещать; исключение сильнее grant', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      await setMode(c, projectId, 'selected_investors');
      const rep = await createUser(c, { role: 'investor' });
      const entityId = await createEntity(c, rep.id);
      const v = asUser(rep.id, 'investor');

      // Личное разрешение действует, организационное исключение его снимает:
      // запрет — сторона, которую откладывать небезопасно, поэтому ветка
      // исключений по организации осталась рабочей (M092).
      await grant(c, projectId, owner.id, { userId: rep.id }, ['profile', 'materials']);
      expect(await audience(c, v, projectId, 'materials')).toBe('investors');
      await setEntityGrants(c, true);
      await exclude(c, projectId, owner.id, { entityId });
      await setEntityGrants(c, false);
      for (const perm of PERMS) expect(await audience(c, v, projectId, perm)).toBeNull();

      // Исключение пользователя перекрывает и режим public.
      await setMode(c, projectId, 'public');
      const investor = await createUser(c, { role: 'investor' });
      expect(await audience(c, asUser(investor.id, 'investor'), projectId, 'teaser')).toBe(
        'public',
      );
      await exclude(c, projectId, owner.id, { userId: investor.id });
      expect(await audience(c, asUser(investor.id, 'investor'), projectId, 'teaser')).toBeNull();
      // Аноним в public по-прежнему видит тизер: исключение — для входа под учёткой.
      expect(await audience(c, anon, projectId, 'teaser')).toBe('public');
    });
  });

  it('заблокированный и удалённый проект закрыты внешним; команда и админ видят; удалённые роли прав не дают', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const admin = await createUser(c, { role: 'admin' });
      const outsider = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const projectId = await createProject(c, owner.id, { listed: true });

      await c.query(
        `UPDATE lab.projects SET blocked_at = now(), blocked_reason = 'жалоба' WHERE id = $1`,
        [projectId],
      );
      expect(await audience(c, anon, projectId, 'teaser')).toBeNull();
      expect(await audience(c, asUser(investor.id, 'investor'), projectId, 'profile')).toBeNull();
      expect(await audience(c, asUser(owner.id, 'founder'), projectId, 'profile')).toBe('private');
      expect(await audience(c, asUser(admin.id, 'admin'), projectId, 'profile')).toBe('private');
      await c.query(
        `UPDATE lab.projects SET blocked_at = NULL, blocked_reason = NULL WHERE id = $1`,
        [projectId],
      );

      // Удалённые роли (2.1-W05), даже дойдя до сессии, не дают ничего сверх
      // обычного вошедшего: в private — ничего, в public — только общедоступное.
      const removed = asUser(outsider.id, 'organizer', 'expert', 'showrunner');
      await setMode(c, projectId, 'private');
      for (const perm of PERMS) expect(await audience(c, removed, projectId, perm)).toBeNull();
      await setMode(c, projectId, 'public');
      expect(await audience(c, removed, projectId, 'teaser')).toBe('public');
      expect(await audience(c, removed, projectId, 'materials')).toBeNull();
      await actAs(c, { userId: outsider.id, roles: ['organizer'], dbRole: 'app_backend' });
      const hasRole = await c.query<{ r: boolean }>(`SELECT app.has_role('organizer') AS r`);
      await resetRole(c);
      await actAs(c, { userId: null, roles: [] });
      // has_role отвечает по сессии честно; прав роли не даёт ни одна политика.
      expect(hasRole.rows[0]!.r).toBe(true);

      await c.query(`UPDATE lab.projects SET deleted_at = now() WHERE id = $1`, [projectId]);
      expect(await audience(c, anon, projectId, 'teaser')).toBeNull();
      expect(await audience(c, asUser(owner.id, 'founder'), projectId, 'teaser')).toBe('private');
    });
  });

  it('неизвестное разрешение — NULL (fail-closed)', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      expect(
        await audience(c, asUser(owner.id, 'founder'), projectId, 'everything' as Perm),
      ).toBeNull();
    });
  });
});

describe('M087: перенос и ограничения разрешений', () => {
  it('после миграции: материалы private, листинг — только в режиме «все»', async () => {
    await inRollbackTx(async (c) => {
      const materials = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lab.project_materials WHERE visibility <> 'private'`,
      );
      expect(Number(materials.rows[0]!.n)).toBe(0);
      const listed = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lab.projects
          WHERE listing_status = 'listed' AND deleted_at IS NULL AND visibility <> 'public'`,
      );
      expect(Number(listed.rows[0]!.n)).toBe(0);
    });
  });

  it('сезоны и удалённые флаги (2.1-W05): ни проекций, ни флагов, ни функций', async () => {
    await inRollbackTx(async (c) => {
      const schemas = await c.query(
        `SELECT nspname FROM pg_namespace WHERE nspname IN ('seasons', 'experts', 'scoring', 'investments')`,
      );
      expect(schemas.rows).toEqual([]);
      const flags = await c.query<{ key: string }>(
        `SELECT key FROM audit.feature_flags
          WHERE key ~ '^(ai|billing|investments)\\.' OR key IN ('seasons.enabled',
                'show.publication.enabled', 'capital.integration.enabled', 'lab.ui.application_v2')`,
      );
      expect(flags.rows).toEqual([]);
      const fns = await c.query(
        `SELECT proname FROM pg_proc
          WHERE proname IN ('seasons_enabled', 'investor_gate', 'viewer_audience',
                            'has_active_investor_membership', 'round_view', 'disclosed_profile')`,
      );
      expect(fns.rows).toEqual([]);
    });
  });

  it('grant: пустой набор, неизвестное и удалённое разрешение отвергаются; ровно один получатель', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const g = await createUser(c, { role: 'investor' });
      for (const bad of [
        [projectId, g.id, null, []],
        [projectId, g.id, null, ['everything']],
        // Удалённые части разрешения (2.1-W05) больше не принимаются.
        [projectId, g.id, null, ['round']],
        [projectId, g.id, null, ['passport']],
        [projectId, null, null, ['profile']],
      ]) {
        await c.query('SAVEPOINT g');
        await expect(
          c.query(
            `INSERT INTO lab.project_access_grants
               (id, project_id, grantee_user_id, grantee_entity_id, permissions, granted_by)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [uuidv7(), ...bad, owner.id],
          ),
        ).rejects.toThrow();
        await c.query('ROLLBACK TO SAVEPOINT g');
      }
    });
  });
});
