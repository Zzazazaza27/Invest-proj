/* global __ENV, open -- глобальные имена среды k6, не Node */
/**
 * Нагрузочный профиль p1 для k6 (W32, docs/architecture/w32-load-failures-plan.md §3).
 *
 * Запуск — через обёртку `node scripts/load/run.mjs` (Docker, образ k6 с digest).
 * Параметры — переменные окружения k6 (`-e` или окружение контейнера):
 *
 *   FIFTH_LOAD_BASE        адрес цели, например http://fifth-web (сеть локального стенда)
 *   FIFTH_LOAD_USERS       файл участников от seed.mjs (по умолчанию /load-data/users.json)
 *   FIFTH_LOAD_OUT         каталог сводки (по умолчанию /out)
 *   FIFTH_LOAD_RUN_ID      метка прогона (в сводку)
 *   FIFTH_LOAD_MODE        base | steps | soak
 *   FIFTH_LOAD_RATE        base: действий/с (2), может быть дробной
 *   FIFTH_LOAD_DURATION    base: длительность (15m)
 *   FIFTH_LOAD_STEPS       steps: ступени действий/с (2,4,8,16)
 *   FIFTH_LOAD_STEP_DURATION   steps: длительность ступени (10m)
 *   FIFTH_LOAD_RETURN_RATE     steps: возврат к номиналу (2; 0 — без возврата)
 *   FIFTH_LOAD_RETURN_DURATION steps: длительность возврата (10m)
 *   FIFTH_LOAD_SOAK_RATE / FIFTH_LOAD_SOAK_DURATION   soak: 2 и 60m
 *   FIFTH_LOAD_BURST       серия одновременных входов раз в ступень: размер (20; 0 — нет)
 *   FIFTH_LOAD_MAX_UPLOAD  одна загрузка максимального размера deck (50 МиБ) раз в ступень (1/0)
 *   FIFTH_LOAD_PROFILE     p1 (полная смесь) | p1-api (без загрузок файлов: само API) |
 *                          p1-files (только загрузки: 64 КиБ и 10 МиБ в долях p1, плюс 50 МиБ)
 *   FIFTH_LOAD_MAX_VUS     потолок VU на ступень (по умолчанию от частоты)
 *   FIFTH_LOAD_STORAGE_REWRITE  «откуда=>куда,…» — замена префикса адреса хранилища (Docker)
 *   FIFTH_LOAD_BASIC_AUTH  готовое значение `Basic …` для закрытой цели (только из окружения)
 *
 * ИСПОЛНИТЕЛЬ. Постоянная частота прибытия: каждая ступень — свой сценарий
 * constant-arrival-rate со своим началом, поэтому заданная и фактическая
 * интенсивность и dropped_iterations видны по каждой ступени. Пауза сеанса
 * 3–7 с здесь не воспроизводится: поток задаёт частота, а каждое действие
 * выполняется от имени одного из заранее вошедших участников.
 *
 * МЕТКИ. `action` — вид действия, `name` — шаблон маршрута (без id объектов);
 * системная метка `url` выключена, чтобы id не попадали в метрики.
 */
import http from 'k6/http';
import exec from 'k6/execution';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ------------------------------------------------------------------ параметры

const ENV = __ENV;
const BASE = (ENV.FIFTH_LOAD_BASE || 'http://fifth-web').replace(/\/+$/, '');
const OUT = (ENV.FIFTH_LOAD_OUT || '/out').replace(/\/+$/, '');
const RUN_ID = ENV.FIFTH_LOAD_RUN_ID || 'unknown';
const MODE = ENV.FIFTH_LOAD_MODE || 'base';
// «откуда=>куда,…»: префиксы адреса хранилища из билета, недоступные из контейнера.
const STORAGE_REWRITE = (ENV.FIFTH_LOAD_STORAGE_REWRITE || '')
  .split(',')
  .filter((p) => p.indexOf('=>') > 0)
  .map((p) => p.split('=>').map((x) => x.trim()));
const BASIC = ENV.FIFTH_LOAD_BASIC_AUTH || '';
const BURST = num(ENV.FIFTH_LOAD_BURST, 20);
const PROFILE = ENV.FIFTH_LOAD_PROFILE || 'p1';
if (!['p1', 'p1-api', 'p1-files'].includes(PROFILE))
  throw new Error(`неизвестный профиль: ${PROFILE} (p1 | p1-api | p1-files)`);
