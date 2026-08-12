#!/usr/bin/env node
/**
 * Гейт сетевой безопасности (RULES.md §3.2).
 *
 * Прогоняется по завершении КАЖДОЙ фазы. Проверяет фактическое состояние, а не
 * намерение в конфиге: реальные привязки портов контейнеров, реальные заголовки
 * ответа API, реальное поведение CORS с чужим Origin.
 *
 * Выход: 0 — гейт пройден; 1 — есть находки уровня CRITICAL/HIGH/MEDIUM,
 * которые обязаны быть исправлены в этой же фазе, до коммита.
 *
 * Запуск:  node scripts/network-audit.mjs [--api http://localhost:4300]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** @type {{severity:string, check:string, detail:string}[]} */
const findings = [];
const passed = [];

const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
const BLOCKING = new Set(['CRITICAL', 'HIGH', 'MEDIUM']);

/**
 * Проверки, которые НЕ УДАЛОСЬ выполнить.
 *
 * Отдельный список, а не находка уровня LOW. Раньше «docker недоступен» и
 * «живая проверка CORS не выполнена» записывались как LOW и тонули среди
 * находок: блокируют только CRITICAL/HIGH/MEDIUM, поэтому гейт печатал «Гейт
 * пройден», фактически проверив меньше, чем заявляет. Невыполненная проверка —
 * это не «всё в порядке», это отсутствие сведений (SEC-20).
 */
const notRun = [];

/** Строгий режим: невыполненная проверка блокирует. Включён в CI. */
const STRICT = process.argv.includes('--strict') || process.env.NETWORK_AUDIT_STRICT === 'true';

function fail(severity, check, detail) {
  findings.push({ severity, check, detail });
}
function ok(check, detail) {
  passed.push({ check, detail });
}
/** Проверка не выполнена: причина названа, результат не выдаётся за успех. */
function skip(check, detail) {
  notRun.push({ check, detail });
}

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Фактические привязки портов контейнеров.
//    Служебные порты (БД, брокер, кеш, хранилище, IdP) не должны слушать 0.0.0.0.
// ---------------------------------------------------------------------------
function checkContainerPortBindings() {
  const out = sh('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}']);
  if (out === null) {
    skip('container-ports', 'docker недоступен');
    return;
  }
  const lines = out.split('\n').filter((l) => l.trim() && l.includes('unicorn-'));
  if (lines.length === 0) {
    skip('container-ports', 'контейнеры проекта не запущены');
    return;
  }
  let exposed = 0;
  for (const line of lines) {
    const [name, ports = ''] = line.split('\t');
    // Пример строки: 0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
    for (const mapping of ports
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!mapping.includes('->')) continue;
      const host = mapping.split('->')[0];
      const isLoopback =
        host.startsWith('127.0.0.1:') || host.startsWith('[::1]:') || host.startsWith('localhost:');
      if (!isLoopback) {
        exposed += 1;
        fail(
          'HIGH',
          'container-ports',
          `${name}: порт опубликован вне loopback — ${mapping}. ` +
            'Служебные порты биндятся на 127.0.0.1 (RULES.md §3.2).',
        );
      }
    }
  }
  if (exposed === 0) {
    ok('container-ports', `${lines.length} контейнеров, все опубликованные порты — на loopback`);
  }
}

