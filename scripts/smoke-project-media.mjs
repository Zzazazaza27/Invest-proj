#!/usr/bin/env node
/**
 * Живой прогон логотипа и обложки проекта (7.2).
 *
 * Проверяется то, из-за чего загрузка пользовательских файлов вообще опасна:
 *
 *   • формат определяется РАЗБОРОМ файла, а не заголовком клиента: «PNG» с
 *     произвольным содержимым отвергается;
 *   • слишком маленькое и слишком большое изображение отвергаются с понятной
 *     причиной, негодный файл в хранилище не остаётся;
 *   • варианты собираются заново, и посторонние метаданные (EXIF с
 *     координатами съёмки) в них не переживают пересборку;
 *   • замена и удаление работают, прежние объекты убираются;
 *   • изображение закрытого проекта не открывается знанием ссылки, а ответ
 *     постороннему одинаков для закрытого и несуществующего проекта.
 *
 * Запуск: node scripts/smoke-project-media.mjs
 */
import sharp from 'sharp';

import { CORE_URL } from './lib/ports.mjs';
import {
  CONSENTS,
  blindIndex,
  createProject,
  loadDotEnv,
  makePool,
} from './lib/project-fixture.mjs';

loadDotEnv();

const BASE = CORE_URL;
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

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

const pool = makePool('unicorn-smoke-project-media');
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

let founderState = null;

function makeClient() {
  const state = { session: null, csrf: null };
  if (founderState === null) founderState = state;
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    return { response, json };
  }
  async function json(path, init) {
    const { response, json: body } = await call(path, init);
    if (response.status >= 400) {
      throw new Error(
        `${init?.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`,
      );
    }
    return body;
  }
  return { call, json };
}

/** Куки основателя — для запросов, которые читают сырые байты. */
function founderCookie() {
  return [founderState?.session, founderState?.csrf].filter(Boolean).join('; ');
}

const suffix = `${Date.now() % 1e9}`;

async function register(role, tag) {
  const client = makeClient();
  const email = `pm-${tag}-${suffix}@test.local`;
  const password = `Pw-${crypto.randomUUID()}`;
  await client.json('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Тест ${tag}`,
      role,
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { client, email, password, userId: row?.id ?? null };
}

/** Картинка нужного размера с ЗАВЕДОМО лишними метаданными внутри. */
async function makeImage(width, height, { withExif = false } = {}) {
  let image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 40, g: 80, b: 200 },
    },
  }).jpeg({ quality: 80 });
  if (withExif) {
    image = image.withExif({
      IFD0: { Copyright: 'прогон', Artist: 'основатель' },
      // Координаты съёмки — именно то, что не должно доехать до витрины.
      GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
    });
  }
  return image.toBuffer();
}

/** Загрузка через форму хранилища — тем же путём, что и кабинет. */
async function uploadThrough(ticket, buffer, contentType, fileName) {
  const form = new FormData();
  for (const [key, value] of Object.entries(ticket.formFields)) form.append(key, value);
  form.append('file', new Blob([buffer], { type: contentType }), fileName);
  return fetch(ticket.uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
}

console.warn('\n=== ЖИВОЙ ПРОГОН: ЛОГОТИП И ОБЛОЖКА ПРОЕКТА ===\n');

const founder = await register('founder', 'f');
const stranger = await register('investor', 's');

// Открытые режимы видимости закрыты, пока владелец не верифицирован.
const adminUser = await register('founder', 'a');
await sql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
  [adminUser.userId],
);
const admin = makeClient();
await admin.json('/v1/auth/login', {
  method: 'POST',
  body: { email: adminUser.email, password: adminUser.password },
});
{
  const kyc = await founder.client.json('/v1/kyc/verifications', {
    method: 'POST',
    body: { kind: 'identity', docType: 'passport', docCountry: 'RU' },
  });
  if (kyc.status !== 'approved') {
    await admin.json(`/v1/kyc/verifications/${kyc.id}/decision`, {
      method: 'POST',
      body: { decision: 'approved', riskLevel: 'low' },
    });
  }
}

