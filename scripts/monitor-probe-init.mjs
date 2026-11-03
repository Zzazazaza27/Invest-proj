#!/usr/bin/env node
/**
 * Служебная учётка мониторинга и контрольный проект (требование 2.5; блок 8,
 * 8.2 «контрольная операция»; 2.1-W08a — замечание Тэнка при приёмке).
 *
 * Что заводится (происхождение `monitoring`, M154 — не люди и не следы
 * прогонов, в обычном списке админки скрыты):
 *  * владелец контрольного проекта — роль founder, войти под ним нельзя
 *    (пароль случайный и нигде не сохраняется);
 *  * учётка мониторинга `monitoring@5espace.invalid` — роль investor, пароль
 *    `CONTROL_PROBE_PASSWORD` из `.env` (секрет; при отсутствии создаётся);
 *  * закрытый проект «Контрольный проект наблюдения», режим «выбранные
 *    инвесторы», не в каталоге;
 *  * один контрольный PDF (`control/app-probe-v1.pdf`), отмечен «для
 *    инвесторов»;
 *  * разрешение учётке мониторинга: profile + materials — и больше ничего.
 *
 * Проверка (`monitor-app-probe.mjs`) читает это ОБЫЧНЫМ входом и обычными
 * маршрутами — через авторизацию, RLS и выданное разрешение. Ожидаемые
 * идентификаторы и SHA-256 — в `MONITOR_STATE_DIR/app-probe-expected.json`
 * (не секрет). Повторный запуск ничего не дублирует.
 *
 *   node scripts/monitor-probe-init.mjs
 */
import argon2 from 'argon2';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { ENV_PATH, ROOT, loadEnv } from './lib/backup.mjs';
import { s3Object } from './lib/s3.mjs';

loadEnv();
const env = process.env;
if (!env.CONTROL_PROBE_PASSWORD) {
  env.CONTROL_PROBE_PASSWORD = randomBytes(24).toString('base64url');
  appendFileSync(ENV_PATH, `\nCONTROL_PROBE_PASSWORD=${env.CONTROL_PROBE_PASSWORD}\n`);
  console.log('пароль учётки мониторинга создан в .env (значение не выводится)');
}

