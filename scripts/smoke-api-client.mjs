#!/usr/bin/env node
/**
 * Проверка соответствия `@unicorn/api-client` живому серверу.
 *
 * Пакет существует ровно для одного: расхождение сервера с контрактом должно
 * обнаруживаться сразу, а не превращаться в `undefined` в глубине интерфейса.
 * Но сам пакет до Ф10 ни разу не вызывался против запущенного API — и три его
 * метода (`taxonomy`, `currentSeason`, `rating`) не работали вовсе: сервер
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

const BASE = process.env.CORE_BASE_URL ?? 'http://127.0.0.1:4300/v1';

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
  'pricing',
  () => api.pricing(),
  (r) => Array.isArray(r.plans) && Boolean(r.feeSchedule),
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

let seasonId = null;
await probe(
  'currentSeason',
  async () => {
    const season = await api.currentSeason();
    seasonId = season?.id ?? null;
    return season;
  },
  // null — законный ответ: активного сезона может не быть.
  (r) => r === null || typeof r.number === 'number',
);

if (seasonId) {
  await probe(
    'rating',
    () => api.rating(seasonId),
    (r) => Array.isArray(r),
  );
} else {
  check('rating пропущен: активного сезона нет', true, 'нечего проверять');
}

console.warn('\n[2] Поведение при отказе');
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
      .pricing()
      .then(() => 'ответ пришёл — прерывания не было')
      .catch((error) => `прервано за ${Date.now() - started} мс (${error.code ?? error.name})`),
    new Promise((resolve) => setTimeout(() => resolve('ЗАВИСЛО: прерывания не произошло'), 5_000)),
  ]);
  check('зависший запрос прерывается по таймауту', String(outcome).startsWith('прервано'), outcome);
  check('клиент передаёт сигнал прерывания в каждый запрос', sawSignal);
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
