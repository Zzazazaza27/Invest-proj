#!/usr/bin/env node
/**
 * Отказ и восстановление контролируемого получателя вебхука (работа № 3 раздела 01; W17).
 * Запускается на узле тестовой среды (по умолчанию test-1), под root: `fifth-test op
 * prod-webhook-receiver test-1`.
 *
 *   HOOK_RECEIVER_URL_A=https://… HOOK_RECEIVER_URL_B=https://… \
 *     node scripts/check-webhook-receiver.mjs --env test-1 [--mode fail|timeout|reset]
 *
 * Настройки:
 *   HOOK_RECEIVER_URL_A, HOOK_RECEIVER_URL_B — публичные https-адреса двух получателей, разные
 *     узлы назначения (хост:порт): пауза ядра — по узлу; одинаковые — отказ;
 *   HOOK_RECEIVER_LISTEN — где слушает получатель на узле (127.0.0.1:18444).
 * Подключение публичных адресов к получателю (Caddy) — отдельный шаг общей приёмки; без него
 * сценарий останавливается на первой проверке. Защита ядра от SSRF не обходится: ядро шлёт
 * обычной доставкой на публичный адрес, адреса подписок проходят его же проверку.
 *
 * Ход:
 *   1. получатель запущен, оба адреса доходят до него из контейнера ядра;
 *   2. подписки A и B (служебная учётная запись, секреты шифрует ядро среды);
 *   3. A отказывает: одна доставка расходует попытку, узел A на паузе, прочие доставки A ждут
 *      без попыток; B в это время получает свои — отказ одного не мешает другому;
 *   4. по истечении паузы — одна проба; её отказ удваивает паузу;
 *   5. A восстановлен: следующая проба проходит, пауза снята, остальные доставки A уходят;
 *   6. повтор несёт тот же Fifth-Event-Id, подпись верна, каждое событие принято один раз.
 * Отчёт с отметками UTC — out/webhook-receiver/<среда>-<время>.json. Секреты не печатаются.
 * Созданное (учётная запись, подписки, доставки, узлы) удаляется; события-носители остаются
 * опубликованными записями журнала.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { destinationOf, startReceiver } from './lib/webhook-receiver.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const envId = opt('--env', 'test-1');
const failMode = opt('--mode', 'fail');
if (!/^[a-z0-9-]{1,40}$/.test(envId) || envId === 'prod') {
  console.error('нужна тестовая среда (--env test-1); prod этим сценарием не проверяется');
  process.exit(2);
}
if (!['fail', 'timeout', 'reset'].includes(failMode)) {
  console.error('--mode: fail, timeout или reset');
  process.exit(2);
}

const report = {
  env: envId,
  failMode,
  startedAt: new Date().toISOString(),
  marks: {},
  checks: [],
  notes: [],
};
let failed = 0;
const check = (name, ok, details = '') => {
  report.checks.push({
    at: new Date().toISOString(),
    name,
    ok: Boolean(ok),
    details: String(details).slice(0, 500),
  });
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
  return Boolean(ok);
};
const note = (s) => {
  report.notes.push(s);
  console.log(`  ·     ${s}`);
};
const mark = (k) => (report.marks[k] = new Date().toISOString());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- среда узла
const ENV_DIR = join(ROOT, '.local', 'envs', envId);
// пароль читается из файла среды, литерала нет.
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
const pgPassword = readFileSync(join(ENV_DIR, 'secrets', 'POSTGRES_PASSWORD'), 'utf8').trim();
const routeFile = join(ENV_DIR, 'release', 'core-route.json');
const CORE =
  existsSync(routeFile) && JSON.parse(readFileSync(routeFile, 'utf8')).slot === 'core-b'
    ? `fifth-${envId}-core-b`
    : `fifth-${envId}-core`;
const PG = `fifth-${envId}-postgres`;

function sql(text) {
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      PG,
      'psql',
      '-X',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-U',
      'fifth_owner',
      '-d',
      'fifth_element',
    ],
    { input: text, encoding: 'utf8', env: { ...process.env, PGPASSWORD: pgPassword } },
  );
  if (r.status !== 0) throw new Error(`SQL: ${(r.stderr || '').trim().split('\n')[0]}`);
  return r.stdout.trim();
}
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
function inCore(args, input) {
  const r = spawnSync('docker', ['exec', '-i', CORE, ...args], { input, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
/**
 * То же без блокировки: получатель работает в этом процессе, и вызов, который сам ждёт ответа
 * получателя (проба адреса из ядра), через spawnSync замораживал его — тайм-аут (13.11, test-1).
 */
