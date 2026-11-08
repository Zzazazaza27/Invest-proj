#!/usr/bin/env node
/**
 * Приём ошибок интерфейса на стенде (блок 8, 8.4).
 *
 *   FIFTH_ENTRY=web node scripts/probe-client-errors.mjs
 *
 * Настоящий HTTP через ту же точку входа, что у браузера; итог читается из журнала ядра
 * (core.log стенда). Проверяет: запись с полями перечня и пометкой `reported: browser`;
 * секрет в ИМЕНИ неизвестного поля — ни в журнале, ни в ответе; значение вне перечня —
 * 400 без имени поля; чужой Origin и без Origin — 403; размер — 413; лимит с одного
 * адреса — 202 на всё, ровно PER_ADDRESS_LIMIT записей и одна запись об ограничении
 * (ничто раньше приёмника запрос не отклонило).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_BASE_URL, CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(ROOT, 'core.log');
const PER_ADDRESS_LIMIT = 30;
const SECRET = `tok${randomUUID().replace(/-/g, '')}@leak.example`;
const ORIGIN = new URL(CORE_URL).origin;

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  console.warn(`  ${condition ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(LOG)) {
  console.error(`нет ${LOG}: ядро стенда пишет журнал туда (npm run stand:up)`);
  process.exit(2);
}
let offset = statSync(LOG).size;
/** Новые строки журнала с прошлого вызова. */
async function fresh() {
  await sleep(700);
  const text = readFileSync(LOG, 'utf8');
  const chunk = Buffer.from(text).subarray(offset).toString('utf8');
  offset = Buffer.byteLength(text);
  return chunk;
}
const records = (chunk, msg) =>
  chunk
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.msg === msg);