// p1-api — без загрузок вовсе, в том числе без 50 МиБ.
const MAX_UPLOAD = PROFILE !== 'p1-api' && (ENV.FIFTH_LOAD_MAX_UPLOAD || '1') !== '0';
const DATA = JSON.parse(open(ENV.FIFTH_LOAD_USERS || '/load-data/users.json'));

function num(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`не число: ${raw}`);
  return n;
}

/** «15m», «60s», «1h», «90» → секунды. */
function seconds(raw, fallback) {
  const s = String(raw || fallback).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)(h|m|s)?$/);
  if (!m) throw new Error(`не длительность: ${s}`);
  const k = { h: 3600, m: 60, s: 1 }[m[2] || 's'];
  return Math.round(Number(m[1]) * k);
}

/** Ступени режима: имя, частота действий/с, длительность в секундах. */
function stagesFor(mode) {
  if (mode === 'base') {
    return [
      {
        name: 'base',
        rate: num(ENV.FIFTH_LOAD_RATE, 2),
        duration: seconds(ENV.FIFTH_LOAD_DURATION, '15m'),
      },
    ];
  }
  if (mode === 'steps') {
    const rates = (ENV.FIFTH_LOAD_STEPS || '2,4,8,16').split(',').map((r) => num(r.trim(), 0));
    const duration = seconds(ENV.FIFTH_LOAD_STEP_DURATION, '10m');
    const out = rates.map((rate, i) => ({ name: `step${i + 1}_${rate}`, rate, duration }));
    const back = num(ENV.FIFTH_LOAD_RETURN_RATE, 2);
    if (back > 0) {
      out.push({
        name: `return_${back}`,
        rate: back,
        duration: seconds(ENV.FIFTH_LOAD_RETURN_DURATION, '10m'),
      });
    }
    return out;
  }
  if (mode === 'soak') {
    return [
      {
        name: 'soak',
        rate: num(ENV.FIFTH_LOAD_SOAK_RATE, 2),
        duration: seconds(ENV.FIFTH_LOAD_SOAK_DURATION, '60m'),
      },
    ];
  }
  throw new Error(`неизвестный режим: ${mode} (base | steps | soak)`);
}

const STAGES = stagesFor(MODE);

// Действия и доли — таблица §3 плана. Сумма — 100.
const MIX_P1 = [
  ['catalog_filter', 20],
  ['card_allowed', 20],
  ['card_forbidden', 5],
  ['own_projects', 15],
  ['search', 10],
  ['project_edit', 10],
  ['profile_edit', 5],
  ['material_link', 5],
  ['upload_64k', 7],
  ['upload_10m', 3],
];
// Отдельные профили (W32, Тэнк 10.11): API и большие файлы мерить раздельно — доли внутри
// профиля те же, что в p1, и действия те же.
const UPLOADS = ['upload_64k', 'upload_10m'];
const MIX =
  PROFILE === 'p1-api'
    ? MIX_P1.filter(([a]) => !UPLOADS.includes(a))
    : PROFILE === 'p1-files'
      ? MIX_P1.filter(([a]) => UPLOADS.includes(a))
      : MIX_P1;
const MIX_TOTAL = MIX.reduce((s, [, w]) => s + w, 0);
const EXTRA_ACTIONS = ['login_burst', 'upload_max'];
const ALL_ACTIONS = MIX.map(([a]) => a).concat(EXTRA_ACTIONS);

// Статусы, по которым сводка раскладывает ошибки; прочие — `other`.
const STATUSES = ['0', '200', '201', '204', '400', '401', '403', '404', '409', '413', '422', '429'];
STATUSES.push('500', '502', '503', '504', 'other', 'upload_state');

// ------------------------------------------------------------------- сценарии

