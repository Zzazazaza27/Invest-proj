import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers.ts';
import {
  actAs,
  approveKyc,
  closePool,
  createEntity,
  createInvestorSubscription,
  createProject,
  createUser,
  inRollbackTx,
  resetRole,
  uuidv7,
} from './helpers.ts';

/**
 * M087 (5.7.1): режим видимости проекта, предикат аудитории, согласие
 * владельца, барьер подписки как настройка.
 *
 *  - матрица предикат × режим × зритель совпадает с `projectAudience()` в
 *    @unicorn/contracts (та же таблица ожиданий, что в
 *    packages/contracts/tests/visibility.test.ts);
 *  - grant — набор разрешений: {materials} даёт материалы и тизер, не ответы;
 *  - исключение перекрывает режим и grant; организатор — тизер сезона;
 *  - барьер подписки — флаг: включён (умолчание) → нужно членство,
 *    выключен → достаточно роли; права на данные флагом не обходятся;
 *  - после миграции наружу не ушло ничего нового: согласий нет, материалы
 *    закрыты, round_view для private пуст.
 */

afterAll(async () => {
  await closePool();
});

type Viewer = { userId: string | null; roles: string[]; dbRole: 'app_backend' | 'app_public_read' };
const PERMS = ['teaser', 'profile', 'round', 'materials', 'passport', 'extended'] as const;
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
  // пошёл бы от роли последнего зрителя (например, организатора с триггером
  // «только статус»).
  await actAs(c, { userId: null, roles: [] });
  return rows[0]!.a;
}

async function setMode(c: Client, projectId: string, mode: string): Promise<void> {
  await c.query(`UPDATE lab.projects SET visibility = $2 WHERE id = $1`, [projectId, mode]);
}

