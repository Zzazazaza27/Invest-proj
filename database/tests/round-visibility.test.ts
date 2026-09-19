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
 * M085: раскрытие полей раунда по настройке видимости и аудитории зрителя.
 *
 *  - `lab.visible_to` — то же правило, что `visibleTo()` в контрактах
 *    (паритет по всем 16 сочетаниям);
 *  - настройка поля не расширяет доступ к закрытому объекту: неопубликованный
 *    проект — пусто для анонима и инвестора при любой видимости;
 *  - стартовое значение `investors`: аноним видит `undisclosed` без суммы,
 *    инвестор с членством — состояние и сумму; публикация версии с
 *    `public` открывает группу анониму; вопрос отсутствует — `private`.
 */

afterAll(async () => {
  await closePool();
});

const EXPECTED: Record<string, string[]> = {
  public: ['public', 'investors', 'platform', 'private'],
  investors: ['investors', 'platform', 'private'],
  platform: ['platform', 'private'],
  private: ['private'],
};

async function publishConfig(
  c: Client,
  visibility: { investment_ask: string; funding_scope: string; funding_scope_note: string } | null,
): Promise<void> {
  await c.query(`UPDATE lab.application_form_versions SET is_active = false WHERE is_active`);
  const questions =
    visibility === null
      ? []
      : Object.entries(visibility).map(([key, vis]) => ({ key, visibility: vis }));
  await c.query(
    `INSERT INTO lab.application_form_versions
       (id, version, status, is_active, config_jsonb, reason, published_at, activated_at)
     VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM lab.application_form_versions),
             'published', true, $2::jsonb, 'тест видимости раунда', now(), now())`,
    [uuidv7(), JSON.stringify({ questions })],
  );
  // Открытые раунды переводятся на новую версию условий — эквивалент действия
  // владельца «Применить новые условия»: иначе раунд остался бы на прежних
  // условиях (M086), и тест проверял бы не то, что заявляет.
  await c.query(
    `UPDATE lab.funding_rounds
        SET disclosure_version = (SELECT version FROM lab.application_form_versions
                                   WHERE is_active LIMIT 1)
      WHERE status IN ('open', 'paused')`,
  );
}

async function insertOpenRound(c: Client, projectId: string, by: string): Promise<void> {
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
  // Версия условий раскрытия у раунда фиксируется ЯВНО — активной на момент
  // открытия. Без этого `round_projection` брал бы `schema_version` (1), и тест
  // молча зависел бы от того, что лежит в первой версии конфигурации: после
  // пересоздания базы это уже другая конфигурация, и проверка падала бы не по
  // делу. Публикация новой версии ниже переводит открытый раунд на неё — так
  // же, как действие владельца «Применить новые условия» (M086).
  await c.query(
    `INSERT INTO lab.funding_rounds
       (id, project_id, application_version_id, schema_version, disclosure_version, status,
        funding_scope, funding_scope_note, target, currency, service_country, policy_version,
        opened_at, created_by)
     VALUES ($1, $2, $3, 1,
             (SELECT version FROM lab.application_form_versions WHERE is_active LIMIT 1),
             'open', 'direction', 'пилот в рознице', 3000000, 'RUB', 'ru', 1, now(), $4)`,
    [uuidv7(), projectId, versionId, by],
  );
}

interface View {
  raising: string;
  target: string | null;
  currency: string | null;
  funding_scope: string | null;
  funding_scope_note: string | null;
}

async function view(c: Client, projectId: string): Promise<View | null> {
  const { rows } = await c.query<View>(`SELECT * FROM lab.round_view($1)`, [projectId]);
  return rows[0] ?? null;
}

describe('lab.visible_to — паритет с visibleTo() контрактов', () => {
  it('поле видно аудитории, если видимость не строже; мусор — false', async () => {
    await inRollbackTx(async (c) => {
      const levels = Object.keys(EXPECTED);
      for (const visibility of levels) {
        for (const audience of levels) {
          const { rows } = await c.query<{ ok: boolean }>(`SELECT lab.visible_to($1, $2) AS ok`, [
            visibility,
            audience,
          ]);
          expect(rows[0]!.ok, `${visibility} → ${audience}`).toBe(
            EXPECTED[visibility]!.includes(audience),
          );
        }
      }
      const { rows } = await c.query<{ a: boolean; b: boolean }>(
        `SELECT lab.visible_to('public', 'nobody') AS a, lab.visible_to('secret', 'private') AS b`,
      );
      expect(rows[0]).toEqual({ a: false, b: false });
    });
  });
});