function buildScenarios() {
  const scenarios = {};
  let start = 0;
  for (const st of STAGES) {
    const perMinute = Math.max(1, Math.round(st.rate * 60));
    const maxVUs = num(ENV.FIFTH_LOAD_MAX_VUS, Math.max(10, Math.ceil(st.rate * 20)));
    scenarios[`p1_${st.name}`] = {
      executor: 'constant-arrival-rate',
      exec: 'action',
      // Частота в минуту: так дробная частота (0,5/с) задаётся точно.
      rate: perMinute,
      timeUnit: '1m',
      duration: `${st.duration}s`,
      startTime: `${start}s`,
      preAllocatedVUs: Math.min(maxVUs, Math.max(2, Math.ceil(st.rate * 2))),
      maxVUs,
      gracefulStop: '30s',
      tags: { step: st.name },
    };
    // Отдельно в каждой ступени — серия одновременных входов и одна большая загрузка.
    const mid = start + Math.min(Math.floor(st.duration / 2), 300);
    if (BURST > 0) {
      scenarios[`burst_${st.name}`] = {
        executor: 'per-vu-iterations',
        exec: 'loginBurst',
        vus: BURST,
        iterations: 1,
        startTime: `${mid}s`,
        maxDuration: '2m',
        tags: { step: st.name },
      };
    }
    if (MAX_UPLOAD) {
      scenarios[`maxup_${st.name}`] = {
        executor: 'shared-iterations',
        exec: 'uploadMax',
        vus: 1,
        iterations: 1,
        startTime: `${start + Math.floor(st.duration / 3)}s`,
        maxDuration: '5m',
        tags: { step: st.name },
      };
    }
    start += st.duration;
  }
  return scenarios;
}

/**
 * Пороговые выражения, которые всегда выполняются: k6 выводит в сводку разрезы
 * по меткам только для метрик, у которых есть порог.
 */
function buildThresholds() {
  const t = {};
  const always = (metric, expr) => {
    t[metric] = [expr];
  };
  for (const a of ALL_ACTIONS) {
    always(`http_req_duration{action:${a}}`, 'max>=0');
    always(`action_duration{action:${a}}`, 'max>=0');
    always(`action_requests{action:${a}}`, 'count>=0');
    always(`action_errors{action:${a}}`, 'count>=0');
    always(`action_skipped{action:${a}}`, 'count>=0');
    always(`action_count{action:${a}}`, 'count>=0');
  }
  for (const s of STATUSES) always(`action_errors{status:${s}}`, 'count>=0');
  for (const st of STAGES) {
    const sc = `p1_${st.name}`;
    always(`iterations{scenario:${sc}}`, 'count>=0');
    always(`dropped_iterations{scenario:${sc}}`, 'count>=0');
    always(`http_req_duration{scenario:${sc}}`, 'max>=0');
    always(`action_duration{scenario:${sc}}`, 'max>=0');
    always(`action_errors{scenario:${sc}}`, 'count>=0');
  }
  always('http_req_failed', 'rate>=0');
  always('dropped_iterations', 'count>=0');
  return t;
}

export const options = {
  scenarios: buildScenarios(),
  thresholds: buildThresholds(),
  setupTimeout: '10m',
  teardownTimeout: '1m',
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'],
  // Без `url`: адрес содержит id объектов. Шаблон маршрута — в метке `name`.
  systemTags: [
    'status',
    'method',
    'name',
    'group',
    'check',
    'error',
    'error_code',
    'scenario',
    'expected_response',
  ],
  discardResponseBodies: false,
  noConnectionReuse: false,
  userAgent: 'fifth-load-p1/k6',
};

// -------------------------------------------------------------------- метрики

const actionDuration = new Trend('action_duration', true);
const actionRequests = new Counter('action_requests');
const actionErrors = new Counter('action_errors');
const actionSkipped = new Counter('action_skipped');
const actionCount = new Counter('action_count');
// Повторные входы после истечения сеанса (срок 1 ч): тем же участником, в сводку отдельно.
const relogins = new Counter('relogins');

const CB_OK = http.expectedStatuses({ min: 200, max: 299 });
const CB_DENIED = http.expectedStatuses(403, 404);

// ---------------------------------------------------------------------- HTTP

/** Ключ повтора: криптостойкий UUID (webcrypto k6). */
function uuid() {
  return crypto.randomUUID();
}

function statusTag(status) {
  const s = String(status);
  return STATUSES.indexOf(s) >= 0 ? s : 'other';
}

/**
 * Запрос к API от имени сеанса. Банка cookie у каждого запроса пустая:
 * сеанс передаётся явно, и ответ одного участника не подменяет cookie другому.
 */
