#!/usr/bin/env node
/**
 * Состояние локального стенда: что работает, где и насколько свежее.
 *
 * Отличается от `stand:up --check` тем, что не только стучится по маршрутам,
 * но и объясняет КАЖДУЮ часть: контейнеры, процессы на хосте, собранная
 * статика, единый адрес. Ответ «стенд не работает» без разбивки отправляет
 * искать причину с нуля, а искать обычно приходится одно из четырёх.
 *
 * Ничего не поднимает и не останавливает — только читает.
 *
 * Запуск: npm run stand:status
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { PORTS } from './lib/ports.mjs';
import { commandLine, portOwner } from './lib/stand-processes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const BASE = `http://127.0.0.1${PORTS.web === 80 ? '' : `:${PORTS.web}`}`;

let problems = 0;
const ok = (text) => console.warn(`  ok    ${text}`);
const bad = (text) => {
  problems += 1;
  console.error(`  нет   ${text}`);
};
const info = (text) => console.warn(`  ·     ${text}`);
const step = (text) => console.warn(`\n▸ ${text}`);

function out(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/**
 * То же, но с потоком ошибок.
 *
 * Скрипты проекта печатают человекочитаемый вывод в stderr — так он не мешает
 * тем, кто разбирает stdout машинно. Читать здесь только stdout значило бы
 * получить пустую строку и сказать «определить не удалось» при работающем
 * скрипте.
 */
function outBoth(cmd, args) {
  // Именно spawnSync: execFileSync ВОЗВРАЩАЕТ только stdout, и поток ошибок,
  // даже перехваченный, до вызывающего не доходит. На этом легко решить, что
  // скрипт ничего не напечатал, хотя он напечатал всё.
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

async function probe(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      redirect: 'manual',
    });
    return response.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------- контейнеры
step('Контейнеры');
const names = out('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}'])
  .split('\n')
  .filter(Boolean);
if (names.length === 0) {
  bad('ни одного контейнера — Docker выключен или инфраструктура не поднята');
} else {
  const wanted = ['unicorn-postgres', 'unicorn-redis', 'unicorn-nats', 'unicorn-minio'];
  for (const want of wanted) {
    const row = names.find((n) => n.startsWith(want));
    if (row) ok(row.replace('\t', ' — '));
    else bad(`${want} не работает`);
  }
  const web = names.find((n) => n.startsWith('unicorn-web'));
  if (web) ok(web.replace('\t', ' — '));
  else bad('unicorn-web не работает: единого адреса нет');
}

// -------------------------------------------------------- процессы хоста
step('Процессы на хосте');
for (const [port, name, expect] of [
  [PORTS.core, 'ядро', 'main.js'],
  [PORTS.aiGateway, 'AI-шлюз', 'uvicorn'],
]) {
  const pid = portOwner(port);
  if (!pid) {
    bad(`${name} не слушает :${port}`);
    continue;
  }
  const cmd = commandLine(pid);
  if (expect && !cmd.toLowerCase().includes(expect)) {
    bad(`:${port} занят не нашим процессом (pid ${pid}): ${cmd.slice(0, 60)}`);
  } else {
    ok(`${name} — pid ${pid}, порт ${port}`);
  }
}

// Dev-серверы при работающем едином адресе — дубли, а не польза.
const strays = [
  [PORTS.webPublic, 'витрина'],
  [PORTS.admin, 'админка'],
  [PORTS.lab, 'кабинет основателя'],
  [PORTS.investor, 'кабинет инвестора'],
  [PORTS.expert, 'кабинет эксперта'],
  [PORTS.auth, 'вход'],
]
  .map(([port, name]) => ({ port, name, pid: portOwner(port) }))
  .filter((s) => s.pid);
if (strays.length > 0) {
  console.warn(
    `  прим. работают dev-серверы (${strays.map((s) => `${s.name}:${s.port}`).join(', ')}).`,
  );
  console.warn('        Это ВТОРОЙ стенд из исходников. Остановить: npm run stand:down -- --apps');
}

// ---------------------------------------------------------- собранная статика
step('Собранная статика');
const APPS = ['web-public', 'lab', 'investor', 'expert', 'admin', 'auth', 'console'];
for (const app of APPS) {
  const dir = resolve(ROOT, 'apps', app, 'dist');
  if (!existsSync(dir)) {
    bad(`${app}: dist нет — nginx ответит 404 на этот раздел`);
    continue;
  }
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => statSync(resolve(f.parentPath ?? f.path, f.name)).mtimeMs);
  const newest = files.length > 0 ? Math.max(...files) : 0;
  const ageHours = (Date.now() - newest) / 3_600_000;
  const when = new Date(newest).toLocaleString('ru-RU');
  if (ageHours > 24) info(`${app}: собрано ${when} — старше суток, возможно устарело`);
  else ok(`${app}: собрано ${when}`);
}

