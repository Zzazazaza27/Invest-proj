#!/usr/bin/env node
/**
 * Проверка соответствия `@unicorn/api-client` живому серверу.
 *
 * Пакет существует ровно для одного: расхождение сервера с контрактом должно
 * обнаруживаться сразу, а не превращаться в `undefined` в глубине интерфейса.
 * Но сам пакет до Ф10 ни разу не вызывался против запущенного API — и три его
 * метода (`taxonomy` и удалённые с сезонами в 2.1-W05 `currentSeason`,
 * `rating`) не работали вовсе: сервер
 * отдаёт конверт, а клиент ждал голые данные. Нашлось это рендер-проверкой
 * витрины, то есть случайно.
 *
 * Этот прогон закрывает класс дефектов: каждый публичный метод клиента
 * вызывается по-настоящему, а его схема ответа проверяется на фактическом
 * ответе сервера.
 *
 * Запуск: node scripts/smoke-api-client.mjs (нужен core на 4300)
 */
import { UnicornApi } from '../packages/api-client/dist/index.js';
import { randomUUID } from 'node:crypto';

import { API_BASE_URL } from './lib/ports.mjs';

const BASE = process.env.CORE_BASE_URL ?? API_BASE_URL;

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

/** Вызов метода клиента: ошибка схемы — это провал, а не «нет данных». */
async function probe(name, call, assert = () => true) {
  try {
    const result = await call();
    check(name, assert(result), describe(result));
  } catch (error) {
    check(name, false, error instanceof Error ? error.message.slice(0, 160) : String(error));
  }
}

function describe(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `массив[${value.length}]`;
  if (typeof value === 'object') return `{${Object.keys(value).slice(0, 4).join(',')}}`;
  return String(value).slice(0, 40);
}

console.warn('\n=== ПРОВЕРКА КЛИЕНТА ПРОТИВ ЖИВОГО API ===\n');

const api = new UnicornApi({ baseUrl: BASE, auth: { kind: 'none' }, timeoutMs: 10_000 });

console.warn('[1] Публичные методы');
await probe(
  'health',
  () => api.health(),
  (r) => r.service === 'unicorn-launch-core',
);
await probe(
  'taxonomy',
  () => api.taxonomy(),
  (r) => Array.isArray(r),
);
await probe(
  'catalog',
  () => api.catalog({ limit: 3 }),
  (r) => Array.isArray(r.items),
);

// --------------------------------------------------- методы под сессией
console.warn('\n[2] Методы, требующие сессии');
{
  // Публичные методы — половина клиента. Вторая половина работает только под
  // сессией, и именно в ней накопились расхождения: клиент писался по
  // представлению о контракте, а проверить его было нечем.
  const suffix = Date.now() % 1e9;
  const email = `client-probe-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const consents = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
    kind,
    version: 'v1',
    locale: 'ru-RU',
  }));

  let cookies = '';
  let csrf = null;
  const authed = new UnicornApi({
    baseUrl: BASE,
    auth: { kind: 'cookie', csrfToken: null },
    timeoutMs: 10_000,
    // Node не хранит cookie сам: подменяем транспорт, чтобы клиент работал так
    // же, как в браузере, — иначе проверялась бы не та схема аутентификации.
    fetchImpl: async (url, init = {}) => {
      const headers = new Headers(init.headers ?? {});
      if (cookies) headers.set('Cookie', cookies);
      if (csrf) headers.set('X-CSRF-Token', csrf);
      // Сигнал прерывания приходит от самого клиента (init.signal) — он и
      // задаёт таймаут. Здесь добавляем собственный предел на случай, если
      // подменённый транспорт вызовут без него: fetch без таймаута висит вечно.
      const response = await fetch(url, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(15_000),
      });
      const set = response.headers.getSetCookie?.() ?? [];
      if (set.length > 0) cookies = set.map((c) => c.split(';')[0]).join('; ');
      return response;
    },
  });

  await probe(
    'auth.register',
    async () => {
      const session = await authed.auth.register({
        email,
        password,
        displayName: 'Проверка клиента',
        role: 'investor',
        locale: 'ru-RU',
        consents,
      });
      csrf = session.csrfToken ?? null;
      return session;
    },
    (r) => typeof r.userId === 'string' || typeof r.csrfToken === 'string',
  );

  await probe(
    'auth.me',
    () => authed.auth.me(),
    (r) => typeof r.id === 'string' && Array.isArray(r.roles),
  );
  await probe(
    'projects.list',
    () => authed.projects.list(),
    (r) => Array.isArray(r),
  );
  await probe(
    'notifications.list',
    () => authed.notifications.list(),
    (r) => r !== undefined,
  );
  await probe(
    'kyc.status',
    () => authed.kyc.status(),
    (r) => r !== undefined,
  );
  await probe(
    'auth.logout',
    async () => {
      await authed.auth.logout();
      return 'ок';
    },
    (r) => r === 'ок',
  );
}

console.warn('\n[3] Поведение при отказе');
await probe(
  'несуществующий маршрут отвергается ошибкой, а не пустым результатом',
  async () => {
    try {
      await api.http.request({ path: '/no-such-route', schema: undefined });
      return 'ответ получен';
    } catch (error) {
      return `ошибка: ${error.code ?? error.name}`;
    }
  },
  (r) => String(r).startsWith('ошибка'),
);

{
  // Проверяем не гонку «успеет ли ответ за N мс» — на loopback она
  // недетерминирована, — а то, что клиент ВСЕГДА передаёт сигнал прерывания и
  // прерывает зависший запрос. Ответ подменяем на никогда не завершающийся.
  let sawSignal = false;
  const hanging = new UnicornApi({
    baseUrl: BASE,
    auth: { kind: 'none' },
    timeoutMs: 300,
    fetchImpl: (_url, init) => {
      sawSignal = Boolean(init?.signal);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
  });

  const started = Date.now();
  // Гонку с реальной сетью ждать нельзя: страховка на случай, если прерывание
  // не сработает вовсе — иначе прогон повиснет вместо того, чтобы упасть.
  const outcome = await Promise.race([
    hanging
      .health()
      .then(() => 'ответ пришёл — прерывания не было')
      .catch((error) => `прервано за ${Date.now() - started} мс (${error.code ?? error.name})`),
    new Promise((resolve) => setTimeout(() => resolve('ЗАВИСЛО: прерывания не произошло'), 5_000)),
  ]);
  check('зависший запрос прерывается по таймауту', String(outcome).startsWith('прервано'), outcome);
  check('клиент передаёт сигнал прерывания в каждый запрос', sawSignal);
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