function api(session, method, path, body, { action, route, idem = false, denied = false }) {
  // Ключ повтора — один на действие: повтор после повторного входа идёт с ТЕМ ЖЕ ключом.
  const key = idem ? uuid() : null;
  const send = () => {
    const headers = { 'X-Fifth-Origin': 'render_check' };
    if (BASIC) headers.Authorization = BASIC;
    if (session) {
      headers.Cookie = session.cookie;
      if (method !== 'GET') headers['X-CSRF-Token'] = session.csrf;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    return http.request(
      method,
      `${BASE}${path}`,
      body === undefined ? null : JSON.stringify(body),
      {
        headers,
        tags: { action, name: route },
        jar: new http.CookieJar(),
        responseCallback: denied ? CB_DENIED : CB_OK,
        timeout: '120s',
      },
    );
  };
  let res = send();
  actionRequests.add(1, { action });
  // Сеанс истёк (401) — повторный вход тем же участником и ОДИН повтор того же запроса.
  // 401 выдаётся проверкой сеанса до обработчика: операция не выполнялась, повтор безопасен;
  // защищённые операции идут с прежним ключом. Любой другой отказ не повторяется.
  if (res.status === 401 && session && relogin(session)) {
    res = send();
    actionRequests.add(1, { action });
  }
  const ok = denied
    ? res.status === 403 || res.status === 404
    : res.status >= 200 && res.status < 300;
  if (!ok) actionErrors.add(1, { action, status: statusTag(res.status) });
  return { res, ok };
}

function json(res) {
  try {
    return res.json();
  } catch {
    return null;
  }
}

function pick(list) {
  // nosemgrep: unicorn-no-math-random-for-security — выбор действия профиля, не секрет
  return list[Math.floor(Math.random() * list.length)];
}

function skip(action) {
  actionSkipped.add(1, { action });
  return false;
}

// ------------------------------------------------------------------ загрузка

const fileCache = {};

/** Тело файла заданного размера: заголовок PDF, наполнитель, концовка. ASCII — байт в байт. */
function pdfBody(size) {
  if (!fileCache[size]) {
    const head = '%PDF-1.4\n% fifth load p1\n';
    const tail = '\n%%EOF\n';
    fileCache[size] = head + 'A'.repeat(size - head.length - tail.length) + tail;
  }
  return fileCache[size];
}

/**
 * Билет, POST формы в хранилище, подтверждение — как функция upload в
 * scripts/check-upload-publish-right.mjs. Тело multipart собирается вручную:
 * хранилище требует, чтобы `file` шёл последним, а k6 упорядочивает поля
 * объекта сам.
 */
function upload(session, action, projectId, size) {
  const t = api(
    session,
    'POST',
    `/v1/projects/${projectId}/materials/upload`,
    { type: 'deck', fileName: 'load-p1.pdf', contentType: 'application/pdf', sizeBytes: size },
    { action, route: 'POST /v1/projects/:id/materials/upload' },
  );
  const ticket = t.ok ? json(t.res) : null;
  if (!ticket || !ticket.materialId || !ticket.uploadUrl) return false;

  let url = ticket.uploadUrl;
  for (const [from, to] of STORAGE_REWRITE) {
    if (url.indexOf(from) === 0) {
      url = to + url.slice(from.length);
      break;
    }
  }
  const boundary = `----fifthload${uuid().replace(/-/g, '')}`;
  let head = '';
  for (const k of Object.keys(ticket.formFields || {})) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${ticket.formFields[k]}\r\n`;
  }
  head +=
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="load-p1.pdf"\r\n` +
    'Content-Type: application/pdf\r\n\r\n';
  const body = head + pdfBody(size) + `\r\n--${boundary}--\r\n`;
  const put = http.post(url, body, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    tags: { action, name: 'POST storage (presigned form)' },
    jar: new http.CookieJar(),
    responseCallback: CB_OK,
    timeout: '300s',
  });
  actionRequests.add(1, { action });
  if (put.status < 200 || put.status >= 300) {
    actionErrors.add(1, { action, status: statusTag(put.status) });
    return false;
  }

  const f = api(
    session,
    'POST',
    `/v1/projects/${projectId}/materials/${ticket.materialId}/finalize`,
    undefined,
    { action, route: 'POST /v1/projects/:id/materials/:materialId/finalize' },
  );
  if (!f.ok) return false;
  const state = (json(f.res) || {}).uploadState;
  // pending — сохранение ещё идёт, это не ошибка; отказ хранилища — ошибка.
  if (state === 'rejected' || state === 'needs_attention') {
    actionErrors.add(1, { action, status: 'upload_state' });
    return false;
  }
  return true;
}

