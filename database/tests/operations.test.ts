import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  actAs,
  closePool,
  createProject,
  createUser,
  inRollbackTx,
  resetRole,
  uuidv7,
} from './helpers';

/**
 * M151 (2.1-W04): отмена загрузки — состояние, а не удаление, и отметки
 * показа итога операции (блок 1, 1.5).
 */

afterAll(async () => {
  await closePool();
});

async function createUpload(
  c: Client,
  projectId: string,
  userId: string,
  state: 'pending' | 'ready' | 'rejected' = 'pending',
  version = 1,
): Promise<string> {
  const id = uuidv7();

  await c.query(
    `INSERT INTO lab.project_materials
       (id, project_id, type, version, s3_key, upload_key, upload_state, upload_state_reason,
        uploaded_by, uploaded_at, size_bytes, upload_expires_at, upload_file_name)
     VALUES ($1, $2, 'deck', $5,
             CASE WHEN $4 = 'ready' THEN $3 END, CASE WHEN $4 = 'ready' THEN NULL ELSE $3 || '/upload' END,
             $4, CASE WHEN $4 = 'rejected' THEN 'формат' END,
             $6, CASE WHEN $4 = 'ready' THEN now() END, CASE WHEN $4 = 'ready' THEN 1024 END,
             now() + interval '1 hour', 'deck.pdf')`,
    [id, projectId, `projects/${projectId}/materials/deck/${id}`, state, version, userId],
  );

  return id;
}

const CANCEL = `UPDATE lab.project_materials
                  SET upload_state = 'cancelled', upload_state_changed_at = now(),
                      cancelled_at = now(), cancelled_by = app.current_user_id(),
                      lease_id = NULL, lease_until = NULL, next_check_at = NULL
                WHERE id = $1 AND uploaded_by = app.current_user_id() AND upload_state = 'pending'`;

describe('M151: отмена загрузки', () => {
  it('автор отменяет идущую загрузку под своим контекстом', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      const upload = await createUpload(c, project, founder.id);
      await actAs(c, { userId: founder.id, roles: ['founder'], dbRole: 'app_backend' });
      const r = await c.query(CANCEL, [upload]);
      expect(r.rowCount).toBe(1);
    });
  });

  it('из «отменено» выхода нет — ни у кого, включая владельца схемы', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      const upload = await createUpload(c, project, founder.id);
      await actAs(c, { userId: founder.id, roles: ['founder'], dbRole: 'app_backend' });
      await c.query(CANCEL, [upload]);
      await resetRole(c);
      await c.query('SAVEPOINT s');
      await expect(
        c.query(
          `UPDATE lab.project_materials
              SET upload_state = 'pending', cancelled_at = NULL, cancelled_by = NULL
            WHERE id = $1`,
          [upload],
        ),
      ).rejects.toThrow(/cancelled upload is final/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      await expect(
        c.query(
          `UPDATE lab.project_materials
              SET upload_state = 'ready', uploaded_at = now(), s3_key = upload_key || '/final',
                  size_bytes = 1, cancelled_at = NULL, cancelled_by = NULL
            WHERE id = $1`,
          [upload],
        ),
      ).rejects.toThrow();
    });
  });

  it('готовую и не принятую загрузку отменить нельзя', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      const ready = await createUpload(c, project, founder.id, 'ready', 1);
      const rejected = await createUpload(c, project, founder.id, 'rejected', 2);
      await resetRole(c);
      for (const id of [ready, rejected]) {
        await c.query('SAVEPOINT s');
        await expect(
          c.query(
            `UPDATE lab.project_materials
                SET upload_state = 'cancelled', cancelled_at = now(), cancelled_by = $2
              WHERE id = $1`,
            [id, founder.id],
          ),
        ).rejects.toThrow();
        await c.query('ROLLBACK TO SAVEPOINT s');
      }
    });
  });

  it('«отменено» без отметки времени и автора не записывается', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      const upload = await createUpload(c, project, founder.id);
      await expect(
        c.query(`UPDATE lab.project_materials SET upload_state = 'cancelled' WHERE id = $1`, [
          upload,
        ]),
      ).rejects.toThrow(/cancelled_iff_marked/);
    });
  });

  it('чужую загрузку участник проекта отменить не может', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c);
      const partner = await createUser(c);
      const project = await createProject(c, owner.id);
      await c.query(
        `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'cofounder')`,
        [project, partner.id],
      );
      const upload = await createUpload(c, project, owner.id);
      await actAs(c, { userId: partner.id, roles: ['founder'], dbRole: 'app_backend' });
      const r = await c.query(CANCEL, [upload]);
      expect(r.rowCount).toBe(0);
    });
  });

  it('роль обслуживания не трогает отменённую загрузку — поздний файл не публикуется', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      const upload = await createUpload(c, project, founder.id);
      await actAs(c, { userId: founder.id, roles: ['founder'], dbRole: 'app_backend' });
      await c.query(CANCEL, [upload]);
      await resetRole(c);
      await actAs(c, { userId: null, roles: [], dbRole: 'app_maintenance' });
      const r = await c.query(
        `UPDATE lab.project_materials
            SET upload_state = 'ready', uploaded_at = now(), s3_key = 'x', size_bytes = 1
          WHERE id = $1`,
        [upload],
      );
      expect(r.rowCount).toBe(0);
    });
  });

  it('отменённая загрузка освобождает место в квоте', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      const upload = await createUpload(c, project, founder.id);
      const before = await c.query<{ total: string; pending: string }>(
        'SELECT total::text, pending::text FROM lab.material_counters($1)',
        [project],
      );
      await actAs(c, { userId: founder.id, roles: ['founder'], dbRole: 'app_backend' });
      await c.query(CANCEL, [upload]);
      await resetRole(c);
      const after = await c.query<{ total: string; pending: string }>(
        'SELECT total::text, pending::text FROM lab.material_counters($1)',
        [project],
      );
      expect([before.rows[0]!.total, before.rows[0]!.pending]).toEqual(['1', '1']);
      expect([after.rows[0]!.total, after.rows[0]!.pending]).toEqual(['0', '0']);
    });
  });
});

