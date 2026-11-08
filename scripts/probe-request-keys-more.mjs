#!/usr/bin/env node
/**
 * Повтор операций пакета 7 раздела 01 (блок 2, 2.6; M164) на настоящей БД стенда.
 *
 *   node scripts/probe-request-keys-more.mjs
 *
 * Для каждой операции — последовательный И одновременный повтор:
 *   1. заявка KYC — одна заявка и одно событие;
 *   2. заявка KYB — одна заявка и одно событие;
 *   3. шаблон уведомления с тем же содержимым — одна версия и одно событие;
 *   4. блок витрины с тем же содержимым — одна версия и одно событие (прежний текст
 *      проба в конце возвращает);
 *   5. создание сервисного аккаунта с ключом — один аккаунт; первый ответ с секретом,
 *      повтор — `already_issued` без секрета; без ключа — прежний ответ с секретом;
 *   6. ротация с ключом — одна ротация (рубеж +1, одно событие), повтор без секрета,
 *      хеш секрета после повтора не меняется;
 *   7. подтверждение медиа с ключом — одна запись, одно событие, одинаковый результат;
 *      повтор прежней загрузки не разбирает файл следующей.
 */
import pg from 'pg';
import sharp from 'sharp';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of existsSync(join(ROOT, '.env'))
  ? readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
  : []) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq > 0) process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
}
const BASE = process.env.CORE_URL ?? CORE_URL;
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  console.warn(`  ${condition ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;
const count = async (text, params) => (await sql(text, params))[0].n;
const stamp = Date.now() % 1e9;
const key = () => `probe-${randomUUID()}`;

function makeClient() {
  const state = { session: null, csrf: null };
  return {
    async call(path, { method = 'GET', body, key: k } = {}) {
      const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (k) headers['Idempotency-Key'] = k;
      if (method !== 'GET' && state.csrf) {
        headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
      }
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      for (const cookie of r.headers.getSetCookie?.() ?? []) {
        const pair = cookie.split(';')[0];
        if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
        if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
      }
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // не JSON
      }
      return { status: r.status, json };
    },
  };
}
const blindIndex = (email) =>
  createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));
const users = [];
async function register(label, admin = false) {
  const email = `rk7-${label}-${stamp}@test.local`;
  const password = `Pw-${randomUUID()}`;
  let client = makeClient();
  await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `RK7 ${label}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  const [u] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [blindIndex(email)]);
  users.push(u.id);
  if (admin) {
    await sql(
      "INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING",
      [u.id],
    );
    client = makeClient();
    await client.call('/v1/auth/login', { method: 'POST', body: { email, password } });
  }
  return { client, userId: u.id };
}
const both = (fn) => Promise.all([fn(), fn()]);

