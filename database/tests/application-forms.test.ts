/**
 * Версии конфигурации вопросов заявки (M073/M074, план 0.2 §0в).
 *
 * Проверяется то, что обещает решение владельца: черновик один и никогда не
 * активен; активная опубликованная одна; опубликованный документ неизменяем
 * (меняется только активность — откат); опубликованные версии читает любой
 * вошедший, черновик и запись — только администратор; заявка, созданная на
 * версии N, остаётся на ней после активации другой версии.
 *
 * Все проверки доступа — под настоящей ролью app_backend через SET ROLE.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers.ts';
import {
  actAs,
  closePool,
  createProject,
  createUser,
  expectError,
  getPool,
  inRollbackTx,
  uuidv7,
} from './helpers.ts';

afterAll(async () => {
  await closePool();
});

/** Минимальный документ: структуру проверяет код (контракты), БД хранит JSONB. */
const config = (marker: string) =>
  JSON.stringify({
    locales: ['ru-RU'],
    defaultLocale: 'ru-RU',
    sections: [],
    questions: [],
    marker,
  });

/** Следующий свободный номер: тестовая БД может быть засеяна версией 1. */
async function nextVersion(c: Client): Promise<number> {
  const { rows } = await c.query<{ next: string }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM lab.application_form_versions`,
  );
  return Number(rows[0]!.next);
}

async function publish(
  c: Client,
  opts: { version: number; active: boolean; marker?: string },
): Promise<string> {
  const id = uuidv7();
  await c.query(
    `INSERT INTO lab.application_form_versions
       (id, version, status, is_active, config_jsonb, reason, published_at, activated_at)
     VALUES ($1, $2, 'published', $3, $4::jsonb, 'тест', now(), CASE WHEN $3 THEN now() END)`,
    [id, opts.version, opts.active, config(opts.marker ?? `v${opts.version}`)],
  );
  return id;
}

async function deactivateAll(c: Client): Promise<void> {
  await c.query(`UPDATE lab.application_form_versions SET is_active = false WHERE is_active`);
}

/**
 * Ожидаемая ошибка внутри транзакции теста: без точки сохранения Postgres
 * отвергает все последующие команды до конца транзакции.
 */
async function failing(c: Client, fn: () => Promise<unknown>): Promise<Error> {
  await c.query('SAVEPOINT expected_failure');
  const error = await expectError(fn);
  await c.query('ROLLBACK TO SAVEPOINT expected_failure');
  return error;
}

describe('M073: инварианты версий', () => {
  it('черновик один и без номера; опубликованная — с номером, датой и основанием', async () => {
    await inRollbackTx(async (c) => {
      await actAs(c, { roles: ['admin'] });
      await c.query(
        `INSERT INTO lab.application_form_versions (id, status, config_jsonb)
         VALUES ($1, 'draft', $2::jsonb)`,
        [uuidv7(), config('draft')],
      );
      const second = await failing(c, () =>
        c.query(
          `INSERT INTO lab.application_form_versions (id, status, config_jsonb)
           VALUES ($1, 'draft', $2::jsonb)`,
          [uuidv7(), config('draft-2')],
        ),
      );
      expect(second.message).toMatch(/one_draft/);

      const numberedDraft = await failing(c, () =>
        c.query(
          `INSERT INTO lab.application_form_versions (id, version, status, config_jsonb)
           VALUES ($1, 999, 'draft', $2::jsonb)`,
          [uuidv7(), config('x')],
        ),
      );
      expect(numberedDraft.message).toMatch(/draft_unnumbered|one_draft/);

      const unnumbered = await failing(c, () =>
        c.query(
          `INSERT INTO lab.application_form_versions (id, status, config_jsonb, reason, published_at)
           VALUES ($1, 'published', $2::jsonb, 'тест', now())`,
          [uuidv7(), config('x')],
        ),
      );
      expect(unnumbered.message).toMatch(/published_complete/);
    });
  });

  it('активная опубликованная — ровно одна', async () => {
    await inRollbackTx(async (c) => {
      await actAs(c, { roles: ['admin'] });
      await deactivateAll(c);
      const n = await nextVersion(c);
      await publish(c, { version: n, active: true });
      const error = await expectError(() => publish(c, { version: n + 1, active: true }));
      expect(error.message).toMatch(/one_active/);
    });
  });

  it('опубликованный документ неизменяем, активность — нет (откат)', async () => {
    await inRollbackTx(async (c) => {
      await actAs(c, { roles: ['admin'] });
      await deactivateAll(c);
      const n = await nextVersion(c);
      const first = await publish(c, { version: n, active: true });
      const second = await publish(c, { version: n + 1, active: false });

      const edit = await failing(c, () =>
        c.query(`UPDATE lab.application_form_versions SET config_jsonb = $2::jsonb WHERE id = $1`, [
          first,
          config('изменено'),
        ]),
      );
      expect(edit.message).toMatch(/immutable/);

      // Откат = активация другой версии: сначала гасим, потом включаем.
      await c.query(`UPDATE lab.application_form_versions SET is_active = false WHERE id = $1`, [
        first,
      ]);
      await c.query(
        `UPDATE lab.application_form_versions SET is_active = true, activated_at = now(), reason = 'откат'
          WHERE id = $1`,
        [second],
      );
      const { rows } = await c.query<{ version: number }>(
        `SELECT version FROM lab.application_form_versions WHERE is_active`,
      );
      expect(rows.map((r) => r.version)).toEqual([n + 1]);
    });
  });

  it('заявка, созданная на версии N, остаётся на ней после активации другой', async () => {
    await inRollbackTx(async (c) => {
      await actAs(c, { roles: ['admin'] });
      await deactivateAll(c);
      const n = await nextVersion(c);
      await publish(c, { version: n, active: true });

      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      const applicationId = uuidv7();
      await actAs(c, { userId: founder.id, roles: ['founder'] });
      await c.query(
        `INSERT INTO lab.investment_applications
           (id, project_id, status, stage, schema_version, created_by)
         VALUES ($1, $2, 'draft', 'idea',
                 (SELECT version FROM lab.application_form_versions WHERE is_active), $3)`,
        [applicationId, project, founder.id],
      );

      await actAs(c, { roles: ['admin'] });
      await deactivateAll(c);
      await publish(c, { version: n + 1, active: true });

      const { rows } = await c.query<{ schema_version: number }>(
        `SELECT schema_version FROM lab.investment_applications WHERE id = $1`,
        [applicationId],
      );
      expect(rows[0]!.schema_version).toBe(n);
    });
  });
});

describe('RLS: версии конфигурации', () => {
  it('основатель читает опубликованные версии, черновик не видит и писать не может', async () => {
    await inRollbackTx(async (c) => {
      await actAs(c, { roles: ['admin'] });
      await deactivateAll(c);
      const n = await nextVersion(c);
      await publish(c, { version: n, active: true });
      await c.query(
        `INSERT INTO lab.application_form_versions (id, status, config_jsonb)
         VALUES ($1, 'draft', $2::jsonb)`,
        [uuidv7(), config('draft')],
      );

      const founder = await createUser(c);
      await actAs(c, { userId: founder.id, roles: ['founder'], dbRole: 'app_backend' });
      const visible = await c.query<{ status: string }>(
        `SELECT status FROM lab.application_form_versions`,
      );
      expect(visible.rows.every((r) => r.status === 'published')).toBe(true);
      expect(visible.rows.length).toBeGreaterThan(0);

      const error = await expectError(() =>
        c.query(
          `INSERT INTO lab.application_form_versions (id, version, status, config_jsonb, reason, published_at)
           VALUES ($1, 998, 'published', $2::jsonb, 'попытка основателя', now())`,
          [uuidv7(), config('x')],
        ),
      );
      expect(error.message).toMatch(/row-level security|policy/i);
    });
  });

  it('администратор видит черновик и может активировать версию', async () => {
    await inRollbackTx(async (c) => {
      await actAs(c, { roles: ['admin'] });
      await deactivateAll(c);
      const n = await nextVersion(c);
      const id = await publish(c, { version: n, active: false });
      await c.query(
        `INSERT INTO lab.application_form_versions (id, status, config_jsonb)
         VALUES ($1, 'draft', $2::jsonb)`,
        [uuidv7(), config('draft')],
      );

      const admin = await createUser(c, { role: 'admin' });
      await actAs(c, { userId: admin.id, roles: ['admin'], dbRole: 'app_backend' });
      const drafts = await c.query(
        `SELECT id FROM lab.application_form_versions WHERE status = 'draft'`,
      );
      expect(drafts.rows).toHaveLength(1);
      await c.query(
        `UPDATE lab.application_form_versions SET is_active = true, activated_at = now() WHERE id = $1`,
        [id],
      );
      const active = await c.query<{ version: number }>(
        `SELECT version FROM lab.application_form_versions WHERE is_active`,
      );
      expect(active.rows[0]!.version).toBe(n);
    });
  });

  it('DELETE не выдан ни одной роли', async () => {
    const { rows } = await getPool().query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'lab' AND table_name = 'application_form_versions'
          AND grantee = 'app_backend'`,
    );
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });
});