async function setBarrier(c: Client, enabled: boolean): Promise<void> {
  await actAs(c, { roles: ['admin'] });
  await c.query(
    `UPDATE audit.feature_flags SET enabled = $1
      WHERE key = 'billing.investor_access_requires_subscription'`,
    [enabled],
  );
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
  it('public: аноним — public на тизер/профиль/раунд, ничего на материалы/паспорт; инвестор с членством — investors', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const investor = await createUser(c, { role: 'investor' });
      const memberInv = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, memberInv.id);

      const expected: Record<Perm, [string | null, string | null, string | null]> = {
        // [аноним, инвестор без членства (барьер включён), инвестор с членством]
        teaser: ['public', 'public', 'investors'],
        profile: ['public', 'public', 'investors'],
        round: ['public', 'public', 'investors'],
        materials: [null, null, 'investors'],
        passport: [null, null, 'investors'],
        extended: [null, null, null],
      };
      for (const perm of PERMS) {
        expect([
          await audience(c, anon, projectId, perm),
          await audience(c, asUser(investor.id, 'investor'), projectId, perm),
          await audience(c, asUser(memberInv.id, 'investor'), projectId, perm),
        ]).toEqual(expected[perm]);
      }
    });
  });

  it('private и registered_investors: внешним по режиму; команда — private, админ — private, рецензент — platform', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const admin = await createUser(c, { role: 'admin' });
      const memberInv = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, memberInv.id);
      const expert = await createUser(c, { role: 'expert' });
      await c.query(
        `INSERT INTO experts.experts (user_id, expertise_tags) VALUES ($1, ARRAY['fintech'])`,
        [expert.id],
      );
      await c.query(
        `INSERT INTO experts.expert_assignments
           (id, project_id, expert_id, assigned_reason, status, due_at)
         VALUES ($1, $2, $3, 'manual', 'accepted', now() + interval '7 days')`,
        [uuidv7(), projectId, expert.id],
      );

      await setMode(c, projectId, 'private');
      for (const perm of PERMS) {
        expect(await audience(c, anon, projectId, perm)).toBeNull();
        expect(await audience(c, asUser(memberInv.id, 'investor'), projectId, perm)).toBeNull();
        expect(await audience(c, asUser(owner.id, 'founder'), projectId, perm)).toBe('private');
        expect(await audience(c, asUser(admin.id, 'admin'), projectId, perm)).toBe('private');
        expect(await audience(c, asUser(expert.id, 'expert'), projectId, perm)).toBe(
          perm === 'extended' ? null : 'platform',
        );
      }

      await setMode(c, projectId, 'registered_investors');
      for (const perm of PERMS) {
        expect(await audience(c, anon, projectId, perm)).toBeNull();
        expect(await audience(c, asUser(memberInv.id, 'investor'), projectId, perm)).toBe(
          perm === 'extended' ? null : 'investors',
        );
      }
    });
  });

  it('selected_investors: grant — набор разрешений; {materials} не даёт ответов; допуск личный, членство не нужно', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      await setMode(c, projectId, 'selected_investors');
      const gMaterials = await createUser(c, { role: 'investor' });
      const gProfile = await createUser(c, { role: 'founder' }); // роль не важна — допуск личный
      const memberInv = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, memberInv.id);
      await grant(c, projectId, owner.id, { userId: gMaterials.id }, ['materials']);
      await grant(c, projectId, owner.id, { userId: gProfile.id }, ['profile']);

      const m = asUser(gMaterials.id, 'investor');
      expect(await audience(c, m, projectId, 'teaser')).toBe('investors');
      expect(await audience(c, m, projectId, 'materials')).toBe('investors');
      expect(await audience(c, m, projectId, 'profile')).toBeNull();
      expect(await audience(c, m, projectId, 'round')).toBeNull();
      expect(await audience(c, m, projectId, 'passport')).toBeNull();

      const p = asUser(gProfile.id, 'founder');
      expect(await audience(c, p, projectId, 'profile')).toBe('investors');
      expect(await audience(c, p, projectId, 'materials')).toBeNull();

      // Инвестор с членством, но без grant — ничего; аноним — ничего.
      for (const perm of PERMS) {
        expect(await audience(c, asUser(memberInv.id, 'investor'), projectId, perm)).toBeNull();
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

  it('grant и исключение по организации действуют на её участников; исключение сильнее grant', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      await setMode(c, projectId, 'selected_investors');
      const rep = await createUser(c, { role: 'investor' });
      const entityId = await createEntity(c, rep.id); // rep — signatory организации
      await grant(c, projectId, owner.id, { entityId }, ['profile', 'round']);
      const v = asUser(rep.id, 'investor');
      expect(await audience(c, v, projectId, 'round')).toBe('investors');
      expect(await audience(c, v, projectId, 'materials')).toBeNull();

      await exclude(c, projectId, owner.id, { entityId });
      for (const perm of PERMS) expect(await audience(c, v, projectId, perm)).toBeNull();

      // Исключение пользователя перекрывает и режим public.
      await setMode(c, projectId, 'public');
      const memberInv = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, memberInv.id);
      await exclude(c, projectId, owner.id, { userId: memberInv.id });
      expect(await audience(c, asUser(memberInv.id, 'investor'), projectId, 'teaser')).toBeNull();
      // Аноним в public по-прежнему видит тизер: исключение — для входа под учёткой.
      expect(await audience(c, anon, projectId, 'teaser')).toBe('public');
    });
  });

  it('заблокированный и удалённый проект закрыты внешним; команда и админ видят; организатор — тизер сезона', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const admin = await createUser(c, { role: 'admin' });
      const organizer = await createUser(c, { role: 'organizer' });
      const memberInv = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, memberInv.id);
      const projectId = await createProject(c, owner.id, { listed: true });

      await c.query(
        `UPDATE lab.projects SET blocked_at = now(), blocked_reason = 'жалоба' WHERE id = $1`,
        [projectId],
      );
      expect(await audience(c, anon, projectId, 'teaser')).toBeNull();
      expect(await audience(c, asUser(memberInv.id, 'investor'), projectId, 'profile')).toBeNull();
      expect(await audience(c, asUser(owner.id, 'founder'), projectId, 'profile')).toBe('private');
      expect(await audience(c, asUser(admin.id, 'admin'), projectId, 'profile')).toBe('private');
      await c.query(
        `UPDATE lab.projects SET blocked_at = NULL, blocked_reason = NULL WHERE id = $1`,
        [projectId],
      );

      // Организатор: тизер проекта сезона даже в private; без сезона — ничего; профиль — никогда.
      const org = asUser(organizer.id, 'organizer');
      const { rows } = await c.query<{ season_id: string | null }>(
        `SELECT season_id FROM lab.projects WHERE id = $1`,
        [projectId],
      );
      if (rows[0]!.season_id === null) {
        const { rows: s } = await c.query<{ id: string }>(`SELECT id FROM seasons.seasons LIMIT 1`);
        expect(s[0]).toBeDefined();
        await c.query(`UPDATE lab.projects SET season_id = $2 WHERE id = $1`, [
          projectId,
          s[0]!.id,
        ]);
      }
      await setMode(c, projectId, 'private');
      expect(await audience(c, org, projectId, 'teaser')).toBe('public');
      expect(await audience(c, org, projectId, 'profile')).toBeNull();
      await c.query(`UPDATE lab.projects SET season_id = NULL WHERE id = $1`, [projectId]);
      await setMode(c, projectId, 'public');
      expect(await audience(c, org, projectId, 'teaser')).toBeNull();

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

