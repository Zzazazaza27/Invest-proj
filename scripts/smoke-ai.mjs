#!/usr/bin/env node
/**
 * Живой прогон AI-контура.
 *
 * Проверяется то, ради чего контур устроен именно так: оценку считает
 * помеченный не-LLM провайдер внутри РФ, результат воспроизводим, история
 * паспортов не переписывается, а недоступность шлюза оставляет след, а не
 * тишину.
 *
 * Требует запущенных core (4300) и ai-gateway (8100):
 *   node scripts/dev-ai-gateway.mjs --detached
 *   node scripts/dev-core.mjs --detached
 *   node scripts/smoke-ai.mjs
 */
import pg from 'pg';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const BASE = 'http://127.0.0.1:4300';
// Адрес шлюза одной константой — как и у остальных прогонов. Локальный контур
// работает по http на loopback: самоподписанный сертификат здесь потребовал бы
// отключить проверку цепочки, что запрещено везде, включая dev (RULES.md §4).
const GATEWAY = 'http://127.0.0.1:8100';
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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

/**
 * Управление шлюзом для проверки отказа.
 *
 * Сценарий «зависимость недоступна» нельзя проверить, не сделав её
 * недоступной. Останов и повторный запуск выполняются здесь, а не руками, —
 * иначе проверка есть только в отчёте, а воспроизвести её нечем.
 * Только для локального прогона: в CI шлюз поднимается тем же скриптом.
 */
function stopGateway() {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    const line = out
      .split('\n')
      .find((l) => l.includes('127.0.0.1:8100') && l.includes('LISTENING'));
    if (!line) return false;
    const pid = line.trim().split(/\s+/).pop();
    // Аргументы передаются массивом, без оболочки: строка команды с
    // подстановкой — это инъекция, даже когда подставляется вывод netstat.
    execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function startGateway() {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'scripts', 'dev-ai-gateway.mjs'), '--detached'],
    {
      cwd: ROOT,
      stdio: 'ignore',
      detached: true,
    },
  );
  child.unref();
}

