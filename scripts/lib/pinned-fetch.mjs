/**
 * Запрос к публичному адресу с закреплённым IP (замечание Тэнка 2026-11-02:
 * выпуск во время отказа DNS).
 *
 * PUBLIC_PIN="5espace.com=193.233.217.210,files.5espace.com=193.233.217.210"
 * — для перечисленных имён соединение идёт на заданный IP, минуя DNS. Адрес в
 * URL не меняется, поэтому Host и SNI остаются именем, а сертификат
 * проверяется по имени, как обычно. Без PUBLIC_PIN — обычный fetch.
 *
 * Успех по закреплённому IP подтверждает сервер, а не доступность по имени:
 * вызывающий код обязан помечать такой результат (pinned() → true).
 *
 *   node scripts/lib/pinned-fetch.mjs --status <url>   код ответа (0 — нет ответа)
 */
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

export function parsePins(spec = process.env.PUBLIC_PIN || '') {
  const pins = new Map();
  for (const part of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [host, ip] = part.split('=').map((s) => s.trim());
    if (!host || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip ?? ''))
      throw new Error(`PUBLIC_PIN: неверная пара «${part}» (нужно имя=IPv4)`);
    pins.set(host.toLowerCase(), ip);
  }
  return pins;
}

/** Закреплён ли IP для имени из url. */
export const pinned = (url, pins = parsePins()) => pins.has(new URL(url).hostname.toLowerCase());

/**
 * fetch-совместимый вызов: с закреплённым IP — через http(s).request с
 * подменой lookup; иначе — глобальный fetch. Переадресации не выполняются
 * (как redirect: 'manual').
 */
export function pinnedFetch(url, init = {}, pins = parsePins()) {
  const u = new URL(url);
  const ip = pins.get(u.hostname.toLowerCase());
  if (!ip) return fetch(url, init);
  const lib = u.protocol === 'https:' ? https : http;
  const lookup = (_host, opts, cb) =>
    opts && opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      { method: init.method || 'GET', headers: init.headers || {}, lookup },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers))
            for (const one of Array.isArray(v) ? v : [v])
              if (v !== undefined) headers.append(k, one);
          const status = res.statusCode;
          const body = [101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, headers }));
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (init.signal) {
      if (init.signal.aborted) req.destroy(new Error('прервано'));
      init.signal.addEventListener('abort', () => req.destroy(new Error('таймаут')), {
        once: true,
      });
    }
    if (init.body) req.write(init.body);
    req.end();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--status');
  const url = process.argv[i + 1];
  pinnedFetch(url, { signal: AbortSignal.timeout(15_000) })
    .then((r) => process.stdout.write(String(r.status)))
    .catch(() => process.stdout.write('0'));
}