describe('M087: барьер подписки — настройка, не миграция', () => {
  it('включён (умолчание): нужно членство; выключен: достаточно роли investor; права на данные не обходятся', async () => {
    await inRollbackTx(async (c) => {
      const { rows } = await c.query<{ enabled: boolean }>(
        `SELECT enabled FROM audit.feature_flags WHERE key = 'billing.investor_access_requires_subscription'`,
      );
      expect(rows[0]?.enabled).toBe(true);

      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      await setMode(c, projectId, 'registered_investors');
      const investor = await createUser(c, { role: 'investor' });
      const v = asUser(investor.id, 'investor');
      expect(await audience(c, v, projectId, 'profile')).toBeNull();

      await setBarrier(c, false);
      expect(await audience(c, v, projectId, 'profile')).toBe('investors');
      // Роль не investor — допуска нет и при выключенном барьере.
      expect(await audience(c, asUser(investor.id, 'founder'), projectId, 'profile')).toBeNull();
      // Режим private и исключение — сильнее флага.
      await setMode(c, projectId, 'private');
      expect(await audience(c, v, projectId, 'teaser')).toBeNull();
      await setMode(c, projectId, 'public');
      await exclude(c, projectId, owner.id, { userId: investor.id });
      expect(await audience(c, v, projectId, 'teaser')).toBeNull();
      // viewer_audience — та же точка.
      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const va = await c.query<{ a: string }>(`SELECT lab.viewer_audience() AS a`);
      await resetRole(c);
      expect(va.rows[0]!.a).toBe('investors');
    });
  });
});

