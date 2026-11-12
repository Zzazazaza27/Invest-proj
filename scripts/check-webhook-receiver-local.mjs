#!/usr/bin/env node
/**
 * Контролируемый получатель вебхука без узла (работа № 3 раздела 01): режимы ответа, подпись
 * в формате ядра, журнал по Fifth-Event-Id; узел назначения сценария совпадает с ядром.
 *
 *   npm run build -w apps/core && node scripts/check-webhook-receiver-local.mjs
 *
 * Подпись и узел назначения берутся у собранного ядра (`apps/core/dist`) — проверка ловит
 * расхождение форматов. Сквозной сценарий с настоящей доставкой — scripts/check-webhook-receiver.mjs
 * на тестовой среде (публичный адрес, без обхода SSRF).
 */
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  destinationOf as libDestinationOf,
  startReceiver,
  verifySignature,
} from './lib/webhook-receiver.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'apps', 'core', 'dist', 'events');
const { signDelivery } = await import(pathToFileURL(join(DIST, 'webhooks.service.js')).href);
const { destinationOf } = await import(pathToFileURL(join(DIST, 'events-health.js')).href);
let failed = 0;
let passed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details && !ok ? ` — ${details}` : ''}`);
};

// Узел назначения сценария (lib) — та же функция, что у ядра.
const local = libDestinationOf;
for (const u of [
  'https://Hook.Example.org/a',
  'https://hook.example.org:8443/b',
  'https://x.example.org:443/c',
]) {
  check(
    `узел назначения как у ядра: ${u}`,
    local(u) === destinationOf(u),
    `${local(u)} / ${destinationOf(u)}`,
  );
}

const r = await startReceiver({ port: 0, routes: { a: '/hook-probe/a', b: '/hook-probe/b' } });
const secret = 'f'.repeat(64);
r.setSecret('a', secret);
r.setSecret('b', secret);
const send = (
  path,
  { eventId = 'e1', sign = true, ts = Math.floor(Date.now() / 1000), timeout = 3000 } = {},
) =>
  new Promise((done) => {
    const payload = JSON.stringify({ id: eventId });
    const u = new URL(r.address + path);
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'fifth-event-id': eventId,
          'fifth-event-type': 'probe.test',
          ...(sign ? { 'fifth-signature': signDelivery(secret, ts, payload) } : {}),
        },
        timeout,
      },
      (res) => {
        res.resume();
        res.on('end', () => done(res.statusCode));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done('timeout');
    });
    req.on('error', (e) => done(`error:${e.code}`));
    req.end(payload);
  });

check('ok — 200', (await send('/hook-probe/a', { eventId: 'e-ok' })) === 200);
r.setMode('a', 'fail');
check('fail — 503', (await send('/hook-probe/a', { eventId: 'e-fail' })) === 503);
check('отказ A не трогает B', (await send('/hook-probe/b', { eventId: 'e-b' })) === 200);
r.setMode('a', 'timeout');
check(
  'timeout — ответа нет до обрыва клиентом',
  (await send('/hook-probe/a', { eventId: 'e-to', timeout: 1500 })) === 'timeout',
);
r.setMode('a', 'reset');
check(
  'reset — соединение оборвано',
  String(await send('/hook-probe/a', { eventId: 'e-rst' })).startsWith('error:'),
);
r.setMode('a', 'ok');
check('неизвестный путь — 404', (await send('/other', { eventId: 'e-x' })) === 404);
await send('/hook-probe/a', { eventId: 'e-nosig', sign: false });
await send('/hook-probe/a', { eventId: 'e-old', ts: Math.floor(Date.now() / 1000) - 1000 });
const log = r.log();
const by = (id) => log.find((x) => x.eventId === id);
check(
  'подпись ядра опознана верной',
  by('e-ok')?.signatureCheck === 'valid' && by('e-fail')?.signatureCheck === 'valid',
);
check('без подписи — неверна', by('e-nosig')?.signatureCheck.startsWith('invalid'));
check('устаревшая подпись — неверна', /устарела/.test(by('e-old')?.signatureCheck ?? ''));
check(
  'журнал: имя адреса, Fifth-Event-Id, режим и итог',
  by('e-fail')?.name === 'a' &&
    by('e-fail')?.mode === 'fail' &&
    by('e-fail')?.status === 503 &&
    by('e-b')?.name === 'b',
);
check(
  'проверка подписи: чужой секрет не проходит',
  !verifySignature('0'.repeat(64), signDelivery(secret, Math.floor(Date.now() / 1000), 'x'), 'x')
    .ok,
);
check(
  'в журнале нет тела и секрета',
  !JSON.stringify(log).includes(secret) && !JSON.stringify(log).includes('"id"'),
);
await r.close();
console.log(`=== ИТОГ: ${passed} OK, ${failed} FAIL ===`);
process.exit(failed ? 1 : 0);