async function send(body, { origin = ORIGIN, raw, extra = {} } = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (origin) headers.Origin = origin;
  const r = await fetch(`${API_BASE_URL}/client-errors`, {
    method: 'POST',
    headers,
    body: raw ?? JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: r.status, text: await r.text() };
}
const base = () => ({
  cabinet: 'lab',
  screen: '/projects/:id',
  version: 'abc1234',
  code: 'js.uncaught',
  stage: 'unknown',
  requestId: randomUUID(),
  viewportWidth: 1280,
  viewportHeight: 720,
  count: 1,
});

console.warn('\n=== ОШИБКИ ИНТЕРФЕЙСА (8.4) ===\n');

console.warn('[1] Обычное сообщение');
const ok = base();
const r1 = await send(ok);
const log1 = records(await fresh(), 'ошибка интерфейса').filter(
  (r) => r.requestId === ok.requestId,
);
check('принято — 202', r1.status === 202, `HTTP ${r1.status}`);
check(
  'в журнале одна запись с полями перечня и пометкой reported: browser',
  log1.length === 1 &&
    log1[0].reported === 'browser' &&
    log1[0].cabinet === 'lab' &&
    log1[0].screen === '/projects/:id' &&
    log1[0].appVersion === 'abc1234' &&
    log1[0].code === 'js.uncaught' &&
    log1[0].viewportWidth === 1280 &&
    log1[0].count === 1 &&
    log1[0].droppedFields === 0,
  JSON.stringify(log1[0] ?? null).slice(0, 200),
);

console.warn('[2] Секрет в имени и значении неизвестного поля');
const leaky = { ...base(), [SECRET]: SECRET, note: SECRET };
const r2 = await send(leaky);
const chunk2 = await fresh();
const log2 = records(chunk2, 'ошибка интерфейса').filter((r) => r.requestId === leaky.requestId);
check('принято — 202, отброшено два поля', r2.status === 202 && log2[0]?.droppedFields === 2);
check(
  'секрета нет ни в журнале, ни в ответе',
  !chunk2.includes(SECRET.slice(3, 20)) && !r2.text.includes(SECRET.slice(3, 20)),
);
check(
  'в записи нет перечня имён отброшенных полей',
  log2.length === 1 && log2[0].dropped === undefined,
);

console.warn('[3] Неверный формат и чужие данные в значении');
const r3 = await send({ ...base(), screen: `/${SECRET}` });
const r3b = await send({ ...base(), count: 0, [SECRET]: 1 });
const r3c = await send(null, { raw: `{"${SECRET}": ` });
const chunk3 = await fresh();
check('экран вне перечня — 400', r3.status === 400, `HTTP ${r3.status}`);
check('неверное число — 400', r3b.status === 400, `HTTP ${r3b.status}`);
check('битый JSON — 400', r3c.status === 400, `HTTP ${r3c.status}`);
check(
  'секрета нет ни в ответах проверки схемы, ни в журнале',
  ![r3.text, r3b.text, r3c.text, chunk3].some((t) => t.includes(SECRET.slice(3, 20))),
);
check('записей ошибки интерфейса нет', records(chunk3, 'ошибка интерфейса').length === 0);

console.warn('[4] Origin и размер');
const r4 = await send(base(), { origin: 'https://evil.example' });
const r4b = await send(base(), { origin: null });
const r4c = await send({ ...base(), padding: 'x'.repeat(3000) });
await fresh();
check('чужой Origin — 403', r4.status === 403, `HTTP ${r4.status}`);
check('без Origin — 403', r4b.status === 403, `HTTP ${r4b.status}`);
check('больше 2 КБ — 413', r4c.status === 413, `HTTP ${r4c.status}`);

console.warn('[5] Ограничение частоты с одного адреса');
// Новое окно: счётчик окна считается по минутам часов ядра (та же машина).
const wait = 60_000 - (Date.now() % 60_000) + 300;
console.warn(`  (ждём начала новой минуты: ${Math.round(wait / 1000)} с)`);
await sleep(wait);
const ids = new Set();
const statuses = [];
for (let i = 0; i < PER_ADDRESS_LIMIT + 6; i += 1) {
  const body = base();
  ids.add(body.requestId);
  statuses.push((await send(body)).status);
}
const chunk5 = await fresh();
const accepted = records(chunk5, 'ошибка интерфейса').filter((r) => ids.has(r.requestId));
const limited = records(chunk5, 'ограничение приёма ошибок интерфейса');
check(
  'все ответы 202 — ничто раньше приёмника не отклонило',
  statuses.every((s) => s === 202),
  [...new Set(statuses)].join(','),
);
check(
  `записано ровно ${PER_ADDRESS_LIMIT}`,
  accepted.length === PER_ADDRESS_LIMIT,
  String(accepted.length),
);
check(
  'одна запись об ограничении (адрес)',
  limited.length === 1 && limited[0].reason === 'address',
  JSON.stringify(limited.map((r) => [r.reason, r.flag])),
);

console.warn('[6] С живой сессией (вкладка вошедшего пользователя)');
// Новая минута: предыдущий шаг исчерпал предел адреса в своём окне.
await sleep(60_000 - (Date.now() % 60_000) + 300);
const reg = await fetch(`${API_BASE_URL}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({
    email: `ce84-${Date.now()}@test.local`,
    password: `Pw-${randomUUID()}`,
    displayName: 'CE84 проба',
    role: 'founder',
    locale: 'ru-RU',
    consents: ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
      kind,
      version: 'v1',
      locale: 'ru-RU',
    })),
  }),
});
const pairs = (reg.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
const csrfPair = pairs.find((p) => /csrf/i.test(p.split('=')[0]));
const cookie = pairs.join('; ');
check(
  'регистрация дала сессию',
  reg.status < 300 && pairs.length >= 2 && Boolean(csrfPair),
  `HTTP ${reg.status}`,
);
const s1 = base();
const r6 = await send(s1, { extra: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } });
const s2 = base();
const r6b = await send(s2, {
  extra: { Cookie: cookie, 'X-CSRF-Token': csrfPair?.split('=').slice(1).join('=') ?? '' },
});
const r6c = await send(base(), { extra: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } });
const log6 = records(await fresh(), 'ошибка интерфейса');
check(
  'сессия без CSRF-заголовка, браузер подтвердил same-origin — 202',
  r6.status === 202,
  `HTTP ${r6.status}`,
);
check('сессия с CSRF-парой — 202', r6b.status === 202, `HTTP ${r6b.status}`);
check('сессия без CSRF с чужого сайта — 403', r6c.status === 403, `HTTP ${r6c.status}`);
check(
  'обе принятые записаны, без ID пользователя',
  log6.filter((r) => r.requestId === s1.requestId || r.requestId === s2.requestId).length === 2 &&
    log6.every((r) => r.userId === undefined),
);

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===`);
process.exit(failed === 0 ? 0 : 1);