function inCoreAsync(args) {
  return new Promise((done) => {
    const p = spawn('docker', ['exec', '-i', CORE, ...args]);
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('close', (code) => done({ ok: code === 0, out: out.trim() }));
  });
}
const coreEnv = (name, d) => {
  const v = inCore(['printenv', name]).out;
  return v === '' ? d : Number(v);
};

// ------------------------------------------------------------- настройки
const URL_A = process.env.HOOK_RECEIVER_URL_A ?? '';
const URL_B = process.env.HOOK_RECEIVER_URL_B ?? '';
const [lhost, lport] = (process.env.HOOK_RECEIVER_LISTEN || '127.0.0.1:18444').split(':');
let receiver;
const created = { account: null, endpoints: [], destinations: [] };

try {
  if (!/^https:\/\//.test(URL_A) || !/^https:\/\//.test(URL_B)) {
    throw new Error('нужны HOOK_RECEIVER_URL_A и HOOK_RECEIVER_URL_B — публичные https-адреса');
  }
  const DEST = { a: destinationOf(URL_A), b: destinationOf(URL_B) };
  if (DEST.a === DEST.b)
    throw new Error(
      `адреса A и B — один узел назначения ${DEST.a}: пауза ядра общая, сценарий не различит`,
    );
  created.destinations = [DEST.a, DEST.b];
  const PAUSE = coreEnv('WEBHOOK_DESTINATION_PAUSE_S', 30);
  const POLL = coreEnv('WEBHOOK_POLL_INTERVAL_MS', 2000);
  const TIMEOUT = coreEnv('WEBHOOK_TIMEOUT_MS', 5000);
  report.settings = {
    core: CORE,
    destinations: DEST,
    pauseSeconds: PAUSE,
    pollMs: POLL,
    timeoutMs: TIMEOUT,
  };

  // ------------------------------------------------------- 1. получатель
  console.log('\n▸ 1. получатель и подключение');
  receiver = await startReceiver({
    host: lhost,
    port: Number(lport),
    routes: { a: new URL(URL_A).pathname, b: new URL(URL_B).pathname },
  });
  const live = inCore(['printenv', 'WEBHOOK_DELIVERY_MODE']).out;
  check('доставка среды — live', live === 'live', live || '(не задано: capture)');
  // Тем же путём, что доставка: из контейнера ядра на публичный адрес (GET — получатель
  // отвечает 404 и пишет запрос; доставкой это не считается).
  for (const [n, u] of [
    ['a', URL_A],
    ['b', URL_B],
  ]) {
    const r = await inCoreAsync([
      'node',
      '-e',
      `fetch(${JSON.stringify(u)},{signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status)).catch(e=>console.log('ERR '+(e.cause?.code||e.name)))`,
    ]);
    const reached = receiver.log().some((x) => x.name === n && x.method === 'GET');
    check(
      `адрес ${n.toUpperCase()} из контейнера ядра доходит до получателя`,
      reached,
      `ответ ${r.out}`,
    );
    if (!reached)
      throw new Error('подключение получателя на узле не выполнено — сценарий остановлен');
  }

  // ------------------------------------------------------- 2. подписки
  console.log('\n▸ 2. подписки A и B');
  sql(
    `DELETE FROM integration.webhook_destinations WHERE destination IN (${q(DEST.a)}, ${q(DEST.b)})`,
  );
  const suffix = Date.now().toString(36);
  const admin = sql('SELECT id FROM identity.users ORDER BY created_at LIMIT 1');
  const fakeHash = `$argon2id$v=19$m=65536,t=3,p=4$${randomBytes(16).toString('base64')}$${randomBytes(32).toString('base64')}`;
  created.account = sql(
    `INSERT INTO integration.service_accounts (id, client_id, name, client_secret_hash, mtls_cert_fingerprint, scopes, status, created_by)
     VALUES (public.uuid_generate_v7(), ${q(`hook-check-${suffix}`)}, ${q(`hook-check-${suffix}`)}, ${q(fakeHash)}, ${q(randomBytes(32).toString('hex'))}, ARRAY['webhooks:manage'], 'active', ${q(admin)}) RETURNING id`,
  ).split('\n')[0];
  const VERB = sql('SELECT verb FROM audit.event_type_registry ORDER BY verb LIMIT 1');
  const endpoint = {};
  for (const [n, u] of [
    ['a', URL_A],
    ['b', URL_B],
  ]) {
    const secret = randomBytes(32).toString('hex');
    const sealed = inCore(
      [
        'node',
        '-e',
        "require('reflect-metadata');const {CryptoService}=require('/app/apps/core/dist/crypto/crypto.service.js');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>new CryptoService().sealDirect('webhook_secrets',s,'webhook:signing').then(b=>console.log(b.toString('hex'))))",
      ],
      secret,
    )
      .out.split('\n')
      .pop();
    if (!/^[0-9a-f]+$/.test(sealed)) throw new Error('ядро не зашифровало секрет подписки');
    endpoint[n] = sql(
      `INSERT INTO integration.webhook_endpoints (id, service_account_id, url, subscribed_verbs, secret_ciphertext, secret_kms_key_id, secret_fingerprint, status)
       VALUES (public.uuid_generate_v7(), ${q(created.account)}, ${q(u)}, ARRAY[${q(VERB)}], decode(${q(sealed)}, 'hex'), 'hook-check', sha256(${q(secret)}::bytea), 'active') RETURNING id`,
    ).split('\n')[0];
    created.endpoints.push(endpoint[n]);
    receiver.setSecret(n, secret);
  }
  check(
    'подписки A и B заведены, секреты зашифрованы ядром среды',
    Boolean(endpoint.a && endpoint.b),
  );

  // Событие — только носитель доставки: сразу опубликовано и разослано (издатель его не берёт).
  const deliver = (n) => {
    const ev = sql(
      `INSERT INTO audit.outbox_events (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_jsonb, nats_subject, schema_version, message_key, published_at, fanout_completed_at)
       VALUES (public.uuid_generate_v7(), 'project', public.uuid_generate_v7(), 1, ${q(VERB)}, '{"check":"hook-receiver"}'::jsonb, ${q(VERB)}, 1, ${q(`hook-check-${randomUUID()}`)}, now(), now()) RETURNING id`,
    ).split('\n')[0];
    const d = sql(
      `INSERT INTO integration.webhook_deliveries (id, endpoint_id, event_id, status) VALUES (public.uuid_generate_v7(), ${q(endpoint[n])}, ${q(ev)}, 'queued') RETURNING id`,
    ).split('\n')[0];
    return { event: ev, delivery: d, name: n };
  };
  const deliveries = () =>
    sql(
      `SELECT json_agg(json_build_object('id', d.id, 'event', d.event_id, 'status', d.status, 'attempts', d.attempts) ORDER BY d.created_at)
         FROM integration.webhook_deliveries d WHERE d.endpoint_id IN (${created.endpoints.map(q).join(',')})`,
    );
  const destination = (dest) =>
    JSON.parse(
      sql(
        `SELECT coalesce((SELECT json_build_object('failures', failures, 'pause', pause_seconds, 'pausedFor', extract(epoch FROM paused_until - now()), 'kind', last_failure_kind)
           FROM integration.webhook_destinations WHERE destination = ${q(dest)}), 'null')`,
      ),
    );
  const hits = (n, filter = () => true) =>
    receiver.log().filter((x) => x.name === n && x.method === 'POST' && filter(x));

  // ------------------------------------------------------- 3. отказ A
  console.log(`\n▸ 3. A отказывает (${failMode}), B работает`);
  receiver.setMode('a', failMode);
  mark('failureStart');
  const A = [deliver('a'), deliver('a'), deliver('a')];
  const B = [deliver('b'), deliver('b')];
  const waitMs = POLL * 3 + (failMode === 'timeout' ? TIMEOUT : 0) + 15_000;
  let t0 = Date.now();
  while (
    Date.now() - t0 < waitMs &&
    !(hits('a').length >= 1 && hits('b', (x) => x.status === 200).length >= 2)
  )
    await sleep(500);
  mark('failureDetected');
  const dA = destination(DEST.a);
  check(
    'B получил свои события, пока A отказывает',
    hits('b', (x) => x.status === 200).length === 2,
    `${hits('b').length} запросов`,
  );
  check('A получил ровно один запрос до паузы', hits('a').length === 1, `${hits('a').length}`);
  check('узел A на паузе', dA && dA.pausedFor > 0, JSON.stringify(dA));
  let rows = JSON.parse(deliveries());
  const aRows = rows.filter((r) => A.some((x) => x.delivery === r.id));
  check(
    'попытку расходует одна доставка A, остальные ждут без попыток',
    aRows.filter((r) => r.attempts === 1).length === 1 &&
      aRows.filter((r) => r.attempts === 0).length === 2,
    JSON.stringify(aRows.map((r) => r.attempts)),
  );

  // ------------------------------------------------------- 4. проба при отказе
  console.log('\n▸ 4. по истечении паузы — одна проба, её отказ удваивает паузу');
  const firstPause = dA.pause;
  await sleep(
    Math.max(0, dA.pausedFor * 1000) + POLL * 2 + (failMode === 'timeout' ? TIMEOUT : 0) + 3000,
  );
  const afterProbe = destination(DEST.a);
  mark('probeFailed');
  check(
    'за паузу и пробу — ровно одна проба A',
    hits('a').length === 2,
    `${hits('a').length} запросов`,
  );
  check(
    'отказ пробы удвоил паузу',
    afterProbe?.pause ===
      Math.min(firstPause * 2, coreEnv('WEBHOOK_DESTINATION_PAUSE_MAX_S', 3600)),
    `${firstPause} → ${afterProbe?.pause}`,
  );
  rows = JSON.parse(deliveries());
  check(
    'попытки расходуют только запросы, ушедшие получателю',
    rows.filter((r) => A.some((x) => x.delivery === r.id)).reduce((s, r) => s + r.attempts, 0) ===
      2,
    JSON.stringify(rows.map((r) => r.attempts)),
  );

  // ------------------------------------------------------- 5. восстановление
  console.log('\n▸ 5. A восстановлен');
  receiver.setMode('a', 'ok');
  mark('receiverRestored');
  t0 = Date.now();
  const limit = (afterProbe.pausedFor + 60) * 1000;
  while (Date.now() - t0 < limit && hits('a', (x) => x.status === 200).length < 3)
    await sleep(1000);
  mark('allDelivered');
  const firstOk = hits('a', (x) => x.status === 200)[0];
  if (firstOk) report.marks.serviceReturn = firstOk.at;
  rows = JSON.parse(deliveries());
  check(
    'все доставки A и B доставлены',
    rows.every((r) => r.status === 'delivered'),
    JSON.stringify(rows.map((r) => r.status)),
  );
  const dAfter = destination(DEST.a);
  check('пауза узла A снята', !dAfter || dAfter.pausedFor <= 0, JSON.stringify(dAfter));

  // ------------------------------------------------------- 6. свойства доставки
  console.log('\n▸ 6. Fifth-Event-Id, подпись, без дублей');
  const all = [...A, ...B];
  const posted = receiver.log().filter((x) => x.method === 'POST' && x.name);
  check(
    'каждый запрос несёт Fifth-Event-Id своего события',
    posted.every((x) => all.some((d) => d.event === x.eventId && d.name === x.name)),
  );
  const retried = A.find((d) => hits('a', (x) => x.eventId === d.event).length >= 2);
  check(
    'повтор после отказа — тот же Fifth-Event-Id',
    Boolean(retried) && hits('a', (x) => x.eventId === retried.event).some((x) => x.status === 200),
    retried
      ? `${hits('a', (x) => x.eventId === retried.event).length} запросов одного события`
      : 'повтора нет',
  );
  check(
    'подпись верна на всех запросах',
    posted.every((x) => x.signatureCheck === 'valid'),
    posted
      .filter((x) => x.signatureCheck !== 'valid')
      .map((x) => x.signatureCheck)
      .join('; '),
  );
  const dup = all.filter(
    (d) => posted.filter((x) => x.eventId === d.event && x.status === 200).length !== 1,
  );
  check(
    'каждое событие принято получателем ровно один раз',
    dup.length === 0,
    `${dup.length} с повтором или без приёма`,
  );
  check(
    'отказ A не дал B ни одного лишнего запроса',
    hits('b').length === 2,
    `${hits('b').length}`,
  );
  report.timeline = posted.map((x) => ({
    at: x.at,
    name: x.name,
    event: x.eventId,
    status: x.status,
  }));
} catch (e) {
  failed += 1;
  report.error = String(e.message ?? e);
  console.error(`\nСЦЕНАРИЙ ОСТАНОВЛЕН: ${report.error}`);
} finally {
  try {
    if (created.endpoints.length) {
      sql(
        `DELETE FROM integration.webhook_deliveries WHERE endpoint_id IN (${created.endpoints.map(q).join(',')})`,
      );
      sql(
        `DELETE FROM integration.webhook_endpoints WHERE id IN (${created.endpoints.map(q).join(',')})`,
      );
    }
    if (created.destinations.length)
      sql(
        `DELETE FROM integration.webhook_destinations WHERE destination IN (${created.destinations.map(q).join(',')})`,
      );
    if (created.account)
      sql(`DELETE FROM integration.service_accounts WHERE id = ${q(created.account)}`);
  } catch (e) {
    note(`уборка неполна: ${e.message}`);
  }
  await receiver?.close();
  report.finishedAt = new Date().toISOString();
  report.failed = failed;
  report.passed = report.checks.filter((c) => c.ok).length;
  const out = join(ROOT, 'out', 'webhook-receiver');
  mkdirSync(out, { recursive: true });
  const file = join(out, `${envId}-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nотчёт: ${file}\n=== ИТОГ: ${report.passed} OK, ${failed} FAIL ===`);
  process.exit(failed ? 1 : 0);
}
