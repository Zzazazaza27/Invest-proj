/**
 * Единственный источник правды по портам стенда.
 *
 * До этого модуля числа были зашиты в 14 файлов сразу: пять `vite.config.ts`,
 * `docker-compose.yml` и семь скриптов проверки. Любой конфликт портов на
 * машине разработчика (или переезд стенда на другой хост) требовал ручной
 * правки всех четырнадцати, и рассинхрон было видно не сразу, а по странному
 * симптому: браузерный прогон стучится на 5173, а Vite слушает 5273 — и
 * выглядит это как «фронтенд сломался», хотя сломалась синхронизация чисел.
 *
 * Теперь число живёт в `.env` (или берётся из дефолта здесь), а все потребители
 * читают отсюда. Переезд на другой хост — правка одного файла.
 *
 * ВАЖНО про дефолты: здесь стоят ИСХОДНЫЕ порты проекта, а не сдвинутые
 * значения конкретной машины. Дефолт — это то, что получит свежий клон
 * репозитория без `.env`; локальные отклонения живут в `.env` и в git не
 * попадают.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Читает корневой `.env` в `process.env`, не затирая уже заданное окружение.
 *
 * Модуль делает это САМ при импорте, а не полагается на вызов `loadDotEnv()` в
 * скрипте-потребителе: тело импортируемого модуля выполняется раньше первой
 * строки импортирующего, поэтому к моменту вычисления портов переменные должны
 * быть уже на месте. Повторный `loadDotEnv()` в самом скрипте безвреден —
 * присваивание идёт через `??=`.
 */
function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

loadDotEnv();

/**
 * Порт из переменной окружения с проверкой диапазона.
 *
 * Молчаливый откат на дефолт при мусоре в `.env` — это ровно тот случай, когда
 * стенд поднимается «наполовину»: часть потребителей взяла значение из
 * переменной, часть — дефолт, и рассинхрон опять невидим. Поэтому непригодное
 * значение это ошибка запуска, а не повод подставить своё.
 */
