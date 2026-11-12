/**
 * Контролируемый получатель вебхуков (работа № 3 раздела 01).
 *
 * HTTP-сервер на петле узла. Публичный https-адрес до него даёт подключение на узле (Caddy) —
 * отдельный шаг общей приёмки. Защита ядра от SSRF не обходится: ядро шлёт на обычный
 * публичный адрес, а получатель лишь стоит за ним.
 *
 * Получатель различает адреса по пути (`routes`: имя → путь публичного адреса) и для каждого
 * держит режим ответа:
 *   ok      — 200;
 *   fail    — 503 (отказ получателя);
 *   timeout — не отвечает, пока ядро само не оборвёт запрос;
 *   reset   — обрывает соединение без ответа.
 * Каждый запрос пишется в журнал: имя, режим, Fifth-Event-Id, Fifth-Event-Type, верна ли
 * подпись (секрет адреса задаёт сценарий), отметка подписи, код ответа. Тело и секрет в
 * журнал не попадают.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export const MODES = ['ok', 'fail', 'timeout', 'reset'];

/** Узел назначения «хост:порт» — как у ядра (`destinationOf`, M163): пауза ядра — по нему. */
export function destinationOf(url) {
  const p = new URL(url);
  return `${p.hostname.toLowerCase()}:${p.port === '' ? '443' : p.port}`;
}

/** Подпись как у ядра (`signDelivery`): `t=<сек>,v1=<hex HMAC-SHA256(secret, "t.body")>`. */
export function verifySignature(secret, header, body, toleranceSeconds = 300, nowMs = Date.now()) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header ?? ''));
  if (!m || !secret) return { ok: false, reason: 'нет подписи или секрета' };
  const ts = Number(m[1]);
  if (Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return { ok: false, reason: 'устарела', ts };
  const want = createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest();
  const got = Buffer.from(m[2], 'hex');
  return { ok: got.length === want.length && timingSafeEqual(got, want), ts };
}

/**
 * Запустить получатель. `routes` — { имя: путь }. Возвращает управление: режим и секрет
 * адреса, журнал, адрес прослушивания, остановку.
 */
export async function startReceiver({ host = '127.0.0.1', port = 18444, routes }) {
  const state = {};
  for (const name of Object.keys(routes)) state[name] = { mode: 'ok', secret: null };
  const log = [];
  const hanging = new Set();
  const nameOf = (path) => {
    const clean = path.split('?')[0].replace(/\/+$/, '');
    return Object.keys(routes).find((n) => routes[n].replace(/\/+$/, '') === clean) ?? null;
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const name = nameOf(req.url ?? '');
      const body = Buffer.concat(chunks).toString('utf8');
      const rec = {
        at: new Date().toISOString(),
        name,
        method: req.method,
        eventId: req.headers['fifth-event-id'] ?? null,
        eventType: req.headers['fifth-event-type'] ?? null,
        mode: name ? state[name].mode : null,
        signatureCheck: null,
        status: null,
      };
      log.push(rec);
      if (!name || req.method !== 'POST') {
        rec.status = 404;
        res.writeHead(404).end();
        return;
      }
      const sig = verifySignature(state[name].secret, req.headers['fifth-signature'], body);
      rec.signatureCheck = sig.ok ? 'valid' : `invalid: ${sig.reason ?? 'не сошлась'}`;
      rec.signedAt = sig.ts ?? null;
      switch (state[name].mode) {
        case 'fail':
          rec.status = 503;
          res.writeHead(503, { 'content-type': 'text/plain' }).end('receiver: fail mode');
          break;
        case 'timeout':
          rec.status = 'timeout';
          hanging.add(res);
          res.on('close', () => hanging.delete(res));
          break;
        case 'reset':
          rec.status = 'reset';
          req.socket.destroy();
          break;
        default:
          rec.status = 200;
          res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      }
    });
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, done);
  });

  return {
    address: `http://${host}:${server.address().port}`,
    setMode(name, mode) {
      if (!state[name]) throw new Error(`нет адреса ${name}`);
      if (!MODES.includes(mode)) throw new Error(`нет режима ${mode}`);
      state[name].mode = mode;
      // Переход из timeout: повисшие запросы отпускаются, ядро их уже оборвало.
      if (mode !== 'timeout') for (const r of hanging) r.destroy();
    },
    setSecret(name, secret) {
      state[name].secret = secret;
    },
    log: () => log.slice(),
    close: () =>
      new Promise((done) => {
        for (const r of hanging) r.destroy();
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