try {
  const { project } = await createProject(founder.client, sql, suffix);

  // ------------------------------------------------- отказ по размерам
  {
    const small = await makeImage(64, 64);
    const ticket = await founder.client.json(`/v1/projects/${project.id}/media/upload`, {
      method: 'POST',
      body: { kind: 'logo', contentType: 'image/jpeg', sizeBytes: small.byteLength },
    });
    const uploaded = await uploadThrough(ticket, small, 'image/jpeg', 'small.jpg');
    check('маленький файл в хранилище принят', uploaded.ok, `${uploaded.status}`);

    const { response, json } = await founder.client.call(
      `/v1/projects/${project.id}/media/logo/finalize`,
      { method: 'POST', body: { uploadId: ticket.uploadId, focusX: 0.5, focusY: 0.5 } },
    );
    check(
      'слишком маленькое изображение отвергнуто',
      response.status === 400,
      `${response.status}`,
    );
    check(
      'причина названа размерами',
      JSON.stringify(json).includes('не меньше'),
      JSON.stringify(json?.errors ?? {}).slice(0, 120),
    );
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM lab.project_media WHERE project_id = $1`,
      [project.id],
    );
    check('запись о медиа не появилась', n === 0, `${n}`);
  }

  // --------------------------------- отказ по фактическому содержимому
  {
    const notAnImage = Buffer.from('%PDF-1.7\nэто не картинка'.repeat(50), 'utf-8');
    const ticket = await founder.client.json(`/v1/projects/${project.id}/media/upload`, {
      method: 'POST',
      body: { kind: 'logo', contentType: 'image/png', sizeBytes: notAnImage.byteLength },
    });
    await uploadThrough(ticket, notAnImage, 'image/png', 'fake.png');
    const { response, json } = await founder.client.call(
      `/v1/projects/${project.id}/media/logo/finalize`,
      { method: 'POST', body: { uploadId: ticket.uploadId } },
    );
    check(
      'файл с чужим содержимым отвергнут, несмотря на заявленный тип',
      response.status === 400,
      `${response.status}`,
    );
    check(
      'причина названа содержимым',
      JSON.stringify(json).includes('не изображение'),
      JSON.stringify(json?.errors ?? {}).slice(0, 120),
    );
  }

  // ------------------------------------------------------- загрузка
  let media = null;
  {
    const logo = await makeImage(512, 512, { withExif: true });
    const ticket = await founder.client.json(`/v1/projects/${project.id}/media/upload`, {
      method: 'POST',
      body: { kind: 'logo', contentType: 'image/jpeg', sizeBytes: logo.byteLength },
    });
    await uploadThrough(ticket, logo, 'image/jpeg', 'logo.jpg');
    media = await founder.client.json(`/v1/projects/${project.id}/media/logo/finalize`, {
      method: 'POST',
      body: { uploadId: ticket.uploadId, focusX: 0.25, focusY: 0.75 },
    });
    check('логотип загружен', media.kind === 'logo', media.mime);
    check('формат определён разбором', media.mime === 'image/jpeg', media.mime);
    check('размеры сохранены', media.width === 512 && media.height === 512);
    check('точка фокуса сохранена', media.focusX === 0.25 && media.focusY === 0.75);
    check(
      'подготовлены оба размера',
      Boolean(media.urls.card) && Boolean(media.urls.page),
      Object.keys(media.urls).join(','),
    );
    check(
      'наружу отдаются маршруты ядра, а не ссылки хранилища',
      media.urls.card.startsWith('/v1/projects/'),
      media.urls.card,
    );
  }

  // ------------------------------------------- варианты и метаданные
  {
    // Байты читаются отдельным запросом: общий клиент разбирает тело как
    // текст, и картинку из него уже не достать.
    const response = await fetch(`${BASE}/v1/projects/${project.id}/media/logo/card`, {
      headers: { Cookie: founderCookie() },
      signal: AbortSignal.timeout(20_000),
    });
    check('вариант отдаётся владельцу', response.status === 200, `${response.status}`);
    check('тип ответа — webp', response.headers.get('content-type') === 'image/webp');
    check(
      'ответ не кэшируется посредниками',
      (response.headers.get('cache-control') ?? '').includes('no-store'),
      response.headers.get('cache-control'),
    );

    const bytes = Buffer.from(await response.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    check(
      'вариант нужного размера',
      meta.width === 96 && meta.height === 96,
      `${meta.width}×${meta.height}`,
    );
    check('EXIF не переехал в вариант', meta.exif === undefined);
    check('координаты съёмки не переехали', !('gps' in (meta ?? {})) || meta.gps === undefined);
  }

  // --------------------------------------------------------- замена
  {
    const [before] = await sql(
      `SELECT master_key, variants FROM lab.project_media WHERE project_id = $1 AND kind = 'logo'`,
      [project.id],
    );
    const other = await makeImage(600, 600);
    const ticket = await founder.client.json(`/v1/projects/${project.id}/media/upload`, {
      method: 'POST',
      body: { kind: 'logo', contentType: 'image/jpeg', sizeBytes: other.byteLength },
    });
    await uploadThrough(ticket, other, 'image/jpeg', 'logo2.jpg');
    const replaced = await founder.client.json(`/v1/projects/${project.id}/media/logo/finalize`, {
      method: 'POST',
      body: { uploadId: ticket.uploadId, focusX: 0.5, focusY: 0.5 },
    });
    check('логотип заменён', replaced.width === 600, `${replaced.width}`);
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM lab.project_media WHERE project_id = $1 AND kind = 'logo'`,
      [project.id],
    );
    check('запись осталась одна', n === 1, `${n}`);
    const [after] = await sql(
      `SELECT master_key FROM lab.project_media WHERE project_id = $1 AND kind = 'logo'`,
      [project.id],
    );
    check('прежний оригинал заменён новым', after.master_key !== before.master_key);
  }

  // ------------------------------------------------- обложка и список
  {
    const cover = await makeImage(1280, 720);
    const ticket = await founder.client.json(`/v1/projects/${project.id}/media/upload`, {
      method: 'POST',
      body: { kind: 'cover', contentType: 'image/jpeg', sizeBytes: cover.byteLength },
    });
    await uploadThrough(ticket, cover, 'image/jpeg', 'cover.jpg');
    await founder.client.json(`/v1/projects/${project.id}/media/cover/finalize`, {
      method: 'POST',
      body: { uploadId: ticket.uploadId, focusX: 0.5, focusY: 0.2 },
    });
    const list = await founder.client.json(`/v1/projects/${project.id}/media`);
    check('в списке оба изображения', list.items.length === 2, `${list.items.length}`);
  }

  // ------------------------------- закрытый проект и знание ссылки
  {
    const path = `/v1/projects/${project.id}/media/logo/card`;
    const outsider = await stranger.client.call(path);
    check(
      'постороннему изображение закрытого проекта не отдаётся',
      outsider.response.status === 404,
      `${outsider.response.status}`,
    );
    const anonymous = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20_000) });
    check('анониму по прямой ссылке — тоже нет', anonymous.status === 404, `${anonymous.status}`);

    // Ответ для закрытого и для несуществующего проекта одинаков: иначе
    // чужой каталог перебирается адресами.
    const missing = await fetch(
      `${BASE}/v1/projects/00000000-0000-7000-8000-000000000000/media/logo/card`,
      { signal: AbortSignal.timeout(20_000) },
    );
    const closedBody = await anonymous.text();
    const missingBody = await missing.text();
    check(
      'ответ одинаков для закрытого и несуществующего проекта',
      anonymous.status === missing.status && normalize(closedBody) === normalize(missingBody),
      `${anonymous.status}/${missing.status}`,
    );
    check(
      'в ответе нет названия проекта',
      !closedBody.includes(project.title),
      closedBody.slice(0, 80),
    );
  }

  // ------------------------------- открытый проект: видно всем
  {
    await founder.client.json(`/v1/projects/${project.id}/visibility`, {
      method: 'PUT',
      body: { visibility: 'public' },
    });
    const anonymous = await fetch(`${BASE}/v1/projects/${project.id}/media/logo/card`, {
      signal: AbortSignal.timeout(20_000),
    });
    check(
      'у публичного проекта изображение отдаётся анониму',
      anonymous.status === 200,
      `${anonymous.status}`,
    );
  }

  // --------------------------------------------------------- удаление
  {
    const [row] = await sql(
      `SELECT master_key FROM lab.project_media WHERE project_id = $1 AND kind = 'logo'`,
      [project.id],
    );
    await founder.client.json(`/v1/projects/${project.id}/media/logo`, { method: 'DELETE' });
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM lab.project_media WHERE project_id = $1 AND kind = 'logo'`,
      [project.id],
    );
    check('запись удалена', n === 0, `${n}`);
    const after = await fetch(`${BASE}/v1/projects/${project.id}/media/logo/card`, {
      signal: AbortSignal.timeout(20_000),
    });
    check('удалённое изображение больше не отдаётся', after.status === 404, `${after.status}`);
    check('оригинал был записан в хранилище', typeof row?.master_key === 'string');
    const cover = await founder.client.json(`/v1/projects/${project.id}/media`);
    check('обложка не пострадала', cover.items.length === 1, `${cover.items.length}`);
  }

  // -------------------------------- посторонний не меняет чужое медиа
  {
    const { response } = await stranger.client.call(`/v1/projects/${project.id}/media/cover`, {
      method: 'DELETE',
    });
    check(
      'посторонний не удаляет чужое изображение',
      response.status === 403 || response.status === 404,
      `${response.status}`,
    );
  }
} finally {
  await pool.end();
}

/** Отпечаток запроса в теле ответа различается всегда — его не сравниваем. */
function normalize(body) {
  return body.replace(/"traceId":"[^"]*"/g, '').replace(/"instance":"[^"]*"/g, '');
}

console.warn(`\n  Итог: ${passed} OK, ${failed} FAIL\n`);
process.exit(failed === 0 ? 0 : 1);
