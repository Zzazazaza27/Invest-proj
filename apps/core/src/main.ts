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
import { getEnv } from './config/env';
import { ProblemDetailsFilter } from './common/problem.filter';
import { MAX_BODY_BYTES } from './common/validation';
import { createRateLimitRedis } from './cache/redis.client';

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

  const adapter = new FastifyAdapter({
    bodyLimit: MAX_BODY_BYTES,
    // Идентификатор запроса сквозной: он же попадает в problem+json и в лог.
    genReqId: (req: { headers: Record<string, unknown> }) =>
      (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    // Доверять заголовкам X-Forwarded-* можно ТОЛЬКО конкретным адресам:
    // `true` означает «верить любому», и тогда клиент подменяет свой адрес сам,
    // а вместе с ним — ключ ограничения частоты. Список задаётся конфигурацией;
    // пустой список в production означает «прокси нет», и заголовки
    // игнорируются.
    trustProxy: env.TRUSTED_PROXY_CIDRS === '' ? false : env.TRUSTED_PROXY_CIDRS.split(','),
    // Скрывает заголовок, раскрывающий стек.
    disableRequestLogging: false,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: env.isTest ? false : ['error', 'warn', 'log'],
    bufferLogs: true,
  });

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
  const rateLimitRedis = createRateLimitRedis();
  if (!rateLimitRedis) {
    logger.warn(
      'REDIS_URL не задан: ограничение частоты считается в памяти процесса. ' +
        'Для нескольких экземпляров это означает умножение разрешённой частоты.',
    );
  }

  await app.register(rateLimit, {
    global: true,
    // Плагин сам ведёт ключи и срок жизни ведра в Redis; при `null` остаётся
    // встроенное хранилище в памяти.
    ...(rateLimitRedis ? { redis: rateLimitRedis } : {}),
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
      const url = request.url;
      const isMutation = request.method !== 'GET' && request.method !== 'HEAD';

      // Выдача токена — тот же класс, что и вход человека: это проверка
      // секрета, и перебор по ней ограничивается так же жёстко.
      if (url.startsWith('/v1/auth/') || url.startsWith('/v1/integration/token')) {
        return env.RATE_LIMIT_AUTH_PER_MIN;
      }

      // Денежный класс — только МУТАЦИИ: перевод денег и оформление подписки.
      // Чтение своих счетов ограничивать так же жёстко нет смысла, а вреда от
      // этого больше: пользователь упирается в 429 на обычном просмотре.
      if (
        isMutation &&
        (url.startsWith('/v1/billing/payments') ||
          url.startsWith('/v1/investments/agreements') ||
          // Подтверждение транша создаёт начисление вознаграждения — это
          // денежная мутация, даже если её инициирует оператор, а не клиент.
          url.startsWith('/v1/investments/tranches') ||
          url.startsWith('/v1/billing/subscriptions'))
      ) {
        return env.RATE_LIMIT_MONEY_PER_MIN;
      }

      // Административный класс. Операции с тарифами и персональными ценами
      // чувствительны, поэтому лимит ниже общего, но выше денежного: оператор
      // за минуту делает и просмотры, и несколько изменений подряд.
      if (url.startsWith('/v1/admin/')) return env.RATE_LIMIT_ADMIN_PER_MIN;

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
      const url = request.url ?? '';
      const unauthenticated =
        url.startsWith('/v1/auth/') || url.startsWith('/v1/integration/token');
      return unauthenticated ? request.ip : `${request.ip}|${sessionHint(request) ?? 'anon'}`;
    },
    errorResponseBuilder: (_request, context) => ({
      type: 'https://unicorn.vc/problems/rate_limited',
      title: 'Слишком много запросов',
      status: 429,
      code: 'rate_limited',
      detail: `Повторите через ${Math.ceil(context.ttl / 1000)} с`,
    }),
  });

  // Ответы API не кешируются: в них персональные данные.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', async (_req, reply, payload) => {
      void reply.header('Cache-Control', 'no-store');
      void reply.header('Pragma', 'no-cache');
      return payload;
    });

  await app.listen(env.CORE_PORT, env.CORE_BIND_HOST);
  logger.log(
    `core слушает ${env.CORE_BIND_HOST}:${env.CORE_PORT} (${env.NODE_ENV}, auth=${env.AUTH_MODE})`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`получен ${signal}, завершаем приём запросов`);
    await app.close();
    // Соединение со счётчиком закрывается явно: иначе процесс держится живым
    // из-за открытого сокета и завершение выглядит зависанием.
    if (rateLimitRedis) await rateLimitRedis.quit().catch(() => undefined);
    process.exit(0);
  };
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
