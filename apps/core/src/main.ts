import 'reflect-metadata';
import { Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { BackgroundJobsService } from './background/background-jobs.service';
import { startInternalServer } from './background/internal-server';
import { runControl } from './background/readiness';
import { Database } from './db/unit-of-work';
import { NatsClient } from './events/nats.client';
import { S3Service } from './storage/s3.service';
import { createShutdown } from './background/shutdown';
import { getEnv } from './config/env';
import { ProblemDetailsFilter, problemCodeOf } from './common/problem.filter';
import { JsonLogger, defaultMeta } from './common/logging/json-logger';
import { safeError } from './common/logging/safe-log';
import { MAX_BODY_BYTES } from './common/validation';
import { getCounters, rateLimitStoreFor } from './cache/counters';
import { registerIpCeiling } from './cache/ip-ceiling';
import { normalizedPath, rateLimitClass } from './common/request-path';

/**
 * Запрет мощных возможностей браузера. Пустой список источников `()` означает
 * «никому, включая собственный документ».
 *
 * Перечень явный, а не `*=()`: подстановочной формы в спецификации нет, и
 * заголовок с ней браузер отбрасывает целиком — то есть защита выглядела бы
 * выставленной, не будучи ею.
 */
/**
 * Внешний идентификатор запроса, пригодный для журнала.
 *
 * Возвращает `null`, если заголовок отсутствует или не проходит формат — тогда
 * вызывающий подставляет собственный. Ограничение двойное:
 *
 *  - **набор символов.** Идентификатор попадает в структурированный журнал и в
 *    поля трассировки. Перевод строки или управляющий символ в нём — это
 *    подделка строки лога чужими руками.
 *  - **длина.** Общий предел размера заголовков ограничивает лишь верхнюю
 *    границу; без своего предела каждая запись журнала раздувается на восемь
 *    килобайт по воле клиента.
 *
 * Шестьдесят четыре символа покрывают UUID, ULID и trace-id OpenTelemetry с
 * запасом — то есть все форматы, которые действительно приходят от прокси.
 */
export function acceptableRequestId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return /^[A-Za-z0-9._:-]{8,64}$/.test(raw) ? raw : null;
}

const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

/**
 * Точка входа.
 *
 * Всё, что здесь настраивается, — периметр: заголовки, CORS, ограничение
 * частоты и размера, cookie. Конфигурация проверяется ДО поднятия слушателя:
 * приложение с небезопасной комбинацией параметров не стартует вовсе.
 */
