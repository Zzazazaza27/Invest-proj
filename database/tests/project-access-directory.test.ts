import { afterAll, describe, expect, it } from 'vitest';
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
 * M091 (5.8.1): справочные функции выдачи разрешений.
 *
 * Проверяется не «функция существует», а то, ради чего она заведена:
 *
 *  - адрес превращается в получателя только при ТОЧНОМ совпадении слепого
 *    индекса и только для вошедшего: перебора и анонимного опроса нет;
 *  - неактивная и удалённая запись отвечают так же, как несуществующая;
 *  - список выданного отдаёт имена получателей команде проекта и админу, а
 *    постороннему — ничего, даже если он инвестор;
 *  - у получателя одна ДЕЙСТВУЮЩАЯ запись на проект: повтор запрещён
 *    индексом, а после отзыва выдать снова можно.
 */

afterAll(async () => {
  await closePool();
});

const emailIndex = "digest($1, 'sha256')";

async function resolve(
  client: Parameters<typeof actAs>[0],
  email: string,
): Promise<{ user_id: string; display_name: string } | undefined> {
  const { rows } = await client.query<{ user_id: string; display_name: string }>(
    `SELECT user_id, display_name FROM lab.resolve_grantee(${emailIndex})`,
    [email],
  );
  return rows[0];
}

describe('M091: адрес → получатель', () => {
  it('находит активного пользователя по точному адресу и отдаёт только имя', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });

      const found = await resolve(c, investor.email);
      expect(found?.user_id).toBe(investor.id);
      expect(found?.display_name).not.toBe('');

      // Чужой адрес с опечаткой — не «похожий», а ничего.
      expect(await resolve(c, `x${investor.email}`)).toBeUndefined();
      await resetRole(c);
    });
  });

  it('анониму не отвечает, неактивная и удалённая запись — как несуществующая', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const pending = await createUser(c, { role: 'investor', activate: false });
      const deleted = await createUser(c, { role: 'investor' });
      await c.query(`UPDATE identity.users SET deleted_at = now() WHERE id = $1`, [deleted.id]);

      await actAs(c, { userId: null, roles: [], dbRole: 'app_backend' });
      expect(await resolve(c, owner.email)).toBeUndefined();

      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });
      expect(await resolve(c, pending.email)).toBeUndefined();
      expect(await resolve(c, deleted.email)).toBeUndefined();
      await resetRole(c);
    });
  });
});

describe('M091: список выданного', () => {
  it('команда и админ видят записи с именами, посторонний — ничего', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const investor = await createUser(c, { role: 'investor' });
      const stranger = await createUser(c, { role: 'investor' });
      const admin = await createUser(c, { role: 'admin' });

      await c.query(
        `INSERT INTO lab.project_access_grants
           (id, project_id, grantee_user_id, permissions, granted_by)
         VALUES ($1, $2, $3, ARRAY['materials','round'], $4)`,
        [uuidv7(), projectId, investor.id, owner.id],
      );
      await c.query(
        `INSERT INTO lab.project_access_exclusions
           (id, project_id, excluded_user_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [uuidv7(), projectId, stranger.id, owner.id],
      );

      const entries = async (userId: string, roles: string[]) => {
        await actAs(c, { userId, roles, dbRole: 'app_backend' });
        const { rows } = await c.query<{
          kind: string;
          subject_id: string;
          subject_name: string;
          permissions: string[] | null;
        }>(
          `SELECT kind, subject_id, subject_name, permissions FROM lab.project_access_entries($1)`,
          [projectId],
        );
        return rows;
      };

      const byOwner = await entries(owner.id, ['founder']);
      expect(byOwner).toHaveLength(2);
      const grantRow = byOwner.find((r) => r.kind === 'grant');
      expect(grantRow?.subject_id).toBe(investor.id);
      expect(grantRow?.subject_name).not.toBe('');
      expect([...(grantRow?.permissions ?? [])].sort()).toEqual(['materials', 'round']);
      const exclusionRow = byOwner.find((r) => r.kind === 'exclusion');
      expect(exclusionRow?.subject_id).toBe(stranger.id);
      expect(exclusionRow?.permissions).toBeNull();

      expect(await entries(admin.id, ['admin'])).toHaveLength(2);
      // Посторонний не узнаёт ни имён, ни самого факта выдачи.
      expect(await entries(stranger.id, ['investor'])).toHaveLength(0);
      expect(await entries(investor.id, ['investor'])).toHaveLength(0);
      await resetRole(c);
    });
  });
});

describe('M091: одна действующая запись на получателя', () => {
  it('вторая действующая выдача тому же человеку отклоняется, после отзыва — можно снова', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id, { listed: true });
      const investor = await createUser(c, { role: 'investor' });

      const insertGrant = () =>
        c.query(
          `INSERT INTO lab.project_access_grants
             (id, project_id, grantee_user_id, permissions, granted_by)
           VALUES ($1, $2, $3, ARRAY['profile'], $4)`,
          [uuidv7(), projectId, investor.id, owner.id],
        );

      await insertGrant();
      // Ожидаемый отказ — под SAVEPOINT: нарушение индекса обрывает всю
      // транзакцию теста, и следующий запрос уже не выполнился бы.
      await c.query('SAVEPOINT duplicate_grant');
      await expect(insertGrant()).rejects.toThrow();
      await c.query('ROLLBACK TO SAVEPOINT duplicate_grant');

      await c.query(
        `UPDATE lab.project_access_grants SET revoked_at = now()
          WHERE project_id = $1 AND grantee_user_id = $2`,
        [projectId, investor.id],
      );
      await expect(insertGrant()).resolves.toBeDefined();
    });
  });
});