// ---------------------------------------------------------------- маршруты
step(`Единый адрес — ${BASE}/`);
/**
 * Служебная консоль анониму отвечает 404: её прячет роль, а не отдельный
 * контур. Ждать от неё 200 значило бы красить рабочий стенд в красный.
 */
const ROUTES = [
  ['/', 200, 'витрина'],
  ['/login/', 200, 'вход'],
  ['/lab/', 200, 'кабинет основателя'],
  ['/investor/', 200, 'кабинет инвестора'],
  ['/expert/', 200, 'кабинет эксперта'],
  ['/admin/', 200, 'админка'],
  ['/console/', 404, 'консоль (анониму 404 — так и надо)'],
  ['/v1/health', 200, 'API ядра'],
];
for (const [route, expected, label] of ROUTES) {
  const code = await probe(route);
  if (code === expected) ok(`${route} → ${code}  ${label}`);
  else bad(`${route} → ${code || 'нет ответа'} (ожидалось ${expected})  ${label}`);
}

// ------------------------------------------------------- демонстрационные данные
step('Демонстрационный комплект');
/**
 * Отдельный шаг, потому что его отсутствие однажды выглядело как поломка
 * входа: стенд отвечал «работает целиком», а учётные записи `demo-*`, по
 * которым владелец им пользуется, в базе не существовали — база
 * пересоздавалась, а комплект никто не перезагрузил. Пароль был верный;
 * не было пользователей.
 */
{
  const status = outBoth(process.execPath, [resolve(ROOT, 'scripts/seed-demo.mjs'), 'status']);
  const accounts = (status.match(/учётных записей:\s*(\d+)\s*из\s*(\d+)/) || []).slice(1);
  const projects = (status.match(/проектов:\s*(\d+)\s*из\s*(\d+)/) || []).slice(1);
  if (accounts.length === 0) {
    info('состояние комплекта определить не удалось (нужна БД)');
  } else if (accounts[0] === accounts[1] && projects[0] === projects[1]) {
    ok(`загружен: учётных записей ${accounts[0]}, проектов ${projects[0]}`);
  } else {
    bad(
      `загружен не полностью: учётных записей ${accounts[0]} из ${accounts[1]}, ` +
        `проектов ${projects[0]} из ${projects[1]} — вход под demo-* не сработает`,
    );
    console.error('        Загрузить: node scripts/seed-demo.mjs load');
  }
}

// --------------------------------------------------------------- режимы
step('Режимы, которые не должны включиться сами');
const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) {
  const text = execFileSync(
    process.execPath,
    ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(envFile)},'utf8'))`],
    { encoding: 'utf8' },
  );
  const value = (key) => (text.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1]?.trim() ?? '';
  const payments = value('PAYMENTS_MODE') || 'test';
  const nodeEnv = value('NODE_ENV') || 'development';
  if (payments === 'test') ok('оплата в тестовом режиме (PAYMENTS_MODE=test)');
  else bad(`PAYMENTS_MODE=${payments} — это НЕ тестовый режим`);
  if (nodeEnv !== 'production') ok(`NODE_ENV=${nodeEnv} — локальный контур`);
  else info('NODE_ENV=production — тестовое подтверждение оплаты будет отклонено');
  // Доставка вебхуков — единственный живой канал наружу: почта локальная,
  // платежи тестовые. «В базе нет рабочих данных» от внешнего вызова не
  // защищает, поэтому режим показывается рядом с остальными границами.
  const webhooks = value('WEBHOOK_DELIVERY_MODE') || 'capture';
  if (webhooks === 'capture') ok('вебхуки наружу не уходят (WEBHOOK_DELIVERY_MODE=capture)');
  else bad(`WEBHOOK_DELIVERY_MODE=${webhooks} — события уходят подписчикам по-настоящему`);
  const mail = value('MAIL_TRANSPORT') || 'none';
  if (mail !== 'smtp') ok(`почта наружу не уходит (MAIL_TRANSPORT=${mail})`);
  else info('MAIL_TRANSPORT=smtp — письма уходят через релей');
} else {
  bad('.env не найден');
}

console.warn(
  problems === 0
    ? `\nСтенд работает целиком: ${BASE}/\n`
    : `\nНе в порядке: ${problems}. Поднять: npm run stand:up\n`,
);
process.exit(problems === 0 ? 0 : 1);