describe('lab.round_view — настройка поля и доступ к объекту', () => {
  it('стартовое investors: аноним — undisclosed без суммы; инвестор с членством — сумма', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, investor.id);
      const projectId = await createProject(c, owner.id, { listed: true });
      await insertOpenRound(c, projectId, owner.id);
      await publishConfig(c, {
        investment_ask: 'investors',
        funding_scope: 'investors',
        funding_scope_note: 'investors',
      });

      await actAs(c, { userId: null, roles: [], dbRole: 'app_public_read' });
      expect(await view(c, projectId)).toEqual({
        raising: 'undisclosed',
        target: null,
        currency: null,
        funding_scope: null,
        funding_scope_note: null,
      });
      const catalog = await c.query<{ raising: string; round_target: string | null }>(
        `SELECT raising, round_target FROM lab.v_public_catalog WHERE id = $1`,
        [projectId],
      );
      expect(catalog.rows[0]).toEqual({ raising: 'undisclosed', round_target: null });
      await resetRole(c);

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const asInvestor = await view(c, projectId);
      expect(asInvestor?.raising).toBe('open');
      expect(asInvestor?.target).toBe('3000000.00');
      expect(asInvestor?.currency).toBe('RUB');
      expect(asInvestor?.funding_scope).toBe('direction');
      expect(asInvestor?.funding_scope_note).toBe('пилот в рознице');
      await resetRole(c);
    });
  });

  it('публикация версии с public открывает группу анониму; без вопроса — private', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, investor.id);
      const projectId = await createProject(c, owner.id, { listed: true });
      await insertOpenRound(c, projectId, owner.id);

      await publishConfig(c, {
        investment_ask: 'public',
        funding_scope: 'public',
        funding_scope_note: 'investors',
      });
      await actAs(c, { userId: null, roles: [], dbRole: 'app_public_read' });
      const anon = await view(c, projectId);
      expect(anon?.raising).toBe('open');
      expect(anon?.target).toBe('3000000.00');
      expect(anon?.funding_scope).toBe('direction');
      // Пояснение — только вместе с предметом и по своей видимости.
      expect(anon?.funding_scope_note).toBeNull();
      await resetRole(c);

      // Нет вопроса в активной конфигурации — private: закрыто и инвестору.
      await publishConfig(c, null);
      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      expect((await view(c, projectId))?.raising).toBe('undisclosed');
      await resetRole(c);
    });
  });

  it('разрешённая аудитория поля не расширяет доступ к неопубликованному проекту', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      await createInvestorSubscription(c, investor.id);
      const projectId = await createProject(c, owner.id, { listed: false });
      await insertOpenRound(c, projectId, owner.id);
      await publishConfig(c, {
        investment_ask: 'public',
        funding_scope: 'public',
        funding_scope_note: 'public',
      });

      await actAs(c, { userId: null, roles: [], dbRole: 'app_public_read' });
      expect(await view(c, projectId)).toBeNull();
      await resetRole(c);
      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      expect(await view(c, projectId)).toBeNull();
      await resetRole(c);

      // Владелец видит всё независимо от настройки и листинга.
      await publishConfig(c, null);
      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });
      const mine = await view(c, projectId);
      expect(mine?.raising).toBe('open');
      expect(mine?.target).toBe('3000000.00');
      await resetRole(c);
    });
  });

  it('инвестор без членства — аудитория public; round_view_as — только своим', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const stranger = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const projectId = await createProject(c, owner.id, { listed: true });
      await insertOpenRound(c, projectId, owner.id);
      await publishConfig(c, {
        investment_ask: 'investors',
        funding_scope: 'investors',
        funding_scope_note: 'investors',
      });

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      expect((await view(c, projectId))?.raising).toBe('undisclosed');
      await resetRole(c);

      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });
      const asPublic = await c.query<View>(`SELECT * FROM lab.round_view_as($1, 'public')`, [
        projectId,
      ]);
      expect(asPublic.rows[0]?.raising).toBe('undisclosed');
      const asInvestors = await c.query<View>(`SELECT * FROM lab.round_view_as($1, 'investors')`, [
        projectId,
      ]);
      expect(asInvestors.rows[0]?.raising).toBe('open');
      const asPrivate = await c.query<View>(`SELECT * FROM lab.round_view_as($1, 'private')`, [
        projectId,
      ]);
      expect(asPrivate.rows).toHaveLength(0);
      await resetRole(c);

      await actAs(c, { userId: stranger.id, roles: ['founder'], dbRole: 'app_backend' });
      const foreign = await c.query<View>(`SELECT * FROM lab.round_view_as($1, 'investors')`, [
        projectId,
      ]);
      expect(foreign.rows).toHaveLength(0);
      await resetRole(c);
    });
  });
});
