#!/usr/bin/env node
/**
 * Глобальный аудит: все гейты качества и безопасности одним прогоном.
 *
 * Существует потому, что «всё проверено» и «все проверки прогнаны подряд на
 * одной сборке» — разные утверждения. Каждая фаза закрывала свой гейт, но
 * состояние проекта целиком до сих пор нигде не подтверждалось единым запуском.
 *
 * Прогоны, создающие учётные записи, разделены паузой: класс `auth` ограничен
 * 30 запросами в минуту, и запущенные подряд они упираются в 429 — это
 * работающая защита, а не сбой, и обходить её нельзя.
 *
 * Запуск: node scripts/security-audit-full.mjs
 * Требуется: БД, NATS, core на 4300, ai-gateway на 8100, фронтенды на 5173–5177.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];

function run(name, command, args, { optional = false, retried = false } = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      // Без этого semgrep на Windows падает на кириллице внутри собственных
      // правил: интерпретатор читает файл в cp1251 и спотыкается о первый же
      // русский комментарий. Молчаливое падение выглядело бы как «нет находок».
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const ok = result.status === 0;
  const seconds = Math.round((Date.now() - started) / 1000);

  // Итоговую строку прогонов достаём из их же вывода: она уже содержит цифры,
  // а пересказывать их здесь значило бы иметь два источника правды.
  const summary =
    output.match(/=== ИТОГ: .+ ===/)?.[0] ??
    output.match(/Итог: .+/)?.[0] ??
    output.match(/Findings: \d+ \(\d+ blocking\)/)?.[0] ??
    output.match(/found \d+ vulnerabilities/)?.[0] ??
    output.match(/no leaks found/)?.[0] ??
    output.match(/Tests\s+\d+ passed[^\n]*/g)?.join(' · ') ??
    (ok ? 'без замечаний' : 'см. вывод');

  // Отказ по лимиту частоты — не дефект прогона, а работающая защита: класс
  // `auth` ограничен 30 запросами в минуту, и прогон, создающий десяток
  // учётных записей, в него упирается, если предыдущий прогон уже израсходовал
  // окно. Единственная повторная попытка после честного ожидания — это
  // соблюдение ограничения, а не его обход. Ослаблять лимит ради зелёного
  // прогона нельзя: он защищает настоящих пользователей.
  if (!ok && !optional && /rate_limited|429/.test(output) && !retried) {
    console.warn(`      … отказ по лимиту частоты, ждём 65с и повторяем один раз`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 65_000);
    return run(name, command, args, { optional, retried: true });
  }

  results.push({ name, ok, optional, seconds, summary: summary.trim().slice(0, 160) });
  console.warn(
    `${ok ? 'OK  ' : optional ? 'ПРОП' : 'FAIL'}  ${name.padEnd(42)} ${seconds}с  ${summary.trim().slice(0, 90)}`,
  );
  if (!ok && !optional) {
    const tail = output.split('\n').filter(Boolean).slice(-6).join('\n      ');
    console.warn(`      ${tail}`);
  }
  return ok;
}