async function waitForGateway(attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      // Loopback локального прогона. TLS здесь потребовал бы самоподписанного
      // сертификата и отключения проверки цепочки, что запрещено везде,
      // включая dev (RULES.md §4). Поэтому правило подавлено адресно.
      // nosemgrep
      const r = await fetch(`${GATEWAY}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function raw(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  return { response, json };
}

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const result = await raw(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of result.response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    return result;
  }
  return { call };
}

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));
const suffix = `${Date.now() % 1e9}`;

function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

async function register(role, tag) {
  const client = makeClient();
  const email = `ai-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const { response, json } = await client.call('/v1/auth/register', {
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
  if (response.status >= 400) throw new Error(`регистрация ${tag}: ${JSON.stringify(json)}`);
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { client, email, password, userId: row.id };
}

console.warn('\n=== ЖИВОЙ ПРОГОН: AI-КОНТУР ===\n');

// Шлюз обязан отвечать до начала прогона: иначе все провалы будут об одном.
{
  // Loopback локального прогона — см. пояснение выше.
  // nosemgrep
  const health = await fetch(`${GATEWAY}/healthz`, {
    signal: AbortSignal.timeout(5000),
  }).then((r) => r.json());
  check('шлюз отвечает', health.status === 'ok', `политика ${health.policyVersion}`);
  check('провайдер по умолчанию — локальный', health.defaultProvider === 'local_deterministic');
}

const founder = await register('founder', 'f');
const stranger = await register('founder', 's');
const investor = await register('investor', 'i');

const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech'`);
const [{ id: projectId }] = await sql(
  `INSERT INTO lab.projects (id, taxonomy_id, title, tagline, description, stage,
                             investment_ask, required_plan_id)
   VALUES (public.uuid_generate_v7(), $1, 'Аналитика для B2B SaaS',
           'Единая витрина метрик продукта',
           'Решаем проблему разрозненных метрик. Рынок TAM 12 млрд руб, сегмент растёт. ' ||
           'Конкуренты дороже на 30%, наше отличие — патент на алгоритм агрегации. ' ||
           'Команда: CTO с опытом 10 лет, два инженера. Выручка MRR 450 тыс руб, ' ||
           'retention 92%, LTV/CAC 3.4. Модель — подписка, unit-экономика положительная. ' ||
           'Планируем масштабирование на международный рынок.',
           'growth', 5000000, billing.resolve_founder_plan(5000000))
   RETURNING id`,
  [taxonomy.id],
);
await sql(
  `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
  [projectId, founder.userId],
);
await sql(
  `INSERT INTO lab.project_materials (id, project_id, type, version, url, parse_status, uploaded_by)
   VALUES (public.uuid_generate_v7(), $1, 'product_link', 1, 'https://example.com/product',
           'not_required', $2)`,
  [projectId, founder.userId],
);

// --------------------------------------------------------------- доступ
{
  const anon = await raw(`/v1/projects/${projectId}/passport`);
  check(
    'паспорт закрыт без токена',
    anon.response.status === 401,
    `статус ${anon.response.status}`,
  );
}
{
  const { response, json } = await stranger.client.call(`/v1/projects/${projectId}/analysis`, {
    method: 'POST',
    body: {},
  });
  check(
    'посторонний не запускает анализ чужого проекта',
    response.status === 403 || response.status === 404,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
}

// ------------------------------------------------------------ первый прогон
let firstRun;
{
  const { response, json } = await founder.client.call(`/v1/projects/${projectId}/analysis`, {
    method: 'POST',
    body: {},
  });
  firstRun = json;
  check(
    'владелец запустил анализ',
    response.status === 200 || response.status === 201,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
  check('провайдер — локальный контур', json?.provider === 'local_deterministic', json?.provider);
  check('результат честно помечен не-LLM', json?.isLlm === false, String(json?.isLlm));
  check('версия модели зафиксирована', typeof json?.modelVersion === 'string', json?.modelVersion);
  check('паспорт версии 1', json?.passportVersion === 1, `версия ${json?.passportVersion}`);
  check('IRS посчитан', typeof json?.irs === 'number' && json.irs > 0, `IRS ${json?.irs}`);
  check('дельта первого прогона пуста', json?.irsDelta === null, String(json?.irsDelta));
}
{
  const { json } = await founder.client.call(`/v1/projects/${projectId}/passport`);
  check('в паспорте 9 осей', json?.scores?.length === 9, `осей ${json?.scores?.length}`);
  check(
    'у каждой оси есть объяснение',
    (json?.scores ?? []).every(
      (s) => typeof s.explanation === 'string' && s.explanation.length > 20,
    ),
  );
  check(
    'интервал уверенности накрывает значение',
    (json?.scores ?? []).every((s) => s.confidenceLow <= s.value && s.value <= s.confidenceHigh),
  );
  check('IRS в паспорте есть', typeof json?.irs?.value === 'number', String(json?.irs?.value));
}
{
  const { json } = await founder.client.call(`/v1/projects/${projectId}/readiness`);
  check('карта готовности из 13 измерений', json?.items?.length === 13, `${json?.items?.length}`);
  const low = (json?.items ?? []).filter((i) => i.level === 'low');
  check(
    'нераскрытые разделы получают рекомендацию',
    low.every((i) => i.recommendations.length > 0),
    `низких ${low.length}`,
  );
}
{
  const { json } = await founder.client.call(`/v1/projects/${projectId}/roadmap`);
  check('роадмап сгенерирован', Boolean(json?.id));
  check('роадмап от AI и активен', json?.generatedBy === 'ai' && json?.isActive === true);
  const order = (json?.steps ?? []).map((s) => s.orderIndex);
  check(
    'шаги упорядочены',
    order.length > 0 && order.every((v, i) => i === 0 || order[i - 1] < v),
    `шагов ${order.length}`,
  );
}

// ------------------------------------------------------------ второй прогон
{
  const { json } = await founder.client.call(`/v1/projects/${projectId}/analysis`, {
    method: 'POST',
    body: {},
  });
  check('повторный анализ дал версию 2', json?.passportVersion === 2, `${json?.passportVersion}`);
  check(
    'результат воспроизводим: IRS не изменился',
    json?.irs === firstRun?.irs,
    `${firstRun?.irs} → ${json?.irs}`,
  );
  check('дельта посчитана', json?.irsDelta === 0, String(json?.irsDelta));

  const passports = await sql(
    `SELECT version, superseded_at FROM scoring.investment_passports
      WHERE project_id = $1 ORDER BY version`,
    [projectId],
  );
  check('обе версии паспорта сохранены', passports.length === 2, `версий ${passports.length}`);
  check(
    'действующий паспорт ровно один',
    passports.filter((p) => p.superseded_at === null).length === 1,
  );
  check('прошлая версия помечена устаревшей', passports[0].superseded_at !== null);

  const roadmaps = await sql(
    `SELECT is_active FROM scoring.roadmaps WHERE project_id = $1 AND generated_by = 'ai'`,
    [projectId],
  );
  check(
    'активный роадмап ровно один',
    roadmaps.filter((r) => r.is_active).length === 1,
    `роадмапов ${roadmaps.length}`,
  );
}

// ------------------------------------------------------ видимость инвестору
{
  const { response } = await investor.client.call(`/v1/projects/${projectId}/passport`);
  check(
    'инвестор без подписки паспорт не видит',
    response.status === 404,
    `статус ${response.status}`,
  );
}
{
  await sql(
    `INSERT INTO billing.subscriptions
       (id, user_id, plan_id, price_snapshot, terms_version, status, current_period_end)
     SELECT public.uuid_generate_v7(), $1, sp.id, sp.price, 'v1', 'active', now() + interval '30 days'
       FROM billing.subscription_plans sp WHERE sp.code = 'investor_membership'`,
    [investor.userId],
  );
  const notListed = await investor.client.call(`/v1/projects/${projectId}/passport`);
  check(
    'подписка без листинга доступа не даёт',
    notListed.response.status === 404,
    `статус ${notListed.response.status}`,
  );

  // Публикация листинга требует активной подписки основателя на тариф,
  // разрешённый его запросом инвестиций (инвариант Ф5). Прогон не обходит это
  // правило, а выполняет его: подписка заводится фикстурой.
  await sql(
    `INSERT INTO billing.subscriptions
       (id, user_id, project_id, plan_id, price_snapshot, terms_version, status, current_period_end)
     SELECT public.uuid_generate_v7(), $1, p.id, p.required_plan_id, sp.price, 'v1', 'active',
            now() + interval '30 days'
       FROM lab.projects p JOIN billing.subscription_plans sp ON sp.id = p.required_plan_id
      WHERE p.id = $2`,
    [founder.userId, projectId],
  );
  await sql(`UPDATE lab.projects SET listing_status = 'listed', listed_at = now() WHERE id = $1`, [
    projectId,
  ]);
  const listed = await investor.client.call(`/v1/projects/${projectId}/passport`);
  check(
    'подписчик видит паспорт опубликованного листинга',
    listed.response.status === 200,
    `статус ${listed.response.status}`,
  );
  check('инвестору видны оценки', listed.json?.scores?.length === 9);
}

// ---------------------------------------------------------------- журнал
{
  const verbs = (
    await sql(`SELECT verb FROM audit.events WHERE subject_id = $1 ORDER BY ts`, [projectId])
  ).map((r) => r.verb);
  check('скоринг записан в журнал', verbs.includes('lab.project.scored'), verbs.join(','));

  const outbox = await sql(`SELECT event_type FROM audit.outbox_events WHERE aggregate_id = $1`, [
    projectId,
  ]);
  check('событие выложено в outbox', outbox.length >= 1, `событий ${outbox.length}`);

  const runs = await sql(
    `SELECT status FROM audit.agent_runs WHERE project_id = $1 ORDER BY started_at`,
    [projectId],
  );
  check('оба прогона в журнале агентов', runs.length === 2, `прогонов ${runs.length}`);
  check(
    'оба прогона успешны',
    runs.every((r) => r.status === 'succeeded'),
    runs.map((r) => r.status).join(','),
  );

  const broken = await sql('SELECT * FROM audit.verify_event_chain(NULL)');
  check('цепочка журнала цела', broken.length === 0, `разрывов ${broken.length}`);
}

// ------------------------------------------------------ выключенный контур
try {
  await sql(`UPDATE audit.feature_flags SET enabled = false WHERE key = 'ai.scoring.enabled'`);
  const { response, json } = await founder.client.call(`/v1/projects/${projectId}/analysis`, {
    method: 'POST',
    body: {},
  });
  check(
    'выключенный скоринг отвечает feature_disabled',
    response.status === 503 && json?.code === 'feature_disabled',
    `статус ${response.status} ${json?.code ?? ''}`,
  );
} finally {
  await sql(`UPDATE audit.feature_flags SET enabled = true WHERE key = 'ai.scoring.enabled'`);
}

// ------------------------------------------------------ шлюз недоступен
// Самая важная проверка отказа: анализ не должен «тихо не получиться».
// Прогон обязан остаться в журнале со статусом failed, а клиент — получить
// 503, а не 500 со стеком.
{
  const stopped = stopGateway();
  try {
    if (!stopped) {
      check('шлюз остановлен для проверки отказа', false, 'не нашёл слушателя 8100');
    } else {
      const { response, json } = await founder.client.call(`/v1/projects/${projectId}/analysis`, {
        method: 'POST',
        body: {},
      });
      check(
        'недоступный шлюз даёт 503, а не 500',
        response.status === 503 && json?.code === 'dependency_unavailable',
        `статус ${response.status} ${json?.code ?? ''}`,
      );
      const runs = await sql(
        `SELECT status FROM audit.agent_runs WHERE project_id = $1 AND status = 'failed'`,
        [projectId],
      );
      check(
        'неудачный прогон остался в журнале',
        runs.length === 1,
        `failed-прогонов ${runs.length}`,
      );

      const passports = await sql(
        `SELECT count(*)::int AS n FROM scoring.investment_passports
          WHERE project_id = $1 AND superseded_at IS NULL`,
        [projectId],
      );
      check(
        'неудача не создала третий паспорт',
        passports[0].n === 1,
        `действующих паспортов ${passports[0].n}`,
      );
    }
  } finally {
    startGateway();
    await waitForGateway();
  }
}

// Одиночный прогон на проект (SEC-17). Раньше ничто не мешало запустить сколько
// угодно дорогих анализов одного проекта одновременно: общий предел частоты на
// порядки выше стоимости одного прогона. Опыт ставится честно — три
// ОДНОВРЕМЕННЫХ запроса; принят должен быть ровно один.
{
  await sql(
    `UPDATE audit.agent_runs SET status = 'failed', finished_at = now()
      WHERE project_id = $1 AND status = 'running'`,
    [projectId],
  );
  const attempts = await Promise.all(
    [0, 1, 2].map(() =>
      founder.client.call(`/v1/projects/${projectId}/analysis`, { method: 'POST', body: {} }),
    ),
  );
  const codes = attempts.map((a) => a.response.status).join(',');
  const conflicts = attempts.filter((a) => a.response.status === 409).length;
  check(
    'одновременные запуски анализа: принят не более одного',
    conflicts >= 2,
    `ответы: ${codes}`,
  );
  const running = await sql(
    `SELECT count(*)::int n FROM audit.agent_runs WHERE project_id = $1 AND status = 'running'`,
    [projectId],
  );
  check(
    'в журнале не осталось нескольких активных прогонов',
    running[0].n <= 1,
    `активных: ${running[0].n}`,
  );
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
await pool.end();
if (failed > 0) process.exitCode = 1;