// ------------------------------------------------------------------- действия

const SEARCH_TERMS = ['нагрузка', 'проект', 'синтетический', RUN_ID];

function ownProject(session) {
  const u = DATA.users[session.user];
  return u && u.projects.length ? pick(u.projects).id : null;
}

const ACTIONS = {
  catalog_filter() {
    let q = `stage=${pick(DATA.stages)}&limit=20`;
    // nosemgrep: unicorn-no-math-random-for-security — выбор действия профиля, не секрет
    if (Math.random() < 0.5 && DATA.taxonomyIds.length)
      q += `&taxonomyId=${pick(DATA.taxonomyIds)}`;
    return api(null, 'GET', `/v1/catalog?${q}`, undefined, {
      action: 'catalog_filter',
      route: 'GET /v1/catalog?filter',
    }).ok;
  },
  card_allowed(s) {
    if (!DATA.publicProjects.length) return skip('card_allowed');
    return api(s, 'GET', `/v1/catalog/${pick(DATA.publicProjects)}`, undefined, {
      action: 'card_allowed',
      route: 'GET /v1/catalog/:id',
    }).ok;
  },
  card_forbidden(s) {
    const foreign = DATA.privateProjects.filter((p) => p.owner !== s.user);
    if (!foreign.length) return skip('card_forbidden');
    return api(s, 'GET', `/v1/catalog/${pick(foreign).id}`, undefined, {
      action: 'card_forbidden',
      route: 'GET /v1/catalog/:id (denied)',
      denied: true,
    }).ok;
  },
  own_projects(s) {
    return api(s, 'GET', '/v1/projects', undefined, {
      action: 'own_projects',
      route: 'GET /v1/projects',
    }).ok;
  },
  search(s) {
    const q = encodeURIComponent(pick(SEARCH_TERMS));
    return api(s, 'GET', `/v1/catalog?q=${q}&sort=relevance&limit=20`, undefined, {
      action: 'search',
      route: 'GET /v1/catalog?q',
    }).ok;
  },
  project_edit(s) {
    const id = ownProject(s);
    if (!id) return skip('project_edit');
    return api(
      s,
      'PATCH',
      `/v1/projects/${id}`,
      { tagline: `Нагрузка p1: правка ${exec.scenario.iterationInTest}` },
      { action: 'project_edit', route: 'PATCH /v1/projects/:id', idem: true },
    ).ok;
  },
  profile_edit(s) {
    return api(
      s,
      'PATCH',
      '/v1/me/profile',
      { displayName: `Нагрузка ${RUN_ID} ${s.user} · ${exec.scenario.iterationInTest % 1000}` },
      { action: 'profile_edit', route: 'PATCH /v1/me/profile' },
    ).ok;
  },
  material_link(s) {
    const id = ownProject(s);
    if (!id) return skip('material_link');
    return api(
      s,
      'POST',
      `/v1/projects/${id}/materials/link`,
      { url: `https://example.com/load/${RUN_ID}/${exec.scenario.iterationInTest}` },
      { action: 'material_link', route: 'POST /v1/projects/:id/materials/link', idem: true },
    ).ok;
  },
  upload_64k(s) {
    const id = ownProject(s);
    return id ? upload(s, 'upload_64k', id, 64 * 1024) : skip('upload_64k');
  },
  upload_10m(s) {
    const id = ownProject(s);
    return id ? upload(s, 'upload_10m', id, 10 * 1024 * 1024) : skip('upload_10m');
  },
};

function chooseAction() {
  // nosemgrep: unicorn-no-math-random-for-security — выбор действия профиля, не секрет
  let r = Math.random() * MIX_TOTAL;
  for (const [name, w] of MIX) {
    r -= w;
    if (r < 0) return name;
  }
  return MIX[MIX.length - 1][0];
}

// --------------------------------------------------------------------- вход