describe('M087: согласие владельца и эффективная видимость', () => {
  it('без согласия — private; с согласием — строже из активной конфигурации и версии согласия', async () => {
    await inRollbackTx(async (c) => {
      await c.query(`UPDATE lab.application_form_versions SET is_active = false WHERE is_active`);
      const publish = async (vis: string): Promise<number> => {
        await c.query(`UPDATE lab.application_form_versions SET is_active = false WHERE is_active`);
        const { rows } = await c.query<{ version: number }>(
          `INSERT INTO lab.application_form_versions
             (id, version, status, is_active, config_jsonb, reason, published_at, activated_at)
           VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM lab.application_form_versions),
                   'published', true, $2::jsonb, 'тест согласия', now(), now())
           RETURNING version`,
          [
            uuidv7(),
            JSON.stringify({ questions: [{ key: 'problem_statement', visibility: vis }] }),
          ],
        );
        return rows[0]!.version;
      };
      const q = async (v: number | null): Promise<string> =>
        (
          await c.query<{ e: string }>(
            `SELECT lab.effective_visibility('problem_statement', $1) AS e`,
            [v],
          )
        ).rows[0]!.e;

      const v1 = await publish('investors');
      expect(await q(null)).toBe('private');
      expect(await q(v1)).toBe('investors');
      // Администратор смягчил — согласие v1 держит investors.
      const v2 = await publish('public');
      expect(await q(v1)).toBe('investors');
      // Владелец применил v2 — public.
      expect(await q(v2)).toBe('public');
      // Администратор ужесточил — сразу для любого согласия.
      await publish('platform');
      expect(await q(v1)).toBe('platform');
      expect(await q(v2)).toBe('platform');
      // Ключа нет ни в активной, ни в версии согласия — private.
      const missing = await c.query<{ e: string }>(
        `SELECT lab.effective_visibility('no_such_question', $1) AS e`,
        [v2],
      );
      expect(missing.rows[0]!.e).toBe('private');
    });
  });

  it('снимок согласия обязан принадлежать проекту; снимок и версия ставятся вместе', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const a = await createProject(c, owner.id);
      const b = await createProject(c, owner.id);
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM lab.investment_applications WHERE project_id = $1`,
        [b],
      );
      const versionId = uuidv7();
      await c.query(
        `INSERT INTO lab.project_versions (id, project_id, application_id, version_no, snapshot_jsonb, schema_version)
         VALUES ($1, $2, $3, 1, '{}', 1)`,
        [versionId, b, rows[0]!.id],
      );
      await c.query('SAVEPOINT s1');
      await expect(
        c.query(
          `UPDATE lab.projects SET disclosed_version_id = $2, disclosure_form_version = 1 WHERE id = $1`,
          [a, versionId],
        ),
      ).rejects.toThrow();
      await c.query('ROLLBACK TO SAVEPOINT s1');
      await c.query('SAVEPOINT s2');
      await expect(
        c.query(`UPDATE lab.projects SET disclosed_version_id = $2 WHERE id = $1`, [b, versionId]),
      ).rejects.toThrow();
      await c.query('ROLLBACK TO SAVEPOINT s2');
      await c.query(
        `UPDATE lab.projects SET disclosed_version_id = $2, disclosure_form_version = 1 WHERE id = $1`,
        [b, versionId],
      );
    });
  });
});

describe('M087: перенос ничего не раскрыл; проекция сезона', () => {
  it('после миграции: согласий нет, материалы private; round_view пуст для private и отдаёт строку для public', async () => {
    await inRollbackTx(async (c) => {
      const consents = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lab.projects WHERE disclosed_version_id IS NOT NULL`,
      );
      expect(Number(consents.rows[0]!.n)).toBe(0);
      const materials = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lab.project_materials WHERE visibility <> 'private'`,
      );
      expect(Number(materials.rows[0]!.n)).toBe(0);
      const listed = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lab.projects
          WHERE listing_status = 'listed' AND deleted_at IS NULL AND visibility <> 'public'`,
      );
      expect(Number(listed.rows[0]!.n)).toBe(0);

      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const memberInv = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, memberInv.id);
      const rv = async (v: Viewer): Promise<number> => {
        await actAs(c, { userId: v.userId, roles: v.roles, dbRole: v.dbRole });
        const { rowCount } = await c.query(`SELECT * FROM lab.round_view($1)`, [projectId]);
        await resetRole(c);
        await actAs(c, { userId: null, roles: [] });
        return rowCount ?? 0;
      };
      expect(await rv(anon)).toBe(1);
      expect(await rv(asUser(memberInv.id, 'investor'))).toBe(1);
      await setMode(c, projectId, 'private');
      expect(await rv(anon)).toBe(0);
      expect(await rv(asUser(memberInv.id, 'investor'))).toBe(0);
      expect(await rv(asUser(owner.id, 'founder'))).toBe(1);
    });
  });

  it('v_season_projects: перечисленные поля и только проекты сезона', async () => {
    await inRollbackTx(async (c) => {
      const cols = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'lab' AND table_name = 'v_season_projects' ORDER BY ordinal_position`,
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual([
        'id',
        'title',
        'stage',
        'status',
        'season_id',
        'taxonomy_id',
        'geo_country',
        'listed_at',
        'created_at',
        'updated_at',
      ]);
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      await c.query(`UPDATE lab.projects SET season_id = NULL WHERE id = $1`, [projectId]);
      await actAs(c, { userId: owner.id, roles: ['organizer'], dbRole: 'app_backend' });
      const { rowCount } = await c.query(`SELECT id FROM lab.v_season_projects WHERE id = $1`, [
        projectId,
      ]);
      await resetRole(c);
      expect(rowCount).toBe(0);
    });
  });

  it('grant: пустой набор и неизвестное разрешение отвергаются; ровно один получатель', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const g = await createUser(c, { role: 'investor' });
      for (const bad of [
        [projectId, g.id, null, []],
        [projectId, g.id, null, ['everything']],
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
