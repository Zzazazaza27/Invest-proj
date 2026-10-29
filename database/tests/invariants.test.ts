/**
 * Инварианты схемы: то, что БД обязана не дать сломать даже при ошибке в
 * сервисном слое. Каждый тест — про конкретное правило из спецификации.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  actAs,
  closePool,
  createEntity,
  createProject,
  createUser,
  getPool,
  inRollbackTx,
  uuidv7,
} from './helpers.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { MIGRATIONS_DIR } from '../src/env.ts';

afterAll(async () => {
  await closePool();
});

describe('Согласия: append-only и блокирующая активация', () => {
  it('акцепт нельзя изменить', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await expect(
        c.query(`UPDATE identity.consents SET accepted_at = now() WHERE user_id = $1`, [user.id]),
      ).rejects.toThrow(/immutable/i);
    });
  });

  it('акцепт нельзя удалить', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await expect(
        c.query(`DELETE FROM identity.consents WHERE user_id = $1`, [user.id]),
      ).rejects.toThrow(/immutable/i);
    });
  });

  it('аккаунт НЕ активируется без акцепта commission_terms', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { activate: false });
      // Три из четырёх документов — активации быть не должно.
      await c.query(
        `INSERT INTO identity.consents (id, user_id, kind, version, locale, request_trace_hash)
         SELECT public.uuid_generate_v7(), $1, t.kind, t.version, t.locale, digest('test-trace','sha256')
         FROM identity.consent_templates t
         WHERE t.superseded_at IS NULL AND t.locale = 'ru-RU'
           AND t.kind IN ('platform_rules','tos','pdn')`,
        [user.id],
      );
      await expect(
        c.query(`UPDATE identity.users SET status = 'active' WHERE id = $1`, [user.id]),
      ).rejects.toThrow(/commission_terms/);
    });
  });

  it('аккаунт активируется при полном наборе акцептов', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { activate: true });
      const { rows } = await c.query<{ status: string }>(
        `SELECT status FROM identity.users WHERE id = $1`,
        [user.id],
      );
      expect(rows[0]!.status).toBe('active');
    });
  });

  it('has_required_consents отражает фактическое состояние', async () => {
    await inRollbackTx(async (c) => {
      const noConsents = await createUser(c, { activate: false });
      const full = await createUser(c, { activate: true });
      const { rows } = await c.query<{ a: boolean; b: boolean }>(
        `SELECT identity.has_required_consents($1) AS a, identity.has_required_consents($2) AS b`,
        [noConsents.id, full.id],
      );
      expect(rows[0]!.a).toBe(false);
      expect(rows[0]!.b).toBe(true);
    });
  });
});

describe('Журнал событий: append-only и hash-chain', () => {
  it('событие нельзя изменить', async () => {
    await inRollbackTx(async (c) => {
      await c.query(
        `SELECT audit.app_emit_event('lab.project.blocked', NULL, 'admin', 'project', NULL,
                                     '{}'::jsonb, 'trace-inv')`,
      );
      await expect(
        c.query(`UPDATE audit.events SET verb = 'lab.listing.published'`),
      ).rejects.toThrow(/append-only/i);
    });
  });

  // Отдельная транзакция: первая же ошибка переводит текущую в aborted, и
  // следующий запрос упал бы с «current transaction is aborted» — тест был бы
  // зелёным по неверной причине.
  it('событие нельзя удалить', async () => {
    await inRollbackTx(async (c) => {
      await c.query(
        `SELECT audit.app_emit_event('lab.project.blocked', NULL, 'admin', 'project', NULL,
                                     '{}'::jsonb, 'trace-inv-2')`,
      );
      await expect(c.query(`DELETE FROM audit.events`)).rejects.toThrow(/append-only/i);
    });
  });

  // Реестр fail-closed: глагол, которого нет в audit.event_type_registry,
  // роняет транзакцию сервиса целиком. Тесты ядра аудит подменяют, поэтому
  // незарегистрированный глагол доживает до стенда (так упал PUT
  // /v1/admin/ai/credentials, M068). Сверка идёт по исходникам ядра: каждый
  // `verb: '...'` обязан быть зарегистрирован миграцией.
  it('каждый глагол аудита из кода ядра зарегистрирован в реестре', async () => {
    const coreSrc = join(MIGRATIONS_DIR, '..', '..', 'apps', 'core', 'src');
    const inCode = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          for (const m of readFileSync(path, 'utf8').matchAll(/verb:\s*'([a-z_]+\.[a-z_.]+)'/g)) {
            inCode.add(m[1]!);
          }
        }
      }
    };
    walk(coreSrc);
    expect(inCode.size).toBeGreaterThan(10);

    const { rows } = await getPool().query<{ verb: string }>(
      `SELECT verb FROM audit.event_type_registry`,
    );
    const registered = new Set(rows.map((r) => r.verb));
    const missing = [...inCode].filter((v) => !registered.has(v)).sort();
    expect(missing).toEqual([]);
  });

  it('недопустимая роль актора отвергается', async () => {
    await inRollbackTx(async (c) => {
      await expect(
        c.query(
          `SELECT audit.app_emit_event('admin.feature_flag.changed', NULL, 'founder', 'x', NULL,
                                       '{}'::jsonb, 't')`,
        ),
      ).rejects.toThrow(/not allowed/i);
    });
  });

  it('цепочка хешей цела после серии событий', async () => {
    await inRollbackTx(async (c) => {
      for (let i = 0; i < 5; i += 1) {
        await c.query(
          `SELECT audit.app_emit_event('lab.project.updated', NULL, 'system', 'project', NULL,
                                       $1::jsonb, 'chain')`,
          [JSON.stringify({ i })],
        );
      }
      const { rows } = await c.query(`SELECT * FROM audit.verify_event_chain()`);
      expect(rows).toEqual([]);
    });
  });
});

describe('Прочие доменные инварианты', () => {
  it('доли бенефициаров не превышают 100%', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c);
      const second = await createUser(c);
      const entity = await createEntity(c, owner.id);
      await c.query(
        `INSERT INTO kyc.entity_members (entity_id, user_id, member_role, share_pct)
         VALUES ($1, $2, 'beneficial_owner', 60)`,
        [entity, owner.id],
      );
      await expect(
        c.query(
          `INSERT INTO kyc.entity_members (entity_id, user_id, member_role, share_pct)
           VALUES ($1, $2, 'beneficial_owner', 50)`,
          [entity, second.id],
        ),
      ).rejects.toThrow(/exceed 100/i);
    });
  });

  it('вебхук на внутренний адрес отвергается (защита от SSRF)', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const accountId = uuidv7();
      await c.query(
        `INSERT INTO integration.service_accounts
           (id, client_id, name, client_secret_hash, mtls_cert_fingerprint, scopes, created_by)
         VALUES ($1, $2, 'test', 'argon2id$hash', 'fp', ARRAY['webhooks:manage'], $3)`,
        [accountId, `client-${accountId.slice(0, 8)}`, admin.id],
      );
      for (const url of [
        'https://127.0.0.1/hook',
        'https://169.254.169.254/latest/meta-data',
        'https://10.0.0.5/hook',
        'https://metadata.internal/hook',
        'http://example.com/hook',
      ]) {
        await expect(
          c.query(
            `INSERT INTO integration.webhook_endpoints
               (id, service_account_id, url, subscribed_verbs, secret_ciphertext,
                secret_kms_key_id, secret_fingerprint)
             VALUES (public.uuid_generate_v7(), $1, $2, ARRAY['lab.listing.published'],
                     '\\x00'::bytea, 'kms', '\\x00'::bytea)`,
            [accountId, url],
          ),
        ).rejects.toThrow();
      }
    });
  });

  it('скоуп вне allowlist отвергается — в том числе удалённые в 2.1-W05', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      for (const scopes of [
        ['webhooks:manage', 'admin:all'],
        ['deals:read'],
        ['graduates:read'],
        ['seasons:read'],
      ]) {
        await c.query('SAVEPOINT s');
        await expect(
          c.query(
            `INSERT INTO integration.service_accounts
               (id, client_id, name, client_secret_hash, mtls_cert_fingerprint, scopes, created_by)
             VALUES (public.uuid_generate_v7(), 'c-evil', 'evil', 'h', 'fp', $2, $1)`,
            [admin.id, scopes],
          ),
        ).rejects.toThrow();
        await c.query('ROLLBACK TO SAVEPOINT s');
      }
    });
  });

  it('уведомления безопасности нельзя отключить', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await actAs(c, { userId: user.id, roles: ['founder'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO comms.notification_preferences (user_id, channel, topic, enabled)
           VALUES ($1, 'email', 'security', false)`,
          [user.id],
        ),
      ).rejects.toThrow();
    });
  });
});

describe('Комплаенс: барьеры самоодобрения (M013)', () => {
  it('решение по верификации без проверяющего отвергается', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await expect(
        c.query(
          `INSERT INTO kyc.kyc_verifications (id, user_id, kind, status, decided_at)
           VALUES (public.uuid_generate_v7(), $1, 'identity', 'approved', now())`,
          [user.id],
        ),
      ).rejects.toThrow(/проверяющего/);
    });
  });

  it('администратор не может одобрить СВОЮ верификацию', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      await expect(
        c.query(
          `INSERT INTO kyc.kyc_verifications (id, user_id, kind, status, reviewed_by, decided_at)
           VALUES (public.uuid_generate_v7(), $1, 'identity', 'approved', $1, now())`,
          [admin.id],
        ),
      ).rejects.toThrow(/самоодобрение/);
    });
  });

  it('заявка в статусе pending проверяющего не требует', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await c.query(
        `INSERT INTO kyc.kyc_verifications (id, user_id, kind, status)
         VALUES (public.uuid_generate_v7(), $1, 'identity', 'pending')`,
        [user.id],
      );
      const { rows } = await c.query(
        'SELECT status FROM kyc.kyc_verifications WHERE user_id = $1',
        [user.id],
      );
      expect(rows[0]?.status).toBe('pending');
    });
  });

  it('владелец юрлица не может одобрить его проверку', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c);
      const entityId = await createEntity(c, owner.id, { approvedKyb: false });
      await expect(
        c.query(
          `INSERT INTO kyc.kyb_verifications (id, entity_id, kind, status, reviewed_by, decided_at)
           VALUES (public.uuid_generate_v7(), $1, 'registry_check', 'approved', $2, now())`,
          [entityId, owner.id],
        ),
      ).rejects.toThrow(/связан с юрлицом/);
    });
  });
});

describe('Публичный поиск не раскрывает непубличные поля (M013)', () => {
  it('описание проекта в публичный поисковый вектор не попадает', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c);
      const project = await createProject(c, founder.id);
      await c.query(
        `UPDATE lab.projects
            SET title = 'Публичный заголовок', tagline = 'Публичный слоган',
                description = 'Секретнаяметрика выручки'
          WHERE id = $1`,
        [project],
      );

      const { rows } = await c.query<{ public_hit: boolean; private_hit: boolean }>(
        `SELECT public_search_tsv @@ plainto_tsquery('russian', 'секретнаяметрика') AS public_hit,
                search_tsv        @@ plainto_tsquery('russian', 'секретнаяметрика') AS private_hit
           FROM lab.projects WHERE id = $1`,
        [project],
      );
      expect(rows[0]?.private_hit).toBe(true);
      expect(rows[0]?.public_hit).toBe(false);
    });
  });

  it('публичной роли выданы права ровно на allowlist колонок каталога', async () => {
    const { rows } = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'app_public_read' AND table_schema = 'lab' AND table_name = 'projects'
        ORDER BY column_name`,
    );
    const granted = rows.map((r) => r.column_name);
    expect(granted).toContain('public_search_tsv');
    // Описание и свободный teaser_jsonb публичной роли недоступны.
    expect(granted).not.toContain('description');
    expect(granted).not.toContain('teaser_jsonb');
    expect(granted).not.toContain('search_tsv');
  });
});

describe('Тестовая БД соответствует дереву миграций', () => {
  it('в журнале миграций нет пропусков относительно каталога', async () => {
    // Локальная тестовая БД отставала на 14 миграций, и весь набор тестов был
    // зелёным по неверной причине: проверки шли против СТАРОЙ схемы. Один
    // прыжок статуса `draft -> graduated` и число таблиц 61 держались именно
    // на этом. Проверка обязана падать первой, а не оставлять разбираться в
    // странных отказах ниже по списку.
    const applied = await getPool().query<{ id: string }>(
      'SELECT id FROM public.schema_migrations ORDER BY id',
    );
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
    const missing = onDisk.filter((id) => !applied.rows.some((r) => r.id === id));
    expect(
      missing,
      'не применены миграции — прогони NODE_ENV=test npm run migrate -w database',
    ).toEqual([]);
  });
});

/**
 * Ссылки восстановления и подтверждения (M060).
 *
 * Проверяется не «функция вернула id», а свойства, ради которых она устроена
 * именно так: однократность на уровне БД, изоляция целей токена, гашение
 * прежних ссылок и сдвиг рубежа сессий вместе с паролем.
 */
