#!/usr/bin/env node
/**
 * Повтор как целевое состояние и событие только при изменении (блок 2, 2.6; пакет 8).
 *
 *   node scripts/probe-target-state.mjs
 *
 * Настоящая БД стенда. Для каждой операции: повтор с тем же содержимым — успешный ответ и
 * НИ ОДНОГО нового события; изменение — событие есть; «уже выполнено» не отменяет прав —
 * чужой или недоступный объект не превращается в успех; отсутствующее поле частичного
 * обновления значения не очищает.
 */
import pg from 'pg';
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
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;
const n = async (text, params) => (await sql(text, params))[0].n;
const stamp = Date.now() % 1e9;
const ok = (r) => r.status >= 200 && r.status < 300;

function makeClient() {
  const state = { session: null, csrf: null };
  return {
    async call(path, { method = 'GET', body } = {}) {
      const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method !== 'GET' && state.csrf) {
        headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
      }
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
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
        // пусто
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
  const email = `ts8-${label}-${stamp}@test.local`;
  const password = `Pw-${randomUUID()}`;
  let client = makeClient();
  await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `TS8 ${label}`,
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
  return { client, userId: u.id, email };
}
const events = (verb, subject) =>
  n(`SELECT count(*)::int AS n FROM audit.events WHERE verb = $1 AND subject_id = $2`, [
    verb,
    subject,
  ]);
const outbox = (type, aggregate) =>
  n(
    `SELECT count(*)::int AS n FROM audit.outbox_events WHERE event_type = $1 AND aggregate_id = $2`,
    [type, aggregate],
  );

console.warn('\n=== ЦЕЛЕВОЕ СОСТОЯНИЕ И СОБЫТИЕ ПРИ ИЗМЕНЕНИИ (2.6, пакет 8) ===\n');
const cleanup = {
  project: null,
  entity: null,
  block: null,
  landing: null,
  template: `probe.ts8.t${stamp}`,
  country: null,
};
try {
  const F = await register('f');
  const G = await register('g');
  const H = await register('h');
  const A = await register('a', true);

  console.warn('[1] Роли');
  const g1 = await A.client.call(`/v1/admin/users/${H.userId}/roles`, {
    method: 'POST',
    body: { role: 'investor' },
  });
  const g2 = await A.client.call(`/v1/admin/users/${H.userId}/roles`, {
    method: 'POST',
    body: { role: 'investor' },
  });
  check(
    'выдача роли повтором — успех, роли те же',
    ok(g1) && ok(g2) && JSON.stringify(g1.json) === JSON.stringify(g2.json),
    `${g1.status},${g2.status}`,
  );
  check('одно событие выдачи', (await outbox('identity.role.granted', H.userId)) === 1);
  const r1 = await A.client.call(`/v1/admin/users/${H.userId}/roles/investor`, {
    method: 'DELETE',
  });
  const r2 = await A.client.call(`/v1/admin/users/${H.userId}/roles/investor`, {
    method: 'DELETE',
  });
  check('снятие роли повтором — успех', ok(r1) && ok(r2), `${r1.status},${r2.status}`);
  check('одно событие снятия', (await outbox('identity.role.revoked', H.userId)) === 1);
  const rf = await F.client.call(`/v1/admin/users/${H.userId}/roles/investor`, {
    method: 'DELETE',
  });
  check(
    'без права администратора «уже снято» не становится успехом',
    rf.status === 403,
    `HTTP ${rf.status}`,
  );

  console.warn('[2] Полномочие');
  const c1 = await A.client.call('/v1/admin/capabilities/revoke', {
    method: 'POST',
    body: { userId: H.userId, capability: 'ops.availability.update', reason: 'проба повтора' },
  });
  check(
    'снятие невыданного полномочия — успех без события',
    ok(c1) && (await events('identity.capability.revoked', H.userId)) === 0,
    `HTTP ${c1.status}`,
  );
  const cBad = await A.client.call('/v1/admin/capabilities/revoke', {
    method: 'POST',
    body: { userId: randomUUID(), capability: 'ops.availability.update', reason: 'проба повтора' },
  });
  check('несуществующий пользователь — не успех', cBad.status === 404, `HTTP ${cBad.status}`);

  console.warn('[3] Устройство');
  const dev = await F.client.call('/v1/notifications/devices', {
    method: 'POST',
    body: { platform: 'web_pwa', pushProvider: 'web_push', pushToken: `probe-token-${stamp}-xxxx` },
  });
  const devId = dev.json?.id;
  const d1 = await F.client.call(`/v1/notifications/devices/${devId}`, { method: 'DELETE' });
  const d2 = await F.client.call(`/v1/notifications/devices/${devId}`, { method: 'DELETE' });
  check('отзыв своего устройства повтором — успех', ok(d1) && ok(d2), `${d1.status},${d2.status}`);
  const dG = await G.client.call(`/v1/notifications/devices/${devId}`, { method: 'DELETE' });
  check('чужое устройство — «нет такого»', dG.status === 404, `HTTP ${dG.status}`);

  console.warn('[4] Проект: снятие с публикации, видимость, правка');
  const tax = await (await fetch(`${BASE}/v1/taxonomy`)).json();
  const p = await F.client.call('/v1/projects', {
    method: 'POST',
    body: {
      title: `TS8 ${stamp}`,
      stage: 'mvp',
      taxonomyId: (tax.items ?? tax)[0].id,
      investmentAsk: '1000000.00',
      askCurrency: 'RUB',
    },
  });
  cleanup.project = p.json?.id;
  const u1 = await F.client.call(`/v1/projects/${cleanup.project}/listing`, { method: 'DELETE' });
  const u2 = await F.client.call(`/v1/projects/${cleanup.project}/visibility`, {
    method: 'PUT',
    body: { visibility: 'private' },
  });
  check(
    'снятие не опубликованного проекта и «приватно» повтором — успех',
    ok(u1) && ok(u2),
    `${u1.status},${u2.status}`,
  );
  check(
    'без событий видимости',
    (await events('lab.project.visibility_changed', cleanup.project)) === 0,
  );
  const uG = await G.client.call(`/v1/projects/${cleanup.project}/listing`, { method: 'DELETE' });
  check('чужой проект — «нет такого»', uG.status === 404, `HTTP ${uG.status}`);
  const e1 = await F.client.call(`/v1/projects/${cleanup.project}`, {
    method: 'PATCH',
    body: { tagline: 'слоган пробы' },
  });
  const e2 = await F.client.call(`/v1/projects/${cleanup.project}`, {
    method: 'PATCH',
    body: { tagline: 'слоган пробы' },
  });
  check(
    'правка повтором — успех, одно событие',
    ok(e1) && ok(e2) && (await events('lab.project.updated', cleanup.project)) === 1,
  );
  const e3 = await F.client.call(`/v1/projects/${cleanup.project}`, {
    method: 'PATCH',
    body: { title: `TS8 ${stamp}` },
  });
  check(
    'отсутствующее поле не очищено, то же название — без события',
    ok(e3) &&
      e3.json?.tagline === 'слоган пробы' &&
      (await events('lab.project.updated', cleanup.project)) === 1,
    e3.json?.tagline,
  );
  const eG = await G.client.call(`/v1/projects/${cleanup.project}`, {
    method: 'PATCH',
    body: { tagline: 'слоган пробы' },
  });
  check('правка чужого проекта «без изменений» — не успех', eG.status === 404, `HTTP ${eG.status}`);

  console.warn('[5] Доступ к проекту');
  const a1 = await F.client.call(`/v1/projects/${cleanup.project}/access/grants`, {
    method: 'POST',
    body: { email: G.email, permissions: ['profile'] },
  });
  const a2 = await F.client.call(`/v1/projects/${cleanup.project}/access/grants`, {
    method: 'POST',
    body: { email: G.email, permissions: ['profile'] },
  });
  check(
    'выдача повтором — та же запись и срок выдачи',
    ok(a1) && ok(a2) && a1.json?.id === a2.json?.id && a1.json?.createdAt === a2.json?.createdAt,
    `${a1.json?.createdAt} / ${a2.json?.createdAt}`,
  );
  check('одно событие выдачи', (await events('lab.project_access.granted', cleanup.project)) === 1);
  await F.client.call(`/v1/projects/${cleanup.project}/access/grants`, {
    method: 'POST',
    body: { email: G.email, permissions: ['profile', 'materials'] },
  });
  check(
    'другой набор — изменение и событие',
    (await events('lab.project_access.granted', cleanup.project)) === 2,
  );
  const x1 = await F.client.call(`/v1/projects/${cleanup.project}/access/exclusions`, {
    method: 'POST',
    body: { email: H.email, reason: ' проба ' },
  });
  const x2 = await F.client.call(`/v1/projects/${cleanup.project}/access/exclusions`, {
    method: 'POST',
    body: { email: H.email, reason: 'проба' },
  });
  check(
    'исключение повтором (основание после нормализации то же) — одно событие',
    ok(x1) && ok(x2) && (await events('lab.project_access.excluded', cleanup.project)) === 1,
  );

  console.warn('[6] Юрлицо и участник');
  const inn = String(2_000_000_000 + (stamp % 7_999_999_999)).slice(0, 10);
  const body = {
    legalName: `ООО Цель ${stamp}`,
    inn,
    ogrn: `1${String(stamp).padStart(12, '7')}`.slice(0, 13),
    jurisdiction: 'RU',
  };
  const en1 = await F.client.call('/v1/kyc/entities', { method: 'POST', body });
  const en2 = await F.client.call('/v1/kyc/entities', { method: 'POST', body });
  cleanup.entity = en1.json?.id;
  check(
    'создание юрлица повтором — то же юрлицо, одно событие',
    ok(en1) &&
      ok(en2) &&
      en1.json?.id === en2.json?.id &&
      (await events('kyc.entity.created', cleanup.entity)) === 1,
    `${en1.status},${en2.status}`,
  );
  const enG = await G.client.call('/v1/kyc/entities', { method: 'POST', body });
  check(
    'тот же ИНН другим пользователем — прежний отказ',
    enG.status === 409,
    `HTTP ${enG.status}`,
  );
  const m1 = await F.client.call(`/v1/kyc/entities/${cleanup.entity}/members`, {
    method: 'POST',
    body: { userId: G.userId, memberRole: 'beneficial_owner', sharePct: '10' },
  });
  const m2 = await F.client.call(`/v1/kyc/entities/${cleanup.entity}/members`, {
    method: 'POST',
    body: { userId: G.userId, memberRole: 'beneficial_owner', sharePct: '10' },
  });
  check(
    'участник повтором — одно событие',
    ok(m1) && ok(m2) && (await events('kyc.entity.member_added', cleanup.entity)) === 1,
    `${m1.status},${m2.status}`,
  );
  const m3 = await F.client.call(`/v1/kyc/entities/${cleanup.entity}/members`, {
    method: 'POST',
    body: { userId: G.userId, memberRole: 'beneficial_owner', sharePct: '20' },
  });
  check(
    'другая доля у владельца — явный отказ, без события',
    m3.status === 409 && (await events('kyc.entity.member_added', cleanup.entity)) === 1,
    `HTTP ${m3.status}`,
  );
  const m4 = await A.client.call(`/v1/kyc/entities/${cleanup.entity}/members`, {
    method: 'POST',
    body: { userId: G.userId, memberRole: 'beneficial_owner', sharePct: '20' },
  });
  check(
    'другая доля у администратора — изменение и событие',
    ok(m4) && (await events('kyc.entity.member_added', cleanup.entity)) === 2,
    `HTTP ${m4.status}`,
  );
  const [share] = await sql(
    `SELECT share_pct::text AS s FROM kyc.entity_members WHERE entity_id = $1 AND user_id = $2`,
    [cleanup.entity, G.userId],
  );
  check('доля сохранена новая', Number(share?.s) === 20, share?.s);
  const m5 = await G.client.call(`/v1/kyc/entities/${cleanup.entity}/members`, {
    method: 'POST',
    body: { userId: G.userId, memberRole: 'beneficial_owner', sharePct: '20' },
  });
  check('не владелец — не успех', m5.status === 403 || m5.status === 404, `HTTP ${m5.status}`);

  console.warn('[7] Витрина, страны, шаблон, профиль');
  const [was] = await sql(
    `SELECT title, body, link_url FROM content.landing_blocks WHERE key = 'hero_subtitle' AND locale = 'ru-RU' AND valid_to IS NULL`,
  );
  cleanup.landing = was ?? null;
  const pub = await A.client.call('/v1/admin/content/landing', {
    method: 'POST',
    body: {
      key: 'hero_subtitle',
      locale: 'ru-RU',
      body: `Цель ${stamp}`,
      reason: 'проба пакета 8',
    },
  });
  cleanup.block = pub.json?.id;
  const w1 = await A.client.call(`/v1/admin/content/landing/${cleanup.block}/withdraw`, {
    method: 'POST',
    body: { reason: 'проба пакета 8' },
  });
  const w2 = await A.client.call(`/v1/admin/content/landing/${cleanup.block}/withdraw`, {
    method: 'POST',
    body: { reason: 'проба пакета 8' },
  });
  check(
    'снятие блока повтором — успех, одно событие',
    ok(w1) && ok(w2) && (await events('content.landing_block.withdrawn', cleanup.block)) === 1,
    `${w1.status},${w2.status}`,
  );
  const wBad = await A.client.call(`/v1/admin/content/landing/${randomUUID()}/withdraw`, {
    method: 'POST',
    body: { reason: 'проба пакета 8' },
  });
  check('несуществующий блок — «нет такого»', wBad.status === 404, `HTTP ${wBad.status}`);
  const countryEvents = () =>
    n(
      `SELECT count(*)::int AS n FROM audit.events WHERE verb = 'billing.service_country.updated' AND actor_id = $1`,
      [A.userId],
    );
  const ru = await A.client.call('/v1/admin/service-countries', {
    method: 'POST',
    body: { code: 'ru' },
  });
  check(
    'создание заведённой страны — она же, без события',
    ok(ru) && ru.json?.code === 'ru' && (await countryEvents()) === 0,
    `HTTP ${ru.status}`,
  );
  const [ruRow] = await sql(
    `SELECT is_active, sort_order FROM billing.service_countries WHERE code = 'ru'`,
  );
  cleanup.country = ruRow;
  const cu = await A.client.call('/v1/admin/service-countries/ru', {
    method: 'PATCH',
    body: { isActive: ruRow.is_active, sortOrder: ruRow.sort_order },
  });
  check(
    'правка страны теми же значениями — без события',
    ok(cu) && (await countryEvents()) === 0,
    `HTTP ${cu.status}`,
  );
  const t = await A.client.call('/v1/admin/notification-templates', {
    method: 'POST',
    body: {
      code: cleanup.template,
      channel: 'email',
      locale: 'ru-RU',
      bodyTemplate: 'Проба',
      fallbackChain: [],
      isCritical: false,
    },
  });
  const td1 = await A.client.call(`/v1/admin/notification-templates/${t.json?.id}`, {
    method: 'DELETE',
  });
  const td2 = await A.client.call(`/v1/admin/notification-templates/${t.json?.id}`, {
    method: 'DELETE',
  });
  check(
    'выключение шаблона повтором — одно событие выключения (плюс создание)',
    ok(td1) &&
      ok(td2) &&
      (await n(
        `SELECT count(*)::int AS n FROM audit.events WHERE verb = 'comms.template.updated' AND subject_id = $1`,
        [t.json?.id],
      )) === 2,
    `${td1.status},${td2.status}`,
  );
  const pr1 = await F.client.call('/v1/me/profile', {
    method: 'PATCH',
    body: { displayName: 'TS8 имя' },
  });
  const pr2 = await F.client.call('/v1/me/profile', {
    method: 'PATCH',
    body: { displayName: 'TS8 имя' },
  });
  check(
    'то же имя профиля повтором — одно событие',
    ok(pr1) && ok(pr2) && (await events('identity.user.profile_updated', F.userId)) === 1,
    `${pr1.status},${pr2.status}`,
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
        users[3] ?? users[0],
      ],
    ).catch(() => undefined);
  }
  if (cleanup.country)
    await sql(
      `UPDATE billing.service_countries SET is_active = $1, sort_order = $2 WHERE code = 'ru'`,
      [cleanup.country.is_active, cleanup.country.sort_order],
    ).catch(() => undefined);
  await sql(`DELETE FROM comms.notification_templates WHERE code = $1`, [cleanup.template]).catch(
    () => undefined,
  );
  if (cleanup.entity) {
    await sql(`DELETE FROM kyc.entity_members WHERE entity_id = $1`, [cleanup.entity]).catch(
      () => undefined,
    );
    await sql(`DELETE FROM kyc.business_entities WHERE id = $1`, [cleanup.entity]).catch(
      () => undefined,
    );
  }
  if (cleanup.project) {
    await sql('DELETE FROM lab.project_access_grants WHERE project_id = $1', [
      cleanup.project,
    ]).catch(() => undefined);
    await sql('DELETE FROM lab.project_access_exclusions WHERE project_id = $1', [
      cleanup.project,
    ]).catch(() => undefined);
    await sql('DELETE FROM lab.founders_projects WHERE project_id = $1', [cleanup.project]).catch(
      () => undefined,
    );
    await sql('DELETE FROM lab.projects WHERE id = $1', [cleanup.project]).catch(() => undefined);
  }
  if (users[3])
    await sql(`DELETE FROM identity.user_roles WHERE user_id = $1 AND role = 'admin'`, [
      users[3],
    ]).catch(() => undefined);
  await pool.end();
}
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
