#!/usr/bin/env node
/**
 * «Мой профиль» — проверка API (этап 6.4).
 *
 * Проверяется то, что нельзя увидеть с экрана и что дороже всего стоит при
 * ошибке:
 *
 *   * смена пароля требует знания текущего и прекращает ВСЕ сессии;
 *   * подтверждённые данные через профиль не переписываются;
 *   * изображение проверяется разбором, а не заголовком клиента;
 *   * аватар не отдаётся анониму и не подменяется чужому.
 *
 * Прогон работает на СВОЁМ временном аккаунте, а не на демонстрационном:
 * смена пароля и загрузка картинок не должны трогать комплект, которым
 * пользуется приёмка. Аккаунт остаётся в базе — уборка учёток отдельная
 * процедура, и молча удалять строки прогон не должен.
 *
 * Запуск: node scripts/check-profile-api.mjs (нужны БД, ядро на :4300, minio)
 */
import pg from 'pg';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const BASE = process.env.CORE_URL ?? CORE_URL;
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  OK    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.warn(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body, csrf = true, raw = false } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    if (raw) {
      const buffer = Buffer.from(await response.arrayBuffer());
      return { status: response.status, buffer, contentType: response.headers.get('content-type') };
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    return { status: response.status, json, text };
  }
  return { call, state };
}

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