async function bootstrap(): Promise<void> {
  // Валидация конфигурации до всего остального: в production с AUTH_MODE=local
  // или CORS '*' процесс просто не поднимется.
  const env = getEnv();
  const logger = new Logger('bootstrap');
  // Структурированный журнал (8.4, 2.1-W08b): поля из перечня, маскировка
  // до записи. В тестах журнал выключен, как и раньше.
  const json = new JsonLogger(defaultMeta(env.CORE_ROLE === 'worker' ? 'worker' : 'core'));
  // Авария процесса: текст исключения не пишется (в нём бывают значения),
  // только класс, код и кадры стека; затем выход — как поведение по
  // умолчанию, но без сырого стека в stderr.
  process.on('uncaughtException', (error) => {
    json.record('fatal', 'process', { msg: 'необработанное исключение', ...safeError(error) });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    json.record('fatal', 'process', { msg: 'необработанный отказ промиса', ...safeError(reason) });
    process.exit(1);
  });

  const adapter = new FastifyAdapter({
    bodyLimit: MAX_BODY_BYTES,
    // Идентификатор запроса сквозной: он же попадает в problem+json, в лог и в
    // поля трассировки в БД. Именно поэтому чужой заголовок принимается только
    // в известном формате: раньше он брался как есть, и клиент мог положить в
    // журнал управляющие символы, разорвать строку структурированного лога или
    // раздуть каждую запись до предела размера заголовков (SEC-15). Значение вне
    // формата не отвергает запрос — оно просто заменяется своим.
    genReqId: (req: { headers: Record<string, unknown> }) =>
      acceptableRequestId(req.headers['x-request-id']) ?? randomUUID(),
    // Доверять заголовкам X-Forwarded-* можно ТОЛЬКО конкретным адресам:
    // `true` означает «верить любому», и тогда клиент подменяет свой адрес сам,
    // а вместе с ним — ключ ограничения частоты. Список задаётся конфигурацией;
    // пустой список в production означает «прокси нет», и заголовки
    // игнорируются.
    trustProxy: env.TRUSTED_PROXY_CIDRS === '' ? false : env.TRUSTED_PROXY_CIDRS.split(','),
    // Логгер Fastify не включается: он писал бы url с query. Журнал запросов —
    // хук onResponse ниже, с шаблоном маршрута вместо адреса (8.4).
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: env.isTest ? false : json,
    bufferLogs: true,
  });

  // ---- Журнал запросов (8.4) ---------------------------------------------
  // Метод, ШАБЛОН маршрута (не адрес: в нём query и идентификаторы),
  // статус, длительность, код результата и ID запроса. Отказ внутри 2xx
  // ядро помечает тем же кодом через problemCodeOf, если операция его
  // записала.
  if (!env.isTest) {
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onResponse', (request, reply, done) => {
        const status = reply.statusCode;
        json.record(status >= 500 ? 'error' : 'log', 'http', {
          msg: 'запрос',
          method: request.method,
          route: request.routeOptions.url ?? '(нет маршрута)',
          status,
          durationMs: Math.round(reply.elapsedTime),
          code: problemCodeOf(request),
          result: status >= 500 ? 'error' : status >= 400 ? 'refused' : 'ok',
          requestId: request.id,
        });
        done();
      });
  }

  app.setGlobalPrefix('v1');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: false as never });
  app.useGlobalFilters(new ProblemDetailsFilter());

  // ---- Заголовки безопасности --------------------------------------------
  // API отдаёт только JSON, поэтому CSP максимально закрыт: ничего грузить и
  // исполнять он не должен. frame-ancestors 'none' исключает встраивание.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    xFrameOptions: { action: 'deny' },
    xContentTypeOptions: true,
    // Скрывает X-Powered-By.
    hidePoweredBy: true,
  });

  // ---- CORS ---------------------------------------------------------------
  // Строгий allowlist. Origin, которого нет в списке, не получает заголовков
  // разрешения — не «получает *», а именно не получает.
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        // Запрос без Origin (curl, серверный вызов) не является межсайтовым.
        callback(null, false);
        return;
      }
      callback(null, env.corsOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
      'Idempotency-Key',
      'X-Request-Id',
    ],
    /**
     * `Retry-After` читается браузером только если он назван здесь.
     *
     * По умолчанию межсайтовому JS доступны шесть безопасных заголовков, и
     * этого среди них нет. Кабинет живёт на своём origin, API — на своём;
     * пока заголовок не раскрыт, отказ по частоте приходит без срока, и
     * интерфейсу нечего сказать человеку, кроме «попробуйте позже». Поймано
     * браузерным проходом: за единой точкой входа origin один и проблема не
     * видна, при прямом запуске — видна сразу.
     *
     * Раскрывать безопасно: сколько ждать — не секрет, в отличие от
     * `x-ratelimit-*`, которые остаются выключенными и дальше (они сообщают
     * порог и остаток, то есть помогают подобрать темп перебора).
     */
    exposedHeaders: ['Retry-After'],
    maxAge: 600,
  });

  await app.register(cookie, { hook: 'onRequest' });

  // ---- Ограничение частоты ------------------------------------------------
  // Класс операции определяется по пути: денежные и аутентификационные
  // маршруты жёстче общего лимита (Architect_Launch §7).
  // Общий счётчик. Без него ведро живёт в памяти процесса: два экземпляра
  // считают независимо, и фактически разрешённая частота умножается на их
  // число, а перезапуск обнуляет счётчики (SEC-11). В production переменная
  // обязательна — проверяется конфигурацией, здесь остаётся только громкое
  // предупреждение для локального контура.
  // Одно соединение с Valkey на процесс: им пользуются плагин, потолок по
  // адресу и счётчики входа и писем (4.8).
  const counters = getCounters();
  if (!counters) {
    logger.warn(
      'REDIS_URL не задан: ограничение частоты считается в памяти процесса. ' +
        'Для нескольких экземпляров это означает умножение разрешённой частоты.',
    );
  }

  await app.register(rateLimit, {
    global: true,
    // Ведро считается общим модулем счётчиков, а не собственным скриптом
    // плагина: один контракт операций и одно окно для всех ограничений. Без
    // счётчика остаётся встроенное хранилище в памяти.
    ...(counters ? { store: rateLimitStoreFor(counters) } : {}),
    // Недоступный счётчик НЕ означает «пропускать всё». По умолчанию плагин
    // поступает наоборот: ошибка хранилища — запрос проходит мимо лимита. Для
    // класса auth это ровно то, чего добивается атакующий: уронить счётчик и
    // получить неограниченный перебор паролей.
    //
    // Размен назван прямо: недоступность общего счётчика превращается в отказ
    // в обслуживании, а не в тихое снятие защиты. В production счётчик и так
    // обязателен по конфигурации, то есть является такой же зависимостью, как
    // БД, — а падение БД тоже означает отказ, а не работу «как-нибудь».
    skipOnError: false,
    max: (request) => {
      // Классификация по НОРМАЛИЗОВАННОМУ пути, а не по сырому `request.url`:
      // Fastify маршрутизирует по декодированному пути, поэтому
      // `POST /v1/%61uth/login` доходил до обработчика auth, но `startsWith`
      // по сырому url класс auth не распознавал — применялся default
      // (120/мин вместо 30), в 4 раза ослабляя защиту от перебора пароля
      // (HIGH внешнего аудита №2). То же уводило деньги из 10/мин в общий.
      //
      // Сам классификатор живёт в `common/request-path.ts` и используется ещё
      // и при построении ключа ведра: порог и ведро обязаны определяться ОДНИМ
      // правилом, иначе они расходятся молча.
      const cls = rateLimitClass(normalizedPath(request.url), request.method);
      if (cls === 'auth') return env.RATE_LIMIT_AUTH_PER_MIN;
      if (cls === 'admin') return env.RATE_LIMIT_ADMIN_PER_MIN;
      return env.RATE_LIMIT_DEFAULT_PER_MIN;
    },
    timeWindow: '1 minute',
    // Ключ ведра зависит от класса маршрута — и это не украшение.
    //
    // Прежняя схема «адрес + идентификатор сессии из cookie» имела дыру,
    // подтверждённую прогоном `scripts/probe-rate-limit.mjs`: cookie читается ДО
    // проверки подписи, поэтому произвольный `sub` давал НОВОЕ ведро на каждый
    // запрос. 45 попыток входа с разными поддельными cookie не получили ни
    // одного 429, тогда как те же 45 без cookie получили 15. Комментарий,
    // стоявший здесь раньше, утверждал обратное — и был неверен.
    //
    // Поэтому для чувствительных классов ключ — ТОЛЬКО адрес: подделать его
    // клиент не может (за прокси адрес берётся из доверенной цепочки, см.
    // trustProxy ниже). Плата известна и принята: клиенты за одним NAT делят
    // лимит входа. Для перебора паролей это правильный размен — защита от
    // подбора важнее удобства редкого случая.
    //
    // Правило адресное: только по адресу считаются классы, где запрос НЕ
    // аутентифицирован и подбор — сама угроза. Это вход, регистрация и выдача
    // сервисного токена: там подделка cookie давала злоумышленнику свежий
    // лимит на каждую попытку.
    //
    // Аутентифицированные классы (деньги, админка, регулируемый контур)
    // остаются парой «адрес + подсказка сессии». Причина не в удобстве: их
    // лимит низкий (10/мин у денежного), и общий на адрес он наказывал бы
    // четырёх реальных пользователей за одним NAT — это проверено живым
    // прогоном. Остаточный обход там ограничен тем, что каждый такой запрос
    // всё равно проходит авторизацию: лимит защищает от шторма, а не заменяет
    // проверку прав. Размен назван осознанно и записан в TODO.
    keyGenerator: (request) => {
      // Тот же нормализованный путь и тот же классификатор, что и у порога:
      // иначе percent-encoded auth-запрос попал бы в ветку «адрес + подсказка
      // сессии» и снова получил бы свежее ведро на подделанную cookie.
      const cls = rateLimitClass(normalizedPath(request.url ?? ''), request.method);
      const identity =
        cls === 'auth' ? request.ip : `${request.ip}|${sessionHint(request) ?? 'anon'}`;
      // КЛАСС — часть ключа, и это исправление конкретного дефекта, а не
      // украшение. Плагин держит один счётчик на ключ, а порог считает на
      // каждый запрос: пока класс в ключ не входил, обычные чтения кабинета
      // набивали тот же счётчик, с которым потом сравнивался денежный порог 10.
      // Воспроизведено: одиннадцать обычных чтений, затем ПЕРВОЕ оформление
      // подписки — 429. «Денежный класс 10/мин» означал на
      // деле «любые десять запросов, и деньги закрыты на минуту».
      return `${cls}|${identity}`;
    },
    // Заголовки лимита наружу НЕ выдаются. Они сообщают атакующему точный
    // порог и остаток на каждый класс операций — то есть позволяют подобрать
    // темп перебора, оставаясь под лимитом, и заранее понять, какой маршрут
    // ограничен жёстче (SEC-21, реконнесанс-поверхность). Легитимному клиенту
    // остаётся `retry-after` на отказе: сколько ждать, он узнаёт тогда, когда
    // это ему действительно нужно.
    // Два РАЗНЫХ набора: `addHeadersOnExceeding` управляет обычными ответами,
    // `addHeaders` — ответом 429. Первый из них и выдавал остаток лимита на
    // каждом успешном запросе; выключение только второго ничего не меняло
    // (поймано живой проверкой заголовков, а не чтением документации).
    addHeadersOnExceeding: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
    },
    addHeaders: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
      'retry-after': true,
    },
    errorResponseBuilder: (_request, context) => ({
      type: 'https://unicorn.vc/problems/rate_limited',
      title: 'Слишком много запросов',
      status: 429,
      code: 'rate_limited',
      detail: `Повторите через ${Math.ceil(context.ttl / 1000)} с`,
    }),
  });

  // Потолок по адресу поверх классовых вёдер: закрывает остаточный обход
  // подделкой cookie, который классовый ключ закрыть не может (см.
  // `cache/ip-ceiling.ts`).
  registerIpCeiling(app.getHttpAdapter().getInstance(), counters);

  // Ответы API не кешируются: в них персональные данные.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', async (_req, reply, payload) => {
      void reply.header('Cache-Control', 'no-store');
      void reply.header('Pragma', 'no-cache');
      // Permissions-Policy helmet не выставляет — его не было ни в ответах, ни в
      // списке сетевого гейта, хотя RULES §3.2 требует его явно.
      //
      // API отдаёт только JSON и документов не рендерит, поэтому все мощные
      // возможности браузера здесь запрещены пустым списком источников. Это
      // эшелон защиты на случай, когда ответ всё же оказывается отрендерен —
      // например, при ошибке содержимого или при встраивании через посредника.
      void reply.header('Permissions-Policy', PERMISSIONS_POLICY);
      return payload;
    });

  // Роль `worker` публичного порта не открывает: только фон и служебный порт.
  if (env.CORE_ROLE === 'worker') {
    await app.init();
    logger.log(`core запущен в роли worker (${env.NODE_ENV}), публичный порт закрыт`);
  } else {
    await app.listen(env.CORE_PORT, env.CORE_BIND_HOST);
    logger.log(
      `core слушает ${env.CORE_BIND_HOST}:${env.CORE_PORT} (${env.NODE_ENV}, auth=${env.AUTH_MODE}, role=${env.CORE_ROLE})`,
    );
  }

  const jobs = app.get(BackgroundJobsService);
  const background = BackgroundJobsService.allowedByConfig();
  const db = app.get(Database);
  const s3 = app.get(S3Service);
  const nats = app.get(NatsClient);
  // Состояние процесса для готовности (4.9): «запускается» до конца запуска,
  // «останавливается» — первым шагом завершения.
  let lifecycle: 'starting' | 'running' | 'stopping' = 'starting';
  const internal = await startInternalServer(jobs, {
    lifecycle: () => lifecycle,
    database: () => db.ping(),
    // Хранилище: подписанный HEAD контрольного ключа — доступ и подпись,
    // а не наличие объекта (отсутствующий ключ — тоже ответ хранилища).
    storage: s3.isConfigured
      ? async () => (await s3.headObject('control/ready-probe'), true)
      : null,
    valkey: counters ? () => counters.ping() : null,
    nats: nats.enabled ? () => nats.ping() : null,
    background: () => ({
      required: background.allowed,
      running: jobs.isStarted && !jobs.isStopping,
    }),
    queues: () => db.queueMetrics(),
    control: () =>
      runControl(
        () => db.controlObject('probe'),
        (key) => s3.getObjectDigest(key),
      ),
  });
  logger.log(
    `служебный порт ${env.CORE_INTERNAL_BIND_HOST}:${internal.port} (/live, /ready, /jobs, /queues, /control)`,
  );
  // Фон запускается здесь, а не при инициализации модулей: решение о роли и
  // выключателе принимается до первого прохода, включая стартовые уборки.
  if (background.allowed) jobs.start();
  else logger.warn(`фоновые задачи не запускаются: ${background.reason}`);
  lifecycle = 'running';

  // Общий предел на всё завершение, включая закрытие приложения и пулов.
  const shutdown = createShutdown({
    jobs,
    closers: [
      () => app.close(),
      () => internal.close(),
      // Соединение со счётчиком закрывается явно: иначе процесс держится живым
      // из-за открытого сокета и завершение выглядит зависанием.
      async () => {
        if (counters) await counters.close();
      },
    ],
    graceMs: env.BACKGROUND_STOP_GRACE_MS,
    beforeStop: () => {
      lifecycle = 'stopping';
    },
    exit: (code) => process.exit(code),
    log: (message) => logger.log(message),
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * Непроверенный идентификатор сессии из cookie — только для группировки
 * запросов при ограничении частоты. Подпись здесь НЕ проверяется намеренно:
 * проверка выполняется в guard, а лимит обязан работать и для запросов,
 * которые проверку не пройдут.
 */
function sessionHint(request: { headers: Record<string, unknown> }): string | null {
  const raw = request.headers['cookie'];
  if (typeof raw !== 'string') return null;
  const env = getEnv();
  const match = new RegExp(String.raw`(?:^|;\s*)` + `${env.SESSION_COOKIE_NAME}=([^;]+)`).exec(raw);
  const token = match?.[1];
  if (!token) return null;

  // Форматы отличаются: JWT — header.payload.signature, локальный адаптер —
  // payload.mac. Позицию payload не угадываем, а находим: берём первую часть,
  // которая разбирается в объект с полем sub. Ошибка позиции означала бы, что
  // все анонимные запросы делят одно ведро (именно это и сломало живой прогон).
  for (const part of token.split('.')) {
    try {
      const decoded: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
      const sub = (decoded as { sub?: unknown }).sub;
      if (typeof sub === 'string') return sub.slice(0, 64);
    } catch {
      /* не эта часть */
    }
  }
  return null;
}

void bootstrap().catch((error: unknown) => {
  // Конфигурационная ошибка обязана быть видна целиком: она про запуск, а не
  // про пользовательские данные.
  console.error('Не удалось запустить core:\n', error instanceof Error ? error.message : error);
  process.exit(1);
});