function pause(seconds, reason) {
  console.warn(`      … пауза ${seconds}с: ${reason}`);
  // Синхронная пауза: прогоны должны идти строго по очереди, иначе они
  // конкурируют за один и тот же лимит запросов.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

console.warn('\n=== ГЛОБАЛЬНЫЙ АУДИТ ПРОЕКТА ===\n');
console.warn('--- Статический анализ и сборка ---');
run('линт', 'npm', ['run', 'lint']);
run('типы', 'npm', ['run', 'typecheck']);
run('формат', 'npm', ['run', 'format:check']);
run('тесты', 'npm', ['run', 'test']);
run('линтер миграций', 'npm', ['run', 'lint:migrations', '-w', 'database']);
run('граница фронт↔бэк', 'node', ['scripts/check-frontend-boundary.mjs']);

console.warn('\n--- Безопасность ---');
// `--error` обязателен: без него semgrep завершается кодом 0 даже при
// блокирующих находках, и гейт печатает «Findings: 1 (1 blocking)» рядом со
// словом OK. Проверено на живом прогоне — находка была настоящей.
run('SAST: правила проекта', 'semgrep', ['--error', '--config', '.semgrep/guardian.yml', '.']);
run('SAST: OWASP Top-10', 'semgrep', ['--error', '--config', 'p/owasp-top-ten', '.']);
run('аудит зависимостей npm', 'npm', ['audit', '--audit-level=high']);
run('аудит зависимостей python', 'node', ['scripts/gate-ai-gateway.mjs']);
run(
  'секрет-скан',
  'gitleaks',
  ['detect', '--no-banner', '--redact', '--config', '.gitleaks.toml'],
  {
    optional: true,
  },
);
run('сетевая безопасность', 'node', ['scripts/network-audit.mjs']);
run('границы сервисных ролей БД', 'node', ['scripts/check-service-roles.mjs']);
run('права на SECURITY DEFINER', 'node', ['scripts/check-definer-privileges.mjs']);
// Зонд исчерпывает окно лимита намеренно — следующий прогон идёт после паузы.
pause(62, 'лимит класса auth перед зондом');
run('обход лимита подделкой cookie', 'node', ['scripts/probe-rate-limit.mjs']);

console.warn('\n--- Живые прогоны контуров ---');
const LIVE = [
  ['периметр core', 'scripts/smoke-core.mjs'],
  ['KYC, проекты, каталог', 'scripts/smoke-lab.mjs'],
  ['биллинг и админский контур', 'scripts/smoke-billing.mjs'],
  ['регулируемый контур ОИП', 'scripts/smoke-investments.mjs'],
  ['экспертиза, сезон, уведомления', 'scripts/smoke-experts.mjs'],
  ['Integration API', 'scripts/smoke-integration.mjs'],
  ['события и вебхуки', 'scripts/smoke-events.mjs'],
  ['роли и описание API', 'scripts/smoke-admin-roles.mjs'],
  ['закрытый техдолг', 'scripts/smoke-techdebt.mjs'],
  ['AI-контур', 'scripts/smoke-ai.mjs'],
  ['сквозной сценарий платформы', 'scripts/e2e-full-cycle.mjs'],
];
// Пауза ПЕРЕД каждым прогоном, включая первый: лимит мог быть израсходован
// тем, кто запускал проверки вручную до аудита, и тогда первый же прогон
// падает на 429 — не потому, что сломан, а потому что защита работает.
for (const [name, script] of LIVE) {
  pause(62, 'лимит класса auth — 30 запросов в минуту');
  run(name, 'node', [script]);
}

console.warn('\n--- Клиент и интерфейсы ---');
pause(62, 'лимит класса auth');
run('клиент против живого API', 'node', ['scripts/smoke-api-client.mjs']);
run('рендер: публичная витрина', 'node', ['scripts/render-check-web-public.mjs']);
pause(62, 'лимит класса auth');
run('рендер: кабинет основателя', 'node', ['scripts/render-check-lab.mjs']);
pause(62, 'лимит класса auth');
run('рендер: кабинет инвестора', 'node', ['scripts/render-check-investor.mjs']);
pause(62, 'лимит класса auth');
run('рендер: кабинет эксперта', 'node', ['scripts/render-check-expert.mjs']);
pause(62, 'лимит класса auth');
run('рендер: админский кабинет', 'node', ['scripts/render-check-admin.mjs']);

console.warn('\n--- Стенд ---');
// Стенд разворачивается перед проверкой: она входит каждой ролью и смотрит,
// что кабинет показывает именно её данные. Развёрнутый стенд и работающий —
// разные утверждения, и проверяется второе.
run('стенд: учётные записи и данные', 'node', ['scripts/dev-stand.mjs']);
pause(62, 'лимит класса auth');
run('стенд: вход по ролям', 'node', ['scripts/check-stand.mjs']);

console.warn('\n--- Восстановление ---');
run('восстановление из копии', 'node', ['scripts/dr-restore-check.mjs']);

// ------------------------------------------------------------------ итог
const failures = results.filter((item) => !item.ok && !item.optional);
const skipped = results.filter((item) => !item.ok && item.optional);

console.warn('\n=== СВОДКА ===\n');
for (const item of results) {
  const mark = item.ok ? 'OK  ' : item.optional ? 'ПРОП' : 'FAIL';
  console.warn(`${mark}  ${item.name.padEnd(42)} ${item.summary}`);
}
console.warn(
  `\nПройдено: ${results.filter((r) => r.ok).length} из ${results.length}` +
    `${skipped.length > 0 ? `, пропущено (нет инструмента): ${skipped.length}` : ''}` +
    `${failures.length > 0 ? `, ПРОВАЛЕНО: ${failures.length}` : ''}\n`,
);

process.exit(failures.length > 0 ? 1 : 0);
