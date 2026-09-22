#!/usr/bin/env node
/**
 * Проверка уборки брошенных загрузок (остаток SEC-14).
 *
 * Билет на загрузку выдаётся вместе со строкой материала, но загрузка может не
 * состояться. С M037 такой материал наружу не выдаётся — но и не исчезает:
 * строка остаётся навсегда, а объект, если его успели положить, не принадлежит
 * уже ничему и не удаляется никогда.
 *
 * Прогон проверяет фактом:
 *   1. брошенный билет с РЕАЛЬНО загруженным объектом убирается — и строка,
 *      и объект в хранилище;
 *   2. свежий билет (загрузка ещё может идти) не трогается;
 *   3. подтверждённый материал не трогается — ни строка, ни объект;
 *   4. роль обслуживания не может прочитать ни проекты, ни пользователей.
 *
 * Уборку выполняет само ядро при старте, поэтому прогон поднимает отдельный
 * экземпляр — так проверяется настоящий путь, а не повторение его SQL.
 *
 * Запуск: node scripts/probe-abandoned-uploads.mjs (нужны core, PostgreSQL, MinIO)
 */
import pg from 'pg';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Молчаливая смерть прогона неотличима от «ничего не проверено»: в глобальном
// аудите этот скрипт однажды упал, не напечатав ни строки причины. Любая
// необработанная ошибка обязана назвать себя.
process.on('unhandledRejection', (reason) => {
  console.error('ПРОГОН ОБОРВАН (unhandledRejection):', reason);
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  console.error('ПРОГОН ОБОРВАН (uncaughtException):', error);
  process.exit(1);
});

loadDotEnv();

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
}

const BASE = process.env.CORE_URL ?? CORE_URL;
const JANITOR_PORT = Number(process.env.CORE_JANITOR_PORT ?? 4304);
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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

function makeClient() {
  const state = { session: null, csrf: null };
  return {
    async call(path, { method = 'GET', body } = {}) {
      const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method !== 'GET' && state.csrf) {
        headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
      }
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const pair = cookie.split(';')[0];
        if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
        if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
      }
      const json = await response.json().catch(() => null);
      return { status: response.status, json };
    },
  };
}

/** Проверка наличия объекта тем же кодом, которым его кладёт и убирает ядро. */
const { S3Service } = await import(
  new URL('../apps/core/dist/storage/s3.service.js', import.meta.url).href
);
const s3 = new S3Service();