describe('M151: отметки показа итога операции', () => {
  it('пользователь отмечает свой показ и видит только свои отметки', async () => {
    await inRollbackTx(async (c) => {
      const a = await createUser(c);
      const b = await createUser(c);
      const op = uuidv7();
      await actAs(c, { userId: a.id, roles: ['founder'], dbRole: 'app_backend' });
      await c.query(
        `INSERT INTO comms.operation_notices (operation_kind, operation_id, user_id)
         VALUES ('material_upload', $1, $2)`,
        [op, a.id],
      );
      await resetRole(c);
      await actAs(c, { userId: b.id, roles: ['founder'], dbRole: 'app_backend' });
      const seen = await c.query('SELECT 1 FROM comms.operation_notices');
      expect(seen.rowCount).toBe(0);
    });
  });

  it('отметку за другого пользователя записать нельзя', async () => {
    await inRollbackTx(async (c) => {
      const a = await createUser(c);
      const b = await createUser(c);
      await actAs(c, { userId: a.id, roles: ['founder'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO comms.operation_notices (operation_kind, operation_id, user_id)
           VALUES ('material_upload', $1, $2)`,
          [uuidv7(), b.id],
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('отметку нельзя снять или изменить', async () => {
    await inRollbackTx(async (c) => {
      const a = await createUser(c);
      const op = uuidv7();
      await actAs(c, { userId: a.id, roles: ['founder'], dbRole: 'app_backend' });
      await c.query(
        `INSERT INTO comms.operation_notices (operation_kind, operation_id, user_id)
         VALUES ('material_upload', $1, $2)`,
        [op, a.id],
      );
      await c.query('SAVEPOINT s');
      await expect(c.query('DELETE FROM comms.operation_notices')).rejects.toThrow(
        /permission denied/,
      );
      await c.query('ROLLBACK TO SAVEPOINT s');
      await expect(c.query('UPDATE comms.operation_notices SET shown_at = now()')).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});