describe('Ссылки восстановления и подтверждения', () => {
  const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest();

  async function issue(c: Client, emailHmac: Buffer, token: string, purpose: string) {
    const { rows } = await c.query<{ user_id: string | null }>(
      'SELECT identity.issue_verification_token($1, $2, $3, $4, $5, NULL) AS user_id',
      [uuidv7(), purpose, emailHmac, sha(token), 1800],
    );
    return rows[0]!.user_id;
  }

  async function emailHmacOf(c: Client, userId: string): Promise<Buffer> {
    const { rows } = await c.query<{ email_hmac: Buffer }>(
      'SELECT email_hmac FROM identity.users WHERE id = $1',
      [userId],
    );
    return rows[0]!.email_hmac;
  }

  it('несуществующий контакт не отличается ошибкой от существующего', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      const known = await issue(c, await emailHmacOf(c, user.id), 't-known', 'password_reset');
      // NULL, а не исключение: разное поведение и есть перечисление
      // пользователей, ради предотвращения которого весь сценарий и построен.
      const unknown = await issue(c, Buffer.alloc(32, 3), 't-unknown', 'password_reset');
      expect(known).toBe(user.id);
      expect(unknown).toBeNull();
    });
  });

  it('ссылка срабатывает ровно один раз', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await issue(c, await emailHmacOf(c, user.id), 't-once', 'password_reset');

      const first = await c.query<{ user_id: string | null }>(
        'SELECT identity.reset_password_with_token($1, $2) AS user_id',
        [sha('t-once'), 'argon2-hash-1'],
      );
      const second = await c.query<{ user_id: string | null }>(
        'SELECT identity.reset_password_with_token($1, $2) AS user_id',
        [sha('t-once'), 'argon2-hash-2'],
      );
      expect(first.rows[0]!.user_id).toBe(user.id);
      expect(second.rows[0]!.user_id).toBeNull();

      const { rows } = await c.query<{ password_hash: string }>(
        'SELECT password_hash FROM identity.users WHERE id = $1',
        [user.id],
      );
      // Второй вызов не должен был перезаписать пароль первым... то есть
      // вторым: сохранился результат ПЕРВОГО срабатывания.
      expect(rows[0]!.password_hash).toBe('argon2-hash-1');
    });
  });

  it('смена пароля сдвигает рубеж сессий', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      const before = await c.query<{ sessions_valid_from: Date }>(
        'SELECT sessions_valid_from FROM identity.users WHERE id = $1',
        [user.id],
      );
      await issue(c, await emailHmacOf(c, user.id), 't-epoch', 'password_reset');
      await c.query('SELECT identity.reset_password_with_token($1, $2)', [
        sha('t-epoch'),
        'argon2-hash',
      ]);
      const after = await c.query<{ sessions_valid_from: Date }>(
        'SELECT sessions_valid_from FROM identity.users WHERE id = $1',
        [user.id],
      );
      // Восстановление доступа, после которого чужая открытая сессия
      // продолжает работать, доступ не восстанавливает.
      expect(after.rows[0]!.sessions_valid_from.getTime()).toBeGreaterThan(
        before.rows[0]!.sessions_valid_from.getTime(),
      );
    });
  });

  it('токен подтверждения почты не годится для смены пароля', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await issue(c, await emailHmacOf(c, user.id), 't-cross', 'email_verify');
      const { rows } = await c.query<{ user_id: string | null }>(
        'SELECT identity.reset_password_with_token($1, $2) AS user_id',
        [sha('t-cross'), 'argon2-hash'],
      );
      // Цель токена — граница, а не подпись в комментарии.
      expect(rows[0]!.user_id).toBeNull();
    });
  });

  it('новая ссылка гасит прежнюю живую', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      const hmac = await emailHmacOf(c, user.id);
      await issue(c, hmac, 't-old', 'password_reset');
      await issue(c, hmac, 't-new', 'password_reset');

      const stale = await c.query<{ user_id: string | null }>(
        'SELECT identity.reset_password_with_token($1, $2) AS user_id',
        [sha('t-old'), 'argon2-hash'],
      );
      const fresh = await c.query<{ user_id: string | null }>(
        'SELECT identity.reset_password_with_token($1, $2) AS user_id',
        [sha('t-new'), 'argon2-hash'],
      );
      // Иначе у человека, чью почту читает посторонний, накапливался бы веер
      // рабочих ссылок, и отозвать их разом было бы нечем.
      expect(stale.rows[0]!.user_id).toBeNull();
      expect(fresh.rows[0]!.user_id).toBe(user.id);
    });
  });

  it('просроченная ссылка не срабатывает', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c);
      await issue(c, await emailHmacOf(c, user.id), 't-expired', 'password_reset');
      // Сдвигается и `created_at`: ограничение `expires_at > created_at`
      // не даёт «просрочить» ссылку, оставив её созданной в будущем — и это
      // правильно, иначе в таблице заводились бы заведомо мёртвые строки.
      await c.query(
        `UPDATE identity.verification_tokens
            SET created_at = now() - interval '2 hours',
                expires_at = now() - interval '1 minute'
          WHERE user_id = $1`,
        [user.id],
      );
      const { rows } = await c.query<{ user_id: string | null }>(
        'SELECT identity.reset_password_with_token($1, $2) AS user_id',
        [sha('t-expired'), 'argon2-hash'],
      );
      expect(rows[0]!.user_id).toBeNull();
    });
  });

  it('роль запросов не видит ни чужих ссылок, ни отпечатка своей', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c);
      const stranger = await createUser(c);
      await issue(c, await emailHmacOf(c, owner.id), 't-visible', 'email_verify');

      await actAs(c, { userId: stranger.id, roles: ['founder'], dbRole: 'app_backend' });
      const foreign = await c.query('SELECT id FROM identity.verification_tokens');
      expect(foreign.rows).toHaveLength(0);

      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });
      const own = await c.query('SELECT id, purpose FROM identity.verification_tokens');
      expect(own.rows).toHaveLength(1);
      // Отпечаток не входит в GRANT: даже владелец строки его не читает —
      // права выданы поколоночно, и `SELECT *` здесь тоже упадёт.
      await expect(
        c.query('SELECT token_sha256 FROM identity.verification_tokens'),
      ).rejects.toThrow();
    });
  });
});