function cookiesOf(res) {
  const parts = [];
  let csrf = null;
  for (const name of Object.keys(res.cookies || {})) {
    const c = res.cookies[name][0];
    if (!c) continue;
    parts.push(`${name}=${c.value}`);
    if (/csrf/i.test(name)) csrf = c.value;
  }
  return { cookie: parts.join('; '), csrf };
}

function login(user, action) {
  const headers = { 'Content-Type': 'application/json', 'X-Fifth-Origin': 'render_check' };
  if (BASIC) headers.Authorization = BASIC;
  return http.post(
    `${BASE}/v1/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    {
      headers,
      tags: { action, name: 'POST /v1/auth/login' },
      jar: new http.CookieJar(),
      responseCallback: CB_OK,
      timeout: '60s',
    },
  );
}

/**
 * Повторный вход тем же участником (сеанс этого VU). Успех — новые cookie и CSRF в сеансе.
 * Не чаще раза в минуту на сеанс: 401 по другой причине не превращается в поток входов.
 */
function relogin(session) {
  const now = Date.now();
  if (session.reloginAt && now - session.reloginAt < 60_000) return false;
  session.reloginAt = now;
  const user = DATA.users.find((u) => u.index === session.user);
  if (!user) return false;
  const res = login(user, 'relogin');
  relogins.add(1, { status: statusTag(res.status) });
  if (res.status !== 200 && res.status !== 201) return false;
  const c = cookiesOf(res);
  if (!c.csrf) return false;
  session.cookie = c.cookie;
  session.csrf = c.csrf;
  return true;
}

/** Вход один раз на участника. На 429 ждём Retry-After: подготовка не должна падать на лимите. */
export function setup() {
  const sessions = [];
  for (const user of DATA.users) {
    let res = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      res = login(user, 'setup_login');
      if (res.status !== 429) break;
      sleep(Math.min(Number(res.headers['Retry-After']) || 10, 65));
    }
    if (res.status === 200 || res.status === 201) {
      const c = cookiesOf(res);
      if (c.csrf) sessions.push({ user: user.index, cookie: c.cookie, csrf: c.csrf });
    } else {
      console.warn(`вход участника ${user.index}: HTTP ${res.status}`);
    }
  }
  if (!sessions.length) exec.test.abort('ни один участник не вошёл');
  return { sessions, users: DATA.users.length, startedAt: new Date().toISOString() };
}

export function action(data) {
  const name = chooseAction();
  const session = pick(data.sessions);
  const started = Date.now();
  ACTIONS[name](session);
  actionDuration.add(Date.now() - started, { action: name });
  actionCount.add(1, { action: name });
}

/** Серия одновременных входов: каждый VU сценария — один вход. */
export function loginBurst() {
  const user = DATA.users[(exec.vu.iterationInScenario + exec.vu.idInTest) % DATA.users.length];
  const started = Date.now();
  const res = login(user, 'login_burst');
  actionRequests.add(1, { action: 'login_burst' });
  if (res.status !== 200 && res.status !== 201) {
    actionErrors.add(1, { action: 'login_burst', status: statusTag(res.status) });
  }
  actionDuration.add(Date.now() - started, { action: 'login_burst' });
  actionCount.add(1, { action: 'login_burst' });
}

/** Одна загрузка максимального для deck размера (50 МиБ). */
export function uploadMax(data) {
  const session = pick(data.sessions);
  const id = ownProject(session);
  const started = Date.now();
  if (id) upload(session, 'upload_max', id, 50 * 1024 * 1024);
  else skip('upload_max');
  actionDuration.add(Date.now() - started, { action: 'upload_max' });
  actionCount.add(1, { action: 'upload_max' });
}

// -------------------------------------------------------------------- сводка

function pickTrend(v) {
  if (!v) return null;
  return {
    count: v.count,
    avg: v.avg,
    med: v.med,
    p90: v['p(90)'],
    p95: v['p(95)'],
    p99: v['p(99)'],
    max: v.max,
  };
}

function metric(data, key) {
  const m = data.metrics[key];
  return m ? m.values : null;
}

export function handleSummary(data) {
  const actions = {};
  for (const a of ALL_ACTIONS) {
    actions[a] = {
      count: (metric(data, `action_count{action:${a}}`) || {}).count || 0,
      requests: (metric(data, `action_requests{action:${a}}`) || {}).count || 0,
      errors: (metric(data, `action_errors{action:${a}}`) || {}).count || 0,
      skipped: (metric(data, `action_skipped{action:${a}}`) || {}).count || 0,
      httpDurationMs: pickTrend(metric(data, `http_req_duration{action:${a}}`)),
      actionDurationMs: pickTrend(metric(data, `action_duration{action:${a}}`)),
    };
    actions[a].requestsPerAction = actions[a].count ? actions[a].requests / actions[a].count : null;
  }
  const errorsByStatus = {};
  for (const s of STATUSES) {
    const c = (metric(data, `action_errors{status:${s}}`) || {}).count || 0;
    if (c) errorsByStatus[s] = c;
  }
  const stages = STAGES.map((st) => {
    const sc = `p1_${st.name}`;
    const iterations = (metric(data, `iterations{scenario:${sc}}`) || {}).count || 0;
    const dropped = (metric(data, `dropped_iterations{scenario:${sc}}`) || {}).count || 0;
    return {
      name: st.name,
      targetRatePerSec: st.rate,
      durationSec: st.duration,
      iterations,
      actualRatePerSec: st.duration ? iterations / st.duration : null,
      droppedIterations: dropped,
      errors: (metric(data, `action_errors{scenario:${sc}}`) || {}).count || 0,
      httpDurationMs: pickTrend(metric(data, `http_req_duration{scenario:${sc}}`)),
      actionDurationMs: pickTrend(metric(data, `action_duration{scenario:${sc}}`)),
    };
  });
  const setupData = data.setup_data || {};
  const summary = {
    profile: PROFILE,
    runId: RUN_ID,
    mode: MODE,
    target: BASE.replace(/\/\/[^@/]*@/, '//'),
    finishedAt: new Date().toISOString(),
    testRunDurationMs: data.state ? data.state.testRunDurationMs : null,
    participants: {
      inData: DATA.users.length,
      loggedIn: (setupData.sessions || []).length,
      relogins: (metric(data, 'relogins') || {}).count || 0,
    },
    stages,
    actions,
    errorsByStatus,
    totals: {
      httpReqs: (metric(data, 'http_reqs') || {}).count || 0,
      httpReqFailedRate: (metric(data, 'http_req_failed') || {}).rate,
      iterations: (metric(data, 'iterations') || {}).count || 0,
      droppedIterations: (metric(data, 'dropped_iterations') || {}).count || 0,
      dataSentBytes: (metric(data, 'data_sent') || {}).count || 0,
      dataReceivedBytes: (metric(data, 'data_received') || {}).count || 0,
      httpDurationMs: pickTrend(metric(data, 'http_req_duration')),
      vusMax: (metric(data, 'vus_max') || {}).max || null,
    },
  };
  // Сырые метрики k6 — без setup_data: там cookie сеансов.
  const raw = { metrics: data.metrics, state: data.state, options: data.options };
  const lines = [
    `p1 ${MODE} ${RUN_ID}: запросов ${summary.totals.httpReqs}, dropped ${summary.totals.droppedIterations}`,
  ];
  for (const st of stages) {
    lines.push(
      `  ${st.name}: задано ${st.targetRatePerSec}/с, факт ${(st.actualRatePerSec || 0).toFixed(2)}/с, ` +
        `dropped ${st.droppedIterations}, ошибок ${st.errors}`,
    );
  }
  for (const a of ALL_ACTIONS) {
    const x = actions[a];
    if (!x.count) continue;
    const d = x.httpDurationMs || {};
    lines.push(
      `  ${a}: ${x.count} действий, ${x.requests} запросов, ошибок ${x.errors}, ` +
        `p95 ${fmt(d.p95)} p99 ${fmt(d.p99)} max ${fmt(d.max)} мс`,
    );
  }
  lines.push(`  ошибки по статусам: ${JSON.stringify(errorsByStatus)}`);
  return {
    [`${OUT}/summary.json`]: JSON.stringify(summary, null, 2),
    [`${OUT}/k6-metrics.json`]: JSON.stringify(raw, null, 2),
    stdout: `\n${lines.join('\n')}\n`,
  };
}

function fmt(v) {
  return typeof v === 'number' ? v.toFixed(1) : '-';
}