try {
  console.warn('\n=== «МОЙ ПРОФИЛЬ»: API ===\n');

  // ------------------------------------------------ временный аккаунт прогона
  const suffix = `${Date.now() % 1e9}`;
  const email = `probe-profile-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const nextPassword = `Pw2-${randomUUID()}`;

  const client = makeClient();
  const registered = await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: 'Проба Профилевна',
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  if (registered.status >= 400) {
    throw new Error(
      `регистрация не удалась: ${registered.status} ${registered.text.slice(0, 200)}`,
    );
  }

  // ------------------------------------------------------------ [1] чтение
  console.warn('[1] Профиль читается');
  const profile = await client.call('/v1/me/profile');
  check('Профиль открывается', profile.status === 200, `HTTP ${profile.status}`);
  check(
    'Контакт показан маской, а не значением',
    typeof profile.json?.emailMasked === 'string' &&
      profile.json.emailMasked.includes('*') &&
      !profile.json.emailMasked.startsWith('probe-profile'),
    String(profile.json?.emailMasked),
  );
  check('Аватара пока нет', profile.json?.avatar === null, String(profile.json?.avatar));
  check(
    'Смена пароля доступна в локальном контуре входа',
    profile.json?.passwordChangeAvailable === true,
    String(profile.json?.passwordChangeAvailable),
  );
  const body = JSON.stringify(profile.json ?? {});
  check(
    'В ответе нет ни хеша пароля, ни ключей',
    !body.includes('password_hash') && !body.includes('wrapped') && !body.includes('hmac'),
    'чисто',
  );
  const userId = profile.json.id;

  // ------------------------------------------------------------- [2] имя
  console.warn('\n[2] Отображаемое имя');
  const renamed = await client.call('/v1/me/profile', {
    method: 'PATCH',
    body: { displayName: 'Проба Обновлённая' },
  });
  check(
    'Имя меняется владельцем',
    renamed.status === 200 && renamed.json?.displayName === 'Проба Обновлённая',
    `HTTP ${renamed.status}`,
  );
  const short = await client.call('/v1/me/profile', {
    method: 'PATCH',
    body: { displayName: 'я' },
  });
  check('Слишком короткое имя отвергается', short.status === 400, `HTTP ${short.status}`);
  const sneaky = await client.call('/v1/me/profile', {
    method: 'PATCH',
    body: { displayName: 'Проба', status: 'active', roles: ['admin'] },
  });
  check(
    'Через профиль нельзя протащить статус и роли',
    sneaky.status === 400,
    `HTTP ${sneaky.status}`,
  );
  const noCsrf = await client.call('/v1/me/profile', {
    method: 'PATCH',
    body: { displayName: 'Без защиты' },
    csrf: false,
  });
  check('Без CSRF-заголовка правка не проходит', noCsrf.status === 403, `HTTP ${noCsrf.status}`);

  // ---------------------------------------------------------- [3] аватар
  console.warn('\n[3] Аватар');
  const tooBig = await client.call('/v1/me/avatar/upload', {
    method: 'POST',
    body: { contentType: 'image/png', sizeBytes: 50 * 1024 * 1024 },
  });
  check(
    'Слишком большой файл отклоняется до загрузки',
    tooBig.status === 400,
    `HTTP ${tooBig.status}`,
  );

  const png = await sharp({
    create: { width: 240, height: 240, channels: 3, background: { r: 90, g: 60, b: 200 } },
  })
    .png()
    .toBuffer();

  const ticket = await client.call('/v1/me/avatar/upload', {
    method: 'POST',
    body: { contentType: 'image/png', sizeBytes: png.byteLength },
  });
  check(
    'Билет на загрузку выдан',
    ticket.status === 201 || ticket.status === 200,
    `HTTP ${ticket.status}`,
  );

  const form = new FormData();
  for (const [key, value] of Object.entries(ticket.json.formFields)) form.append(key, value);
  form.append('file', new Blob([png], { type: 'image/png' }), 'avatar.png');
  const uploaded = await fetch(ticket.json.uploadUrl, { method: 'POST', body: form });
  check('Файл принят хранилищем', uploaded.status < 400, `HTTP ${uploaded.status}`);

  const finalized = await client.call('/v1/me/avatar/finalize', { method: 'POST' });
  check(
    'Аватар собран и виден в профиле',
    finalized.status === 200 &&
      finalized.json?.avatar?.urls?.sm === `/v1/users/${userId}/avatar/sm`,
    `HTTP ${finalized.status}, ${finalized.json?.avatar?.urls?.sm}`,
  );

  const image = await client.call(`/v1/users/${userId}/avatar/sm`, { raw: true });
  check(
    'Байты отдаются пересобранными, в webp',
    image.status === 200 &&
      image.contentType?.includes('image/webp') &&
      image.buffer.byteLength > 0,
    `HTTP ${image.status}, ${image.contentType}, ${image.buffer?.byteLength} Б`,
  );
  const meta = await sharp(image.buffer).metadata();
  check(
    'Размер варианта задан платформой, а не файлом',
    meta.width === 64 && meta.height === 64,
    `${meta.width}×${meta.height}`,
  );

  const anon = await fetch(`${BASE}/v1/users/${userId}/avatar/sm`, {
    signal: AbortSignal.timeout(20_000),
  });
  check('Аноним аватар не получает', anon.status === 401, `HTTP ${anon.status}`);

  // Не изображение под видом картинки: конвейер обязан отказать.
  const fakeTicket = await client.call('/v1/me/avatar/upload', {
    method: 'POST',
    body: { contentType: 'image/png', sizeBytes: 64 },
  });
  const fakeForm = new FormData();
  for (const [key, value] of Object.entries(fakeTicket.json.formFields))
    fakeForm.append(key, value);
  fakeForm.append(
    'file',
    new Blob([Buffer.from('это не картинка, а текст')], { type: 'image/png' }),
    'x.png',
  );
  await fetch(fakeTicket.json.uploadUrl, { method: 'POST', body: fakeForm });
  const fakeFinalize = await client.call('/v1/me/avatar/finalize', { method: 'POST' });
  check(
    'Подделка типа не проходит: формат определяется разбором',
    fakeFinalize.status === 400,
    `HTTP ${fakeFinalize.status}`,
  );
  const stillThere = await client.call(`/v1/users/${userId}/avatar/sm`, { raw: true });
  check(
    'Прежний аватар от неудачной загрузки не пострадал',
    stillThere.status === 200,
    `HTTP ${stillThere.status}`,
  );

  const removed = await client.call('/v1/me/avatar', { method: 'DELETE' });
  check(
    'Аватар удаляется',
    removed.status === 200 && removed.json?.avatar === null,
    `HTTP ${removed.status}`,
  );
  const gone = await client.call(`/v1/users/${userId}/avatar/sm`, { raw: true });
  check('После удаления байтов нет', gone.status === 404, `HTTP ${gone.status}`);

  // --------------------------------------------------------- [4] пароль
  console.warn('\n[4] Смена пароля');
  const wrongCurrent = await client.call('/v1/me/password', {
    method: 'POST',
    body: { currentPassword: 'заведомо-неверный-пароль', newPassword: nextPassword },
  });
  check(
    'Без знания текущего пароля смена не проходит',
    wrongCurrent.status === 400,
    `HTTP ${wrongCurrent.status}`,
  );

  const same = await client.call('/v1/me/password', {
    method: 'POST',
    body: { currentPassword: password, newPassword: password },
  });
  check('Новый пароль не может совпадать с текущим', same.status === 400, `HTTP ${same.status}`);

  const weak = await client.call('/v1/me/password', {
    method: 'POST',
    body: { currentPassword: password, newPassword: 'короткий' },
  });
  check(
    'Слабый пароль отвергается теми же правилами, что при регистрации',
    weak.status === 400,
    `HTTP ${weak.status}`,
  );

  const changed = await client.call('/v1/me/password', {
    method: 'POST',
    body: { currentPassword: password, newPassword: nextPassword },
  });
  check(
    'Пароль меняется и ответ прямо говорит о закрытии сессий',
    changed.status === 200 && changed.json?.sessionsClosed === true,
    `HTTP ${changed.status}`,
  );

  const afterChange = await client.call('/v1/me/profile');
  check('Текущая сессия закрыта сразу', afterChange.status === 401, `HTTP ${afterChange.status}`);

  const oldLogin = makeClient();
  const oldResult = await oldLogin.call('/v1/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  check('Старый пароль больше не подходит', oldResult.status === 401, `HTTP ${oldResult.status}`);

  const newLogin = makeClient();
  const newResult = await newLogin.call('/v1/auth/login', {
    method: 'POST',
    body: { email, password: nextPassword },
  });
  check(
    'Новый пароль работает',
    newResult.status === 200 || newResult.status === 201,
    `HTTP ${newResult.status}`,
  );

  const journal = await pool.query(
    `SELECT verb, context_jsonb::text AS ctx FROM audit.events
      WHERE subject_id = $1 ORDER BY ts DESC LIMIT 10`,
    [userId],
  );
  const verbs = journal.rows.map((row) => row.verb);
  check(
    'Все действия профиля записаны в журнал',
    [
      'identity.password.changed',
      'identity.avatar.set',
      'identity.avatar.removed',
      'identity.user.profile_updated',
    ].every((verb) => verbs.includes(verb)),
    verbs.join(', '),
  );
  check(
    'В журнале нет ни пароля, ни имени',
    journal.rows.every(
      (row) => !row.ctx.includes('Проба') && !row.ctx.includes('Pw-') && !row.ctx.includes('Pw2-'),
    ),
    'чисто',
  );
} catch (error) {
  failed += 1;
  console.error(`\nПрогон прерван: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await pool.end();
}

console.warn('\n--- ИТОГ ---');
console.warn(`  пройдено: ${passed}, дефектов: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