function port(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name}=${raw} — не порт (нужно целое 1..65535)`);
  }
  return value;
}

export const PORTS = {
  /**
   * Обратный прокси — единая точка входа стенда.
   *
   * Именно этот адрес открывает человек: витрина, кабинеты и API за одним
   * origin, без номеров портов. Остальные порты ниже — внутренние.
   */
  web: port('WEB_PORT', 80),
  /** Ядро API (NestJS). */
  core: port('CORE_PORT', 4300),

  /** Публичная витрина. */
  webPublic: port('WEB_PUBLIC_PORT', 5173),
  /** Административный кабинет. */
  admin: port('ADMIN_PORT', 5174),
  /** Кабинет основателя. */
  lab: port('LAB_PORT', 5175),
  /** Кабинет инвестора. */
  investor: port('INVESTOR_PORT', 5176),
  /** Служебная консоль разработки и тестирования (в production не публикуется). */
  console: port('CONSOLE_PORT', 5178),
  /** Вход и регистрация — общий экран для всех ролей. */
  auth: port('AUTH_PORT', 5179),

  /** PostgreSQL — порт НА ХОСТЕ (внутри сети контейнеров всегда 5432). */
  postgres: port('POSTGRES_PORT', 5433),
  /** Valkey (общие счётчики, переменные REDIS_*) — порт на хосте; внутри контейнера 6379. */
  redis: port('REDIS_PORT', 6380),
  /** NATS: клиентский порт и порт мониторинга. */
  nats: port('NATS_PORT', 4222),
  natsMonitor: port('NATS_MONITOR_PORT', 8222),
  /** S3 API хранилища (Garage, D-001; прежде MinIO) — петля стенда. */
  s3: port('S3_PORT', 9000),
  /** Garage (D-001): S3 API и admin API первого узла. */
  garageS3: port('GARAGE_S3_PORT', 9000),
  garageAdmin: port('GARAGE_ADMIN_PORT', 3903),
  /** Keycloak (профиль `idp`, поднимается отдельно). */
  keycloak: port('KEYCLOAK_PORT', 8081),
  /** Локальный SMTP-приёмник писем. */
  smtp: port('SMTP_PORT', 1025),
};

/**
 * Адреса фронтендов стенда — то, что открывают в браузере и проверяют прогоны.
 *
 * `basePath` — подпуть, под которым приложение раздаётся ЕДИНОЙ ТОЧКОЙ ВХОДА и
 * с которым оно собрано (`base` в vite.config.ts). Он важен и при прямом
 * запуске dev-сервером: ссылки на ассеты внутри index.html указывают на
 * `/lab/assets/...`, поэтому по корню страница отвечает 200, но остаётся
 * ПУСТОЙ — бандл приходит 404. Проверено рендером, а не рассуждением.
 */
export const FRONTENDS = {
  webPublic: { name: 'витрина', port: PORTS.webPublic, basePath: '/' },
  admin: { name: 'админка', port: PORTS.admin, basePath: '/admin/' },
  lab: { name: 'кабинет основателя', port: PORTS.lab, basePath: '/lab/' },
  investor: { name: 'кабинет инвестора', port: PORTS.investor, basePath: '/investor/' },
  console: { name: 'консоль разработки', port: PORTS.console, basePath: '/console/' },
  auth: { name: 'вход и регистрация', port: PORTS.auth, basePath: '/login/' },
};

/**
 * Базовый адрес фронтенда на локальной машине.
 *
 * Хост фиксирован как `127.0.0.1`, а не `localhost`: для браузера это РАЗНЫЕ
 * origin'ы, и сессионная cookie, поставленная одному, не уходит второму. Все
 * прогоны обязаны ходить по одному и тому же имени.
 */
/**
 * Адрес приложения для браузерных прогонов.
 *
 * По умолчанию — прямой dev-сервер на своём порту. Если задана переменная
 * `UNICORN_ENTRY=web`, все прогоны идут через ЕДИНУЮ ТОЧКУ ВХОДА — тот же
 * адрес, что видит человек.
 *
 * Переключатель один на все проверки не для удобства: на едином адресе
 * страница и API лежат на ОДНОМ origin, и часть поведения там другая —
 * сессионная cookie не делится между портами, изображения не упираются в
 * политику встраивания, CORS вообще не участвует. Проверять продукт надо
 * там, где им пользуются, а не только там, где удобно разработчику.
 */
export function frontendUrl(key) {
  const entry = FRONTENDS[key];
  if (!entry) throw new Error(`неизвестный фронтенд: ${key}`);
  if ((process.env.UNICORN_ENTRY ?? '').toLowerCase() === 'web') return publicUrl(key);
  return `http://127.0.0.1:${entry.port}${entry.basePath}`;
}

/**
 * Адрес приложения за единой точкой входа — то, что видит пользователь.
 * Ни одного номера порта в нём нет.
 */
export function publicUrl(key) {
  const entry = FRONTENDS[key];
  if (!entry) throw new Error(`неизвестный фронтенд: ${key}`);
  const origin = PORTS.web === 80 ? 'http://127.0.0.1' : `http://127.0.0.1:${PORTS.web}`;
  return `${origin}${entry.basePath}`;
}

/**
 * Базовый адрес ядра API (без версии).
 *
 * На едином адресе ядро доступно по тому же origin, что и страницы, — через
 * маршрут `/v1/` в nginx. Прогоны, которые ходят и в браузер, и напрямую в
 * API, обязаны использовать ОДИН origin: иначе cookie, полученная страницей,
 * не уходит в прямой запрос, и проверка падает не там, где сломано.
 */
export const CORE_URL =
  (process.env.UNICORN_ENTRY ?? '').toLowerCase() === 'web'
    ? PORTS.web === 80
      ? 'http://127.0.0.1'
      : `http://127.0.0.1:${PORTS.web}`
    : `http://127.0.0.1:${PORTS.core}`;

/** Базовый адрес API с версией — то, что подставляется фронтендам. */
export const API_BASE_URL = `${CORE_URL}/v1`;