/** Загрузка объекта по подписанной форме — как это делает браузер. */
async function uploadByTicket(ticket, bytes) {
  const form = new FormData();
  for (const [key, value] of Object.entries(ticket.formFields)) form.append(key, value);
  form.append('file', new Blob([bytes], { type: ticket.formFields['Content-Type'] }), 'deck.pdf');
  const response = await fetch(ticket.uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  return response.status;
}

function startJanitorInstance() {
  const entry = join(ROOT, 'apps', 'core', 'dist', 'main.js');
  const env = { ...process.env, CORE_PORT: String(JANITOR_PORT) };
  const child = spawn(process.execPath, [entry], { env, stdio: 'ignore', windowsHide: true });
  // Смерть поднятого экземпляра обязана быть заметной. Без этого прогон ждёт
  // здоровья порта — и может получить его от ЧУЖОГО процесса, который занял тот
  // же порт: проверка станет зелёной, ничего не проверив.
  child.on('error', (error) => {
    console.error(`ЭКЗЕМПЛЯР ОБСЛУЖИВАНИЯ НЕ ЗАПУСТИЛСЯ: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (!child.killedByProbe) {
      console.error(
        `ЭКЗЕМПЛЯР ОБСЛУЖИВАНИЯ ЗАВЕРШИЛСЯ САМ: code=${code ?? '—'} signal=${signal ?? '—'} ` +
          `(порт ${JANITOR_PORT} мог быть занят другим процессом)`,
      );
      process.exit(1);
    }
  });
  return child;
}

async function waitHealthy(port, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return true;
    } catch {
      /* ещё не поднялся */
    }
  }
  return false;
}

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

console.warn('\n=== ПРОВЕРКА УБОРКИ БРОШЕННЫХ ЗАГРУЗОК ===\n');

const suffix = `${Date.now() % 1e9}`;
const email = `abandoned-${suffix}@test.local`;
const password = `Pw-${randomUUID()}`;
const client = makeClient();

await client.call('/v1/auth/register', {
  method: 'POST',
  body: {
    email,
    password,
    displayName: 'Брошенные загрузки',
    role: 'founder',
    locale: 'ru-RU',
    consents: CONSENTS,
  },
});
const [user] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
  blindIndex(email),
]);

const taxonomy = await fetch(`${BASE}/v1/taxonomy`, { signal: AbortSignal.timeout(10_000) })
  .then((r) => r.json())
  .then((b) => b.items?.[0]?.id ?? null);

const created = await client.call('/v1/projects', {
  method: 'POST',
  body: {
    title: `Проект уборки ${suffix}`,
    stage: 'mvp',
    taxonomyId: taxonomy,
    investmentAsk: '1000000.00',
    askCurrency: 'RUB',
  },
});
const projectId = created.json?.id;
check('проект создан', created.status === 201 && Boolean(projectId), `HTTP ${created.status}`);

const payload = Buffer.from(`%PDF-1.4 проверка уборки ${suffix}`, 'utf8');

async function ticket(index) {
  const r = await client.call(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    body: {
      type: 'deck',
      fileName: `deck-${index}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: payload.length,
    },
  });
  return r.json;
}

// 1. Брошенный билет с РЕАЛЬНО загруженным объектом.
const abandoned = await ticket(1);
check('билет выдан', Boolean(abandoned?.materialId));
const uploadStatus = await uploadByTicket(abandoned, payload);
check(
  'объект положен в хранилище',
  uploadStatus === 204 || uploadStatus === 200,
  `HTTP ${uploadStatus}`,
);
const [abandonedRow] = await sql('SELECT s3_key FROM lab.project_materials WHERE id = $1', [
  abandoned.materialId,
]);
check(
  'объект действительно существует до уборки',
  (await s3.headObject(abandonedRow.s3_key)).exists,
);

// 2. Подтверждённый материал — контроль: уборка не должна его тронуть.
const confirmed = await ticket(2);
await uploadByTicket(confirmed, payload);
const finalize = await client.call(
  `/v1/projects/${projectId}/materials/${confirmed.materialId}/finalize`,
  { method: 'POST' },
);
check(
  'материал подтверждён',
  finalize.status === 200 || finalize.status === 201,
  `HTTP ${finalize.status}`,
);

// 2а. Отпечаток — настоящий sha256 содержимого, а не ETag хранилища (Ф35,
// SEC-HIGH-03): сверяется с хешем, посчитанным здесь от того же payload.
{
  const expectedHash = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
  const [row] = await sql('SELECT content_hash FROM lab.project_materials WHERE id = $1', [
    confirmed.materialId,
  ]);
  check(
    'content_hash — sha256 фактических байтов',
    row?.content_hash === expectedHash,
    `${row?.content_hash?.slice(0, 24)}…`,
  );
}

// 2б. Содержимое, не соответствующее типу материала, подтверждение отвергает
// (Ф35, SEC-HIGH-02): заявлен PDF, положен HTML — magic bytes не совпадают.
{
  const fake = await ticket(9);
  await uploadByTicket(fake, Buffer.from('<html>не презентация</html>', 'utf8'));
  const rejected = await client.call(
    `/v1/projects/${projectId}/materials/${fake.materialId}/finalize`,
    { method: 'POST' },
  );
  check(
    'подделка формата отвергнута подтверждением',
    rejected.status === 409,
    `HTTP ${rejected.status}`,
  );
  const [fakeRow] = await sql(
    'SELECT count(*)::int AS n FROM lab.project_materials WHERE id = $1 AND uploaded_at IS NOT NULL',
    [fake.materialId],
  );
  check('подделка не стала подтверждённым материалом', fakeRow.n === 0);
}

// 3. Свежий брошенный билет — уборка не должна его тронуть: загрузка может идти.
const fresh = await ticket(3);
check('свежий билет выдан', Boolean(fresh?.materialId));

// Состаривание: уборка смотрит на возраст записи, а не на её содержимое.
await sql(
  `UPDATE lab.project_materials SET created_at = now() - interval '48 hours'
    WHERE id IN ($1, $2)`,
  [abandoned.materialId, confirmed.materialId],
);

// Уборку выполняет ядро при старте — поднимаем отдельный экземпляр.
const janitor = startJanitorInstance();
check('экземпляр обслуживания поднялся', await waitHealthy(JANITOR_PORT));
// Уборка идёт при старте до готовности слушателя, но объект удаляется внешним
// вызовом: даём проходу договорить.
await new Promise((resolve) => setTimeout(resolve, 3000));

const [abandonedAfter] = await sql(
  'SELECT count(*)::int AS n FROM lab.project_materials WHERE id = $1',
  [abandoned.materialId],
);
check('строка брошенного билета убрана', abandonedAfter.n === 0, `строк: ${abandonedAfter.n}`);
check(
  'объект брошенного билета удалён из хранилища',
  !(await s3.headObject(abandonedRow.s3_key)).exists,
);

const [confirmedAfter] = await sql(
  'SELECT count(*)::int AS n FROM lab.project_materials WHERE id = $1 AND uploaded_at IS NOT NULL',
  [confirmed.materialId],
);
check('подтверждённый материал не тронут', confirmedAfter.n === 1);
const [confirmedRow] = await sql('SELECT s3_key FROM lab.project_materials WHERE id = $1', [
  confirmed.materialId,
]);
check(
  'объект подтверждённого материала на месте',
  (await s3.headObject(confirmedRow.s3_key)).exists,
);

const [freshAfter] = await sql(
  'SELECT count(*)::int AS n FROM lab.project_materials WHERE id = $1',
  [fresh.materialId],
);
check('свежий билет не тронут', freshAfter.n === 1, `строк: ${freshAfter.n}`);

// 4. Границы роли обслуживания: она знает только о мусоре, который убирает.
const maintenance = new pg.Pool({
  connectionString: process.env.DATABASE_URL_APP_MAINTENANCE,
  max: 1,
});
const mc = await maintenance.connect();
try {
  await mc.query('BEGIN');
  await mc.query('SET LOCAL ROLE app_maintenance');
  let deniedProjects = false;
  let deniedUsers = false;
  try {
    await mc.query('SELECT count(*) FROM lab.projects');
  } catch {
    deniedProjects = true;
  }
  await mc.query('ROLLBACK');
  await mc.query('BEGIN');
  await mc.query('SET LOCAL ROLE app_maintenance');
  try {
    await mc.query('SELECT count(*) FROM identity.users');
  } catch {
    deniedUsers = true;
  }
  await mc.query('ROLLBACK');
  check('роль обслуживания не читает проекты', deniedProjects);
  check('роль обслуживания не читает пользователей', deniedUsers);
} finally {
  mc.release();
  await maintenance.end();
}

janitor.killedByProbe = true;
janitor.kill();

// Уборка за собой: прогон не оставляет ни проект, ни материалы, ни объекты.
const leftovers = await sql('SELECT s3_key FROM lab.project_materials WHERE project_id = $1', [
  projectId,
]);
for (const row of leftovers) {
  if (row.s3_key) await s3.deleteObject(row.s3_key).catch(() => undefined);
}
await sql('DELETE FROM lab.project_materials WHERE project_id = $1', [projectId]);
/*
 * Заявка заводится ВМЕСТЕ с проектом, и ссылки идут в обе стороны:
 * investment_applications.project_id → projects, projects.current_application_id
 * → investment_applications. Удалить одно, не развязав другое, нельзя —
 * отсюда падение уборки. Сначала снимается ссылка на текущую заявку, потом
 * удаляются заявки, потом проект.
 */
await sql('UPDATE lab.projects SET current_application_id = NULL WHERE id = $1', [projectId]);
await sql('DELETE FROM lab.investment_applications WHERE project_id = $1', [projectId]);
await sql('DELETE FROM lab.founders_projects WHERE project_id = $1', [projectId]);
await sql('DELETE FROM lab.projects WHERE id = $1', [projectId]);
await sql('DELETE FROM identity.user_roles WHERE user_id = $1', [user.id]);
await pool.end();

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
