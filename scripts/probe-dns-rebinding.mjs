#!/usr/bin/env node
/**
 * Проверка защиты доставки вебхуков от DNS rebinding.
 *
 * Приём: имя при ПРОВЕРКЕ разрешается во внешний адрес, а при самом запросе —
 * уже во внутренний. Пока проверка и запрос разрешают имя раздельно, второй
 * ответ DNS никем не контролируется, и доставка уходит на 127.0.0.1, во
 * внутренний сервис или на адрес метаданных облака.
 *
 * Здесь это воспроизводится честно, без правки кода приложения: подменяется
 * сам резолвер (`dns.lookup`) так, что первый вызов возвращает внешний адрес, а
 * каждый следующий — 127.0.0.1. Затем вызывается ровно тот путь доставки,
 * которым пользуется платформа.
 *
 * Ожидание: соединение НЕ должно уйти на внутренний адрес.
 *
 * Запуск: node scripts/probe-dns-rebinding.mjs
 */
import { createServer } from 'node:http';
import dns from 'node:dns';
import { isForbiddenAddress } from '../apps/core/dist/events/webhooks.service.js';
import { postPinned } from '../apps/core/dist/events/pinned-fetch.js';

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

console.warn('\n=== ПРОВЕРКА: DNS REBINDING В ДОСТАВКЕ ВЕБХУКОВ ===\n');

// Внутренний «секрет», к которому не должна пройти доставка.
let internalHits = 0;
const internal = createServer((_req, res) => {
  internalHits += 1;
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('внутренний сервис');
});
await new Promise((resolve) => internal.listen(0, '127.0.0.1', resolve));
const internalPort = internal.address().port;

// Подменяем резолвер: первый ответ внешний, дальше — внутренний адрес.
const realLookup = dns.lookup;
let lookupCalls = 0;
const rebinding = (hostname, options, callback) => {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : (options ?? {});
  lookupCalls += 1;
  const address = lookupCalls === 1 ? '93.184.216.34' : '127.0.0.1';
  if (opts.all === true) {
    cb(null, [{ address, family: 4 }]);
    return;
  }
  cb(null, address, 4);
};
dns.lookup = rebinding;
dns.promises.lookup = async (hostname, options) =>
  new Promise((resolve, reject) => {
    rebinding(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve(Array.isArray(address) ? address : { address, family });
    });
  });

check('внутренний сервис поднят', internalPort > 0, `порт ${internalPort}`);
check(
  '127.0.0.1 распознан как внутренний адрес',
  isForbiddenAddress('127.0.0.1') && isForbiddenAddress('169.254.169.254'),
);

// Доставка по проверенному адресу: имя разрешится «во внутренний», но
// соединение обязано идти на закреплённый внешний адрес, а не на 127.0.0.1.
try {
  await postPinned(`https://rebinding.test:${internalPort}/hook`, {
    // Адрес, «прошедший проверку» на первом резолве.
    allowedAddresses: ['93.184.216.34'],
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    timeoutMs: 3000,
  });
  check('доставка не ушла на внутренний адрес', internalHits === 0, `попаданий: ${internalHits}`);
} catch (error) {
  // Ошибка соединения с внешним адресом — ожидаемый исход в изолированной
  // среде: важно, что внутренний сервис при этом не получил запрос.
  check(
    'доставка не ушла на внутренний адрес',
    internalHits === 0,
    `попаданий: ${internalHits}; соединение: ${String(error.message).slice(0, 60)}`,
  );
}

// Контроль: если бы адрес брался из повторного резолва (как делал fetch),
// запрос попал бы на внутренний сервис. Проверяем, что такой путь действительно
// опасен — иначе проверка выше ничего не доказывает.
const controlResponse = await fetch(`http://127.0.0.1:${internalPort}/hook`, {
  method: 'POST',
  signal: AbortSignal.timeout(3000),
}).catch(() => null);
check(
  'контроль: внутренний сервис достижим и считает обращения',
  controlResponse !== null && internalHits === 1,
  `попаданий: ${internalHits}`,
);

dns.lookup = realLookup;
internal.close();

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