const pool = new pg.Pool({ connectionString: env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;
const ARGON2 = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };
const blindIndex = (email) =>
  createHmac('sha256', Buffer.from(env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
/** Конверт адреса — тот же формат и AAD, что у CryptoService. */
function sealEmail(email) {
  const kek = Buffer.from(env.KEK_PASSPORT_SENSITIVE ?? '', 'base64');
  if (kek.length !== 32) throw new Error('KEK_PASSPORT_SENSITIVE не задан или неверной длины');
  const dek = randomBytes(32);
  const enc = (key, plaintext, aad) => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    c.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([c.update(plaintext), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  };
  const ciphertext = enc(dek, Buffer.from(email, 'utf8'), 'field:email');
  const wrappedDek = enc(kek, dek, 'wrap:passport_sensitive');
  dek.fill(0);
  return { ciphertext, wrappedDek };
}

async function upsertUser(email, displayName, role, password) {
  const hash = await argon2.hash(password, ARGON2);
  const [found] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  let id = found?.id;
  if (id) {
    await sql(`UPDATE identity.users SET password_hash = $2, status = 'active' WHERE id = $1`, [
      id,
      hash,
    ]);
  } else {
    const c = sealEmail(email);
    [{ id }] = await sql(
      `INSERT INTO identity.users
         (id, email_ciphertext, contact_wrapped_dek, email_hmac, password_hash,
          display_name, primary_role, status, locale, origin)
       VALUES (public.uuid_generate_v7(), $1, $2, $3, $4, $5, $6, 'pending_consents', 'ru-RU', 'monitoring')
       RETURNING id`,
      [c.ciphertext, c.wrappedDek, blindIndex(email), hash, displayName, role],
    );
    // Обязательные акцепты — как у любой активной учётки; служебные.
    await sql(
      `INSERT INTO identity.consents (id, user_id, kind, version, locale, request_trace_hash)
       SELECT public.uuid_generate_v7(), $1, t.kind, t.version, t.locale, digest('monitoring-init', 'sha256')
         FROM identity.consent_templates t
        WHERE t.superseded_at IS NULL AND t.locale = 'ru-RU'
          AND t.kind IN ('platform_rules','tos','pdn','commission_terms')`,
      [id],
    );
    await sql(`UPDATE identity.users SET status = 'active' WHERE id = $1`, [id]);
  }
  await sql(
    `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, role],
  );
  return id;
}

/** Небольшой правильный PDF с меткой — материал, который можно показать. */
function controlPdf() {
  const text = `5E monitoring control ${randomBytes(8).toString('hex')}`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R >>',
  ];
  const stream = `BT /F1 10 Tf 10 50 Td (${text}) Tj ET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

try {
  const ownerId = await upsertUser(
    'monitoring-owner@5espace.invalid',
    'Служебная: владелец контрольного проекта',
    'founder',
    randomBytes(32).toString('base64url'), // войти под владельцем нельзя
  );
  const probeId = await upsertUser(
    'monitoring@5espace.invalid',
    'Служебная: мониторинг',
    'investor',
    env.CONTROL_PROBE_PASSWORD,
  );

  const title = 'Контрольный проект наблюдения';
  let [project] = await sql(
    `SELECT id FROM lab.projects WHERE title = $1 AND origin = 'monitoring'`,
    [title],
  );
  if (!project) {
    const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy ORDER BY slug LIMIT 1`);
    [project] = await sql(
      `INSERT INTO lab.projects
         (id, taxonomy_id, title, tagline, description, stage, status, investment_ask, origin, visibility,
          visibility_changed_at)
       VALUES (public.uuid_generate_v7(), $1, $2, 'Служебный объект мониторинга',
               'Служебный проект: проверка разрешённого чтения. Не участвует в каталоге.',
               'idea', 'draft', 1, 'monitoring', 'selected_investors', now())
       RETURNING id`,
      [taxonomy.id, title],
    );
    await sql(`INSERT INTO lab.founders_projects (project_id, user_id) VALUES ($1, $2)`, [
      project.id,
      ownerId,
    ]);
  }

  let [material] = await sql(
    `SELECT id, s3_key, size_bytes FROM lab.project_materials
      WHERE project_id = $1 AND upload_state = 'ready' AND s3_key LIKE 'control/%'`,
    [project.id],
  );
  let sha256;
  if (!material) {
    const body = controlPdf();
    sha256 = createHash('sha256').update(body).digest('hex');
    const key = 'control/app-probe-v1.pdf';
    const bucket = env.S3_BUCKET || 'unicorn-launch';
    // Запись в рабочее хранилище (Garage, D-001) ключом приложения.
    const put = await s3Object(
      {
        endpoint: (env.S3_ENDPOINT || 'http://127.0.0.1:9000').replace(/\/+$/, ''),
        bucket,
        region: env.S3_REGION || 'us-east-1',
        accessKey: env.S3_ACCESS_KEY_ID,
        secretKey: env.S3_SECRET_ACCESS_KEY,
      },
      'PUT',
      key,
      body,
      { 'content-type': 'application/pdf' },
    );
    if (put.status !== 200) throw new Error(`контрольный файл не записан: HTTP ${put.status}`);
    // Хеш содержимого — как у обычной загрузки: по нему сверяет и проверка
    // восстановления комплекта.
    [material] = await sql(
      `INSERT INTO lab.project_materials
         (id, project_id, type, version, s3_key, size_bytes, content_hash, uploaded_at,
          uploaded_by, upload_state, visibility, upload_file_name)
       VALUES (public.uuid_generate_v7(), $1, 'deck', 1, $2, $3, $5, now(), $4, 'ready',
               'investors', 'Контрольный материал.pdf')
       RETURNING id, s3_key, size_bytes`,
      [project.id, key, body.length, ownerId, `sha256:${sha256}`],
    );
    await sql(
      `INSERT INTO audit.control_objects (name, s3_key, size_bytes, sha256)
       VALUES ('app-probe', $1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET s3_key = EXCLUDED.s3_key, size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256`,
      [key, body.length, sha256],
    );
  } else {
    [{ sha256 }] = await sql(`SELECT sha256 FROM audit.control_objects WHERE name = 'app-probe'`);
  }

  const [grant] = await sql(
    `SELECT id FROM lab.project_access_grants
      WHERE project_id = $1 AND grantee_user_id = $2 AND revoked_at IS NULL`,
    [project.id, probeId],
  );
  if (!grant) {
    await sql(
      `INSERT INTO lab.project_access_grants (id, project_id, grantee_user_id, permissions, granted_by, reason)
       VALUES (public.uuid_generate_v7(), $1, $2, ARRAY['profile','materials'], $3,
               'Служебное разрешение мониторинга: только чтение контрольных данных (2.5)')`,
      [project.id, probeId, ownerId],
    );
  }

  const dir = resolve(env.MONITOR_STATE_DIR || join(ROOT, '.local', 'monitor-state'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'app-probe-expected.json'),
    JSON.stringify(
      {
        email: 'monitoring@5espace.invalid',
        projectId: project.id,
        materialId: material.id,
        title,
        sizeBytes: Number(material.size_bytes),
        sha256,
      },
      null,
      2,
    ),
  );
  console.log(`служебная учётка мониторинга и контрольный проект готовы (${project.id})`);
} finally {
  await pool.end();
}