// ---------------------------------------------------------------------------
// 2. Инфраструктурные манифесты: запрет 0.0.0.0 в публикации портов,
//    запрет анонимного доступа, дефолтных кредов и реальных секретов.
// ---------------------------------------------------------------------------
function checkComposeManifests() {
  const composePath = join(ROOT, 'infra', 'docker-compose.yml');
  if (!existsSync(composePath)) {
    fail('MEDIUM', 'compose', 'infra/docker-compose.yml не найден');
    return;
  }
  const text = readFileSync(composePath, 'utf8');

  const badBindings = text
    .split('\n')
    .map((l, i) => [l, i + 1])
    .filter(([l]) => /^\s*-\s*['"]?(0\.0\.0\.0|\*)?:?\d+:\d+/.test(l) && !l.includes('127.0.0.1'));
  if (badBindings.length > 0) {
    for (const [l, n] of badBindings) {
      fail(
        'HIGH',
        'compose-bindings',
        `docker-compose.yml:${n} публикует порт без 127.0.0.1: ${l.trim()}`,
      );
    }
  } else {
    ok('compose-bindings', 'все публикации портов в compose привязаны к 127.0.0.1');
  }

  // Явно опасные включения анонимного доступа.
  const anonPatterns = [
    [/ALLOW_ANONYMOUS_LOGIN\s*[:=]\s*['"]?(yes|true)/i, 'включён анонимный вход'],
    [/POSTGRES_HOST_AUTH_METHOD\s*[:=]\s*['"]?trust/i, 'PostgreSQL с auth-method=trust'],
    [/--auth-host=trust/i, 'PostgreSQL инициализируется с trust-аутентификацией'],
    [/allow_anonymous/i, 'разрешён анонимный доступ'],
  ];
  let anonHits = 0;
  for (const [re, msg] of anonPatterns) {
    if (re.test(text)) {
      anonHits += 1;
      fail('CRITICAL', 'compose-anon', `${msg} в infra/docker-compose.yml`);
    }
  }
  if (anonHits === 0) ok('compose-anon', 'анонимный доступ к инфраструктуре не включён');
}

// ---------------------------------------------------------------------------
// 3. Запрет отключения проверки TLS и небезопасного транспорта в коде.
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.vite',
  'playwright-report',
  'test-results',
  'graphify-out',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
]);
const SCAN_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|yml|yaml|json|sql|toml)$/;

/**
 * Обход дерева, устойчивый к недоступным каталогам.
 *
 * Прежняя версия падала с EPERM на служебном каталоге (`.pytest_cache`), и
 * гейт не выдавал заключения вовсе — то есть переставал работать из-за файла,
 * который его не касается. Пропуск такого каталога объявляется вслух: молчать
 * о непросмотренном участке нельзя, иначе «находок нет» означает «не смотрел».
 */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    skipped.push(`${dir} (${error.code ?? 'ошибка чтения'})`);
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch (error) {
      skipped.push(`${full} (${error.code ?? 'ошибка чтения'})`);
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (SCAN_EXT.test(entry)) yield full;
  }
}

/** Непросмотренные пути: печатаются в конце, а не пропадают. */
const skipped = [];

function checkInsecureTransport() {
  // Правило и его описание не должны сами по себе считаться находкой,
  // поэтому файлы политик исключены из скана.
  const POLICY_FILES = new Set(['RULES.md', 'network-audit.mjs', 'guardian.yml']);
  const rules = [
    [/rejectUnauthorized\s*:\s*false/, 'CRITICAL', 'отключена проверка TLS-сертификата (Node)'],
    [/verify\s*=\s*False/, 'CRITICAL', 'отключена проверка TLS-сертификата (Python requests)'],
    [
      /NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*['"]?0/,
      'CRITICAL',
      'глобально отключена проверка TLS',
    ],
    [/ssl\._create_unverified_context/, 'CRITICAL', 'создаётся неверифицированный SSL-контекст'],
    [/curl\s+[^\n]*\s-k(\s|$)/, 'HIGH', 'curl с отключённой проверкой сертификата'],
    [
      /InsecureRequestWarning|urllib3\.disable_warnings/,
      'HIGH',
      'подавление предупреждений о небезопасном TLS',
    ],
    [/minVersion\s*:\s*['"]TLSv1(\.[01])?['"]/, 'HIGH', 'разрешён устаревший TLS < 1.2'],
  ];
  let hits = 0;
  for (const file of walk(ROOT)) {
    const base = file.split(/[\\/]/).pop();
    if (POLICY_FILES.has(base)) continue;
    const text = readFileSync(file, 'utf8');
    for (const [re, sev, msg] of rules) {
      if (re.test(text)) {
        hits += 1;
        fail(sev, 'tls', `${relative(ROOT, file)}: ${msg}`);
      }
    }
  }
  if (hits === 0) ok('tls', 'проверка TLS-сертификатов нигде не отключается');
}

// ---------------------------------------------------------------------------
// 4. CORS: запрет '*' и отражения произвольного Origin вместе с credentials.
// ---------------------------------------------------------------------------
function checkCorsConfiguration() {
  let hits = 0;
  for (const file of walk(join(ROOT, 'apps'))) {
    if (!/\.(ts|js|mjs)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (
      /origin\s*:\s*['"`]\*['"`]/.test(text) ||
      /Access-Control-Allow-Origin['"`]?\s*[,:]\s*['"`]\*/.test(text)
    ) {
      hits += 1;
      fail('HIGH', 'cors', `${relative(ROOT, file)}: CORS с Origin '*'`);
    }
    if (/origin\s*:\s*true/.test(text) && /credentials\s*:\s*true/.test(text)) {
      hits += 1;
      fail(
        'HIGH',
        'cors',
        `${relative(ROOT, file)}: отражение произвольного Origin вместе с credentials`,
      );
    }
  }
  if (hits === 0) ok('cors', "нет CORS с '*' и нет отражения произвольного Origin при credentials");
}

// ---------------------------------------------------------------------------
// 5. Живая проверка API: заголовки безопасности, CORS с чужим Origin, cookie.
//    Выполняется, только если API отвечает. Иначе — честно фиксируется пропуск.
// ---------------------------------------------------------------------------
const REQUIRED_HEADERS = {
  'x-content-type-options': /^nosniff$/i,
  'referrer-policy': /no-referrer|same-origin|strict-origin/i,
  'content-security-policy': /default-src/i,
  'cross-origin-opener-policy': /same-origin/i,
  'x-frame-options': /deny|sameorigin/i,
  // RULES §3.2 требует его явно, а helmet его не выставляет: заголовка не было
  // ни в ответах, ни в этом списке — гейт был слабее правила, по которому
  // объявлял себя пройденным.
  'permissions-policy': /geolocation=\(\)/i,
};

/**
 * Отвечает ли на этом адресе ИМЕННО наш core.
 * Чужой сервис на том же порту (частая ситуация на машине разработчика) не
 * должен превращаться ни в зелёный статус, ни в ложную находку по нашему коду.
 */
async function identifyApi(res) {
  if (!res.ok) return false;
  try {
    const body = await res.clone().json();
    return body?.service === 'unicorn-launch-core';
  } catch {
    return false;
  }
}

async function checkLiveApi(apiBase) {
  let res;
  try {
    res = await fetch(`${apiBase}/v1/health`, {
      signal: AbortSignal.timeout(3000),
      redirect: 'manual',
    });
  } catch {
    // Именно этот случай и делал гейт зелёным впустую: недоступный API —
    // это НЕ выполненная проверка заголовков, CORS и ограничения частоты,
    // а не их успех (SEC-20).
    skip('live-api', `API ${apiBase} не отвечает — заголовки, CORS и rate-limit не проверены`);
    return;
  }

  if (!(await identifyApi(res))) {
    fail(
      'MEDIUM',
      'live-api',
      `На ${apiBase} отвечает ПОСТОРОННИЙ сервис (HTTP ${res.status}), не unicorn-launch-core. ` +
        'Живая проверка не выполнена; проверь занятость порта перед запуском core.',
    );
    return;
  }

  for (const [header, re] of Object.entries(REQUIRED_HEADERS)) {
    const value = res.headers.get(header);
    if (!value) fail('MEDIUM', 'headers', `отсутствует заголовок ${header}`);
    else if (!re.test(value))
      fail('MEDIUM', 'headers', `${header} имеет недопустимое значение: ${value}`);
  }
  if (!findings.some((f) => f.check === 'headers')) {
    ok('headers', `все обязательные заголовки безопасности присутствуют (${res.status})`);
  }

  // Раскрытие стека.
  for (const leaky of ['x-powered-by', 'server']) {
    const v = res.headers.get(leaky);
    if (v && !/^(nginx|cloudflare)$/i.test(v)) {
      fail('LOW', 'banner', `заголовок ${leaky} раскрывает стек: ${v}`);
    }
  }

  // CORS с заведомо чужим Origin не должен разрешаться.
  try {
    const evil = await fetch(`${apiBase}/v1/health`, {
      headers: { Origin: 'https://evil.example' },
      signal: AbortSignal.timeout(3000),
    });
    const allow = evil.headers.get('access-control-allow-origin');
    if (allow === '*' || allow === 'https://evil.example') {
      fail(
        'HIGH',
        'cors-live',
        `сервер разрешил чужой Origin: Access-Control-Allow-Origin=${allow}`,
      );
    } else {
      ok('cors-live', 'чужой Origin не получает Access-Control-Allow-Origin');
    }
  } catch {
    skip('cors-live', 'core не отвечает');
  }

  // Cookie-флаги, если сервер их ставит.
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const name = c.split('=')[0];
    if (!/HttpOnly/i.test(c)) fail('HIGH', 'cookie', `${name}: нет HttpOnly`);
    if (!/Secure/i.test(c)) fail('HIGH', 'cookie', `${name}: нет Secure`);
    if (!/SameSite=(Strict|Lax)/i.test(c)) fail('MEDIUM', 'cookie', `${name}: нет SameSite`);
  }
  if (setCookie.length > 0 && !findings.some((f) => f.check === 'cookie')) {
    ok('cookie', `${setCookie.length} cookie — все с HttpOnly/Secure/SameSite`);
  }
}

// ---------------------------------------------------------------------------
// 6. AI-шлюз — новый слушатель периметра (ADR-007).
//    Он единственный ходит к внешним моделям, поэтому проверяется отдельно:
//    привязка к loopback, обязательная аутентификация, отсутствие схемы API и
//    баннера стека наружу.
// ---------------------------------------------------------------------------
async function checkAiGateway(gatewayBase) {
  let health;
  try {
    health = await fetch(`${gatewayBase}/healthz`, { signal: AbortSignal.timeout(3000) });
  } catch {
    fail(
      'LOW',
      'ai-gateway',
      `шлюз ${gatewayBase} не отвечает — живая проверка периметра НЕ выполнена ` +
        '(ограничение прогона, а не зелёный статус)',
    );
    return;
  }

  // Привязка: слушатель шлюза обязан быть на loopback. Проверяется фактическим
  // выводом netstat, а не строкой запуска.
  const listeners = sh('netstat', ['-ano']) ?? '';
  const port = new URL(gatewayBase).port || '8100';
  // Разбор по столбцам, а не поиском подстроки: в строке netstat есть ещё и
  // удалённый адрес `0.0.0.0:0`, и наивная проверка объявляет любой слушатель
  // выставленным наружу — находка, которой нет.
  const external = listeners
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((cols) => cols.length >= 4 && cols[3] === 'LISTENING')
    .filter((cols) => cols[1]?.endsWith(`:${port}`))
    .filter((cols) => /^(0\.0\.0\.0|\[::\]):/.test(cols[1] ?? ''))
    .map((cols) => cols.join(' '));
  if (external.length > 0) {
    fail('HIGH', 'ai-gateway', `шлюз слушает не только loopback: ${external[0].trim()}`);
  } else {
    ok('ai-gateway', `порт ${port} слушается только на loopback`);
  }

  // Аутентификация: рабочий маршрут без токена обязан отвечать 401.
  try {
    const anon = await fetch(`${gatewayBase}/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    if (anon.status !== 401) {
      fail('CRITICAL', 'ai-gateway-auth', `анализ без токена ответил ${anon.status}, ожидался 401`);
    } else {
      ok('ai-gateway-auth', 'анализ без сервисного токена отвергается (401)');
    }
  } catch {
    skip('ai-gateway-auth', 'шлюз не отвечает');
  }

  // Схема API наружу: /docs мало выключить — /openapi.json отдаёт то же самое.
  const exposed = [];
  for (const path of ['/docs', '/redoc', '/openapi.json']) {
    try {
      const r = await fetch(`${gatewayBase}${path}`, { signal: AbortSignal.timeout(3000) });
      if (r.status === 200) exposed.push(path);
    } catch {
      /* недоступен — это и требуется */
    }
  }
  if (exposed.length > 0) {
    fail(
      'MEDIUM',
      'ai-gateway-docs',
      `схема API открыта без аутентификации: ${exposed.join(', ')}`,
    );
  } else {
    ok('ai-gateway-docs', 'схема API и интерактивные доки наружу не отдаются');
  }

  // Баннер стека.
  const banner = health.headers.get('server');
  if (banner) {
    fail('LOW', 'ai-gateway-banner', `заголовок server раскрывает стек: ${banner}`);
  } else {
    ok('ai-gateway-banner', 'заголовок server не выставляется');
  }

  for (const [header, expected] of [
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', 'no-referrer'],
  ]) {
    const value = health.headers.get(header);
    if (value !== expected) {
      fail(
        'LOW',
        'ai-gateway-headers',
        `${header}=${value ?? 'отсутствует'}, ожидалось ${expected}`,
      );
    }
  }
  if (!findings.some((f) => f.check === 'ai-gateway-headers')) {
    ok('ai-gateway-headers', 'заголовки безопасности шлюза на месте');
  }
}

// ---------------------------------------------------------------------------
// 7. Секреты в инфраструктурных манифестах.
// ---------------------------------------------------------------------------
function checkInfraCredentials() {
  const PLACEHOLDER = /(CHANGE_ME|local_dev_only|ci_only_password|\$\{[A-Z_]+)/;
  const SECRET_KEY = /(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|ACCESS_KEY)\s*[:=]\s*['"]?([^\s'"$#]+)/g;
  let hits = 0;
  for (const file of walk(join(ROOT, 'infra'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(SECRET_KEY)) {
      const value = m[2];
      if (value && value.length >= 8 && !PLACEHOLDER.test(value) && !PLACEHOLDER.test(m[0])) {
        hits += 1;
        fail(
          'CRITICAL',
          'infra-credentials',
          `${relative(ROOT, file)}: похоже на реальный секрет в манифесте (${m[1]})`,
        );
      }
    }
  }
  if (hits === 0)
    ok('infra-credentials', 'в инфраструктурных манифестах только плейсхолдеры и переменные');
}

// ---------------------------------------------------------------------------
// Прогон и отчёт
// ---------------------------------------------------------------------------
const apiArgIndex = process.argv.indexOf('--api');
const apiBase = apiArgIndex >= 0 ? process.argv[apiArgIndex + 1] : 'http://localhost:4300';
const gatewayArgIndex = process.argv.indexOf('--gateway');
const gatewayBase =
  gatewayArgIndex >= 0 ? process.argv[gatewayArgIndex + 1] : 'http://127.0.0.1:8100';

checkContainerPortBindings();
checkComposeManifests();
checkInsecureTransport();
checkCorsConfiguration();
checkInfraCredentials();
await checkLiveApi(apiBase);
await checkAiGateway(gatewayBase);

findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

console.warn('\n=== ГЕЙТ СЕТЕВОЙ БЕЗОПАСНОСТИ (RULES.md §3.2) ===\n');
for (const p of passed) console.warn(`  OK       ${p.check.padEnd(18)} ${p.detail}`);
if (findings.length > 0) console.warn('');
for (const f of findings)
  console.warn(`  ${f.severity.padEnd(8)} ${f.check.padEnd(18)} ${f.detail}`);

if (notRun.length > 0) {
  console.warn('');
  for (const n of notRun) console.warn(`  НЕ ВЫПОЛНЕНО ${n.check.padEnd(18)} ${n.detail}`);
}

const blocking = findings.filter((f) => BLOCKING.has(f.severity));
console.warn(
  `\nИтог: ${passed.length} проверок пройдено, ${findings.length} находок ` +
    `(блокирующих CRITICAL/HIGH/MEDIUM: ${blocking.length}), ` +
    `не выполнено: ${notRun.length}.`,
);

// В строгом режиме невыполненная проверка равносильна находке: «мы не знаем»
// не должно выглядеть как «всё хорошо». Обычный режим оставлен для локального
// запуска без поднятых сервисов, но число невыполненных видно всегда.
if (STRICT && notRun.length > 0) {
  console.warn(
    `
Гейт НЕ пройден (строгий режим): ${notRun.length} проверок не выполнено.
`,
  );
  process.exitCode = 1;
} else if (blocking.length > 0) {
  console.warn('Гейт НЕ пройден. Находки чинятся в этой же фазе, до коммита.\n');
  // exitCode вместо process.exit(): принудительный выход при незакрытых
  // сокетах fetch роняет libuv на Windows (UV_HANDLE_CLOSING assertion).
  process.exitCode = 1;
} else {
  console.warn('Гейт пройден.\n');
}
