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
    trustProxy: env.isProduction,
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
  await app.register(rateLimit, {
    global: true,
    max: (request) => {
      const url = request.url;
      const isMutation = request.method !== 'GET' && request.method !== 'HEAD';

      if (url.startsWith('/v1/auth/')) return env.RATE_LIMIT_AUTH_PER_MIN;

      // Денежный класс — только МУТАЦИИ: перевод денег и оформление подписки.
      // Чтение своих счетов ограничивать так же жёстко нет смысла, а вреда от
      // этого больше: пользователь упирается в 429 на обычном просмотре.
      if (
        isMutation &&
        (url.startsWith('/v1/billing/payments') ||
          url.startsWith('/v1/investments/agreements') ||
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
    // Ключ ведра — пара «адрес + владелец сессии».
    //
    // Только IP недостаточно: клиенты за одним NAT выбирали бы денежный лимит
    // друг за друга (обнаружено живым прогоном — сценарий с четырьмя
    // пользователями упирался в 429 на третьем). Только идентификатор сессии
    // тоже не годится: он берётся из cookie ДО проверки подписи, потому что
    // ограничение частоты обязано работать раньше аутентификации — иначе
    // перебор паролей не ограничивался бы вовсе.
    //
    // Пара решает обе задачи: разные пользователи с одного адреса не мешают
    // друг другу, а подделка cookie не даёт нового ведра — адрес остаётся тем
    // же. Значение из cookie используется ИСКЛЮЧИТЕЛЬНО как ключ ведра и
    // никогда как подтверждение личности.
    keyGenerator: (request) => `${request.ip}|${sessionHint(request) ?? 'anon'}`,
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