console.warn('\n=== ПОВТОР ОПЕРАЦИЙ ПАКЕТА 7 (2.6) ===\n');
const cleanup = {
  entity: null,
  templateCode: `probe.rk7.t${stamp}`,
  account: [],
  project: null,
  landing: null,
};
try {
  const founder = await register('f');
  const admin = await register('a', true);

  console.warn('[1] Заявка KYC');
  const kycBody = { kind: 'identity', docType: 'passport', docCountry: 'RU' };
  const kyc = await both(() =>
    founder.client.call('/v1/kyc/verifications', { method: 'POST', body: kycBody }),
  );
  const kycAgain = await founder.client.call('/v1/kyc/verifications', {
    method: 'POST',
    body: kycBody,
  });
  check(
    'одновременно и последовательно — та же заявка',
    kyc.every((r) => r.json?.id && r.json.id === kycAgain.json?.id),
    kyc.map((r) => `${r.status}`).join(','),
  );
  check(
    'одна заявка',
    (await count(
      `SELECT count(*)::int AS n FROM kyc.kyc_verifications WHERE user_id = $1 AND kind = 'identity'`,
      [founder.userId],
    )) === 1,
  );
  check(
    'одно событие',
    (await count(
      `SELECT count(*)::int AS n FROM audit.events WHERE verb = 'kyc.verification.submitted' AND actor_id = $1`,
      [founder.userId],
    )) === 1,
  );

  console.warn('[2] Заявка KYB');
  const inn = String(1_000_000_000 + (stamp % 8_999_999_999)).slice(0, 10);
  const entity = await founder.client.call('/v1/kyc/entities', {
    method: 'POST',
    body: {
      legalName: `ООО Проба ${stamp}`,
      inn,
      ogrn: `1${String(stamp).padStart(12, '0')}`.slice(0, 13),
      jurisdiction: 'RU',
    },
  });
  cleanup.entity = entity.json?.id ?? null;
  check(
    'юрлицо создано',
    entity.status === 201 || entity.status === 200,
    `HTTP ${entity.status} ${entity.json?.code ?? ''}`,
  );
  const kyb = await both(() =>
    founder.client.call(`/v1/kyc/entities/${cleanup.entity}/kyb`, {
      method: 'POST',
      body: { kind: 'registry_check' },
    }),
  );
  const kybAgain = await founder.client.call(`/v1/kyc/entities/${cleanup.entity}/kyb`, {
    method: 'POST',
    body: { kind: 'registry_check' },
  });
  check(
    'одновременно и последовательно — та же заявка KYB',
    kyb.every((r) => r.json?.id && r.json.id === kybAgain.json?.id),
    kyb.map((r) => `${r.status}`).join(','),
  );
  check(
    'одна заявка KYB',
    (await count(`SELECT count(*)::int AS n FROM kyc.kyb_verifications WHERE entity_id = $1`, [
      cleanup.entity,
    ])) === 1,
  );
  check(
    'одно событие KYB',
    (await count(
      `SELECT count(*)::int AS n FROM audit.events WHERE verb = 'kyc.kyb.submitted' AND actor_id = $1`,
      [founder.userId],
    )) === 1,
  );

  console.warn('[3] Шаблон уведомления');
  const tpl = {
    code: cleanup.templateCode,
    channel: 'email',
    locale: 'ru-RU',
    bodyTemplate: 'Текст пробы',
    fallbackChain: [],
    isCritical: false,
  };
  const t = await both(() =>
    admin.client.call('/v1/admin/notification-templates', { method: 'POST', body: tpl }),
  );
  const tAgain = await admin.client.call('/v1/admin/notification-templates', {
    method: 'POST',
    body: tpl,
  });
  check(
    'одновременно и последовательно — та же версия',
    t.every((r) => r.json?.id && r.json.id === tAgain.json?.id),
    t.map((r) => `${r.status}`).join(','),
  );
  check(
    'одна версия',
    (await count(`SELECT count(*)::int AS n FROM comms.notification_templates WHERE code = $1`, [
      tpl.code,
    ])) === 1,
  );
  check(
    'одно событие',
    (await count(
      `SELECT count(*)::int AS n FROM audit.events WHERE verb = 'comms.template.updated' AND actor_id = $1`,
      [admin.userId],
    )) === 1,
  );
  const tChanged = await admin.client.call('/v1/admin/notification-templates', {
    method: 'POST',
    body: { ...tpl, bodyTemplate: 'Другой текст' },
  });
  check('другое содержимое — новая версия', tChanged.json?.version === 2);

  console.warn('[4] Блок витрины');
  const [was] = await sql(
    `SELECT title, body, link_url FROM content.landing_blocks WHERE key = 'hero_subtitle' AND locale = 'ru-RU' AND valid_to IS NULL`,
  );
  cleanup.landing = was ?? null;
  const block = {
    key: 'hero_subtitle',
    locale: 'ru-RU',
    body: `Проба повтора ${stamp}`,
    reason: 'проба повтора 2.6',
  };
  const before = await count(
    `SELECT count(*)::int AS n FROM content.landing_blocks WHERE key = 'hero_subtitle'`,
  );
  const l = await both(() =>
    admin.client.call('/v1/admin/content/landing', { method: 'POST', body: block }),
  );
  const lAgain = await admin.client.call('/v1/admin/content/landing', {
    method: 'POST',
    body: block,
  });
  check(
    'одновременно и последовательно — та же версия блока',
    l.every((r) => r.json?.id && r.json.id === lAgain.json?.id),
    l.map((r) => `${r.status}`).join(','),
  );
  check(
    'одна новая версия',
    (await count(
      `SELECT count(*)::int AS n FROM content.landing_blocks WHERE key = 'hero_subtitle'`,
    )) ===
      before + 1,
  );
  check(
    'одно событие',
    (await count(
      `SELECT count(*)::int AS n FROM audit.events WHERE verb = 'content.landing_block.published' AND actor_id = $1`,
      [admin.userId],
    )) === 1,
  );

  console.warn('[5] Создание сервисного аккаунта');
  const sa = {
    name: `probe ${stamp}`,
    clientId: `probe-rk7-${stamp}`,
    scopes: ['webhooks:manage'],
    mtlsCertFingerprint: 'ab'.repeat(32),
  };
  const k5 = key();
  const created = await both(() =>
    admin.client.call('/v1/admin/service-accounts', { method: 'POST', body: sa, key: k5 }),
  );
  const createdAgain = await admin.client.call('/v1/admin/service-accounts', {
    method: 'POST',
    body: sa,
    key: k5,
  });
  const issued = created.filter((r) => r.json?.secretDelivery === 'issued');
  cleanup.account.push(created[0].json?.id);
  check(
    'один аккаунт',
    (await count(
      `SELECT count(*)::int AS n FROM integration.service_accounts WHERE client_id = $1`,
      [sa.clientId],
    )) === 1,
  );
  check(
    'секрет — ровно в одном ответе',
    issued.length === 1 && typeof issued[0].json.clientSecret === 'string',
    created.map((r) => r.json?.secretDelivery).join(','),
  );
  check(
    'повтор — already_issued без секрета',
    createdAgain.json?.secretDelivery === 'already_issued' &&
      createdAgain.json?.clientSecret === null &&
      createdAgain.json?.id === issued[0].json.id,
  );
  const sa2 = { ...sa, clientId: `probe-rk7b-${stamp}` };
  const noKey = await admin.client.call('/v1/admin/service-accounts', {
    method: 'POST',
    body: sa2,
  });
  cleanup.account.push(noKey.json?.id);
  check(
    'без ключа — прежний ответ с секретом',
    noKey.json?.secretDelivery === 'issued' && typeof noKey.json?.clientSecret === 'string',
  );

  console.warn('[6] Ротация секрета');
  const acc = issued[0].json.id;
  const [e0] = await sql(
    `SELECT token_epoch, client_secret_hash FROM integration.service_accounts WHERE id = $1`,
    [acc],
  );
  const k6 = key();
  const rot = await both(() =>
    admin.client.call(`/v1/admin/service-accounts/${acc}/rotation`, { method: 'POST', key: k6 }),
  );
  const [e1] = await sql(
    `SELECT token_epoch, client_secret_hash FROM integration.service_accounts WHERE id = $1`,
    [acc],
  );
  const rotAgain = await admin.client.call(`/v1/admin/service-accounts/${acc}/rotation`, {
    method: 'POST',
    key: k6,
  });
  const [e2] = await sql(
    `SELECT token_epoch, client_secret_hash FROM integration.service_accounts WHERE id = $1`,
    [acc],
  );
  check(
    'одна ротация: рубеж +1',
    Number(e1.token_epoch) === Number(e0.token_epoch) + 1,
    `${e0.token_epoch}→${e1.token_epoch}`,
  );
  check(
    'секрет — ровно в одном ответе ротации',
    rot.filter((r) => r.json?.secretDelivery === 'issued').length === 1,
    rot.map((r) => r.json?.secretDelivery).join(','),
  );
  check(
    'повтор ротации — без секрета, хеш и рубеж не меняются',
    rotAgain.json?.secretDelivery === 'already_issued' &&
      e2.client_secret_hash === e1.client_secret_hash &&
      Number(e2.token_epoch) === Number(e1.token_epoch),
  );
  check(
    'одно событие ротации',
    (await count(
      `SELECT count(*)::int AS n FROM audit.outbox_events WHERE event_type = 'integration.service_account.rotated' AND aggregate_id = $1`,
      [acc],
    )) === 1,
  );
  check(
    'секрета нет в записи ключа',
    (await count(
      `SELECT count(*)::int AS n FROM requests.idempotency_keys WHERE actor_id = $1 AND operation LIKE 'integration.%'`,
      [admin.userId],
    )) === 2,
  );

  console.warn('[7] Подтверждение медиа');
  const tax = await (await fetch(`${BASE}/v1/taxonomy`)).json();
  const project = await founder.client.call('/v1/projects', {
    method: 'POST',
    body: {
      title: `RK7 ${stamp}`,
      stage: 'mvp',
      taxonomyId: (tax.items ?? tax)[0].id,
      investmentAsk: '1000000.00',
      askCurrency: 'RUB',
    },
  });
  cleanup.project = project.json?.id;
  const png = async (w) =>
    sharp({ create: { width: w, height: w, channels: 3, background: { r: 30, g: 90, b: 160 } } })
      .png()
      .toBuffer();
  const upload = async (bytes) => {
    const ticket = await founder.client.call(`/v1/projects/${cleanup.project}/media/upload`, {
      method: 'POST',
      body: { kind: 'logo', contentType: 'image/png', sizeBytes: bytes.length },
    });
    const form = new FormData();
    for (const [k, v] of Object.entries(ticket.json.formFields)) form.append(k, v);
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'logo.png');
    await fetch(ticket.json.uploadUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    return ticket.json.uploadId;
  };
  const finalize = (uploadId) =>
    founder.client.call(`/v1/projects/${cleanup.project}/media/logo/finalize`, {
      method: 'POST',
      body: { uploadId, focusX: 0.5, focusY: 0.5 },
      key: `media-${uploadId}`,
    });
  const u1 = await upload(await png(300));
  const f = await both(() => finalize(u1));
  const fAgain = await finalize(u1);
  check(
    'одновременно — оба успешны, результат один',
    f.every((r) => r.status < 300 && r.json?.updatedAt === f[0].json?.updatedAt),
    f.map((r) => `${r.status}`).join(','),
  );
  check(
    'последовательный повтор — тот же результат',
    fAgain.status < 300 && fAgain.json?.updatedAt === f[0].json?.updatedAt,
  );
  check(
    'одно событие медиа',
    (await count(
      `SELECT count(*)::int AS n FROM audit.events WHERE verb = 'lab.project_media.set' AND subject_id = $1`,
      [cleanup.project],
    )) === 1,
  );
  const u2 = await upload(await png(400));
  const oldRetry = await finalize(u1);
  check(
    'повтор прежней загрузки не разобрал следующую',
    oldRetry.status < 300 && oldRetry.json?.width === 300,
  );
  const f2 = await finalize(u2);
  check(
    'следующая загрузка — своя операция',
    f2.status < 300 && f2.json?.width === 400,
    `HTTP ${f2.status} ${f2.json?.width}`,
  );
} finally {
  if (cleanup.landing) {
    await sql(
      `UPDATE content.landing_blocks SET valid_to = now() WHERE key = 'hero_subtitle' AND locale = 'ru-RU' AND valid_to IS NULL`,
    ).catch(() => undefined);
    await sql(
      `INSERT INTO content.landing_blocks (id, key, locale, title, body, link_url, created_by) VALUES ($1, 'hero_subtitle', 'ru-RU', $2, $3, $4, $5)`,
      [
        randomUUID(),
        cleanup.landing.title,
        cleanup.landing.body,
        cleanup.landing.link_url,
        users[1] ?? users[0],
      ],
    ).catch(() => undefined);
  }
  await sql(`DELETE FROM comms.notification_templates WHERE code = $1`, [
    cleanup.templateCode,
  ]).catch(() => undefined);
  for (const id of cleanup.account.filter(Boolean)) {
    await sql(`DELETE FROM integration.service_accounts WHERE id = $1`, [id]).catch(
      () => undefined,
    );
  }
  if (cleanup.entity) {
    await sql(`DELETE FROM kyc.kyb_verifications WHERE entity_id = $1`, [cleanup.entity]).catch(
      () => undefined,
    );
    await sql(`DELETE FROM kyc.entity_members WHERE entity_id = $1`, [cleanup.entity]).catch(
      () => undefined,
    );
    await sql(`DELETE FROM kyc.business_entities WHERE id = $1`, [cleanup.entity]).catch(
      () => undefined,
    );
  }
  if (users[0])
    await sql(`DELETE FROM kyc.kyc_verifications WHERE user_id = $1`, [users[0]]).catch(
      () => undefined,
    );
  if (cleanup.project) {
    await sql('DELETE FROM lab.project_media WHERE project_id = $1', [cleanup.project]).catch(
      () => undefined,
    );
    await sql('DELETE FROM lab.founders_projects WHERE project_id = $1', [cleanup.project]).catch(
      () => undefined,
    );
    await sql('DELETE FROM lab.projects WHERE id = $1', [cleanup.project]).catch(() => undefined);
  }
  if (users[1])
    await sql(`DELETE FROM identity.user_roles WHERE user_id = $1 AND role = 'admin'`, [
      users[1],
    ]).catch(() => undefined);
  await pool.end();
}
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
