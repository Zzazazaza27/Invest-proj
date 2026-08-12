import { z } from 'zod';

/**
 * Конфигурация приложения. Fail-closed: отсутствие обязательной переменной —
 * падение на старте, а не «поработаем как-нибудь».
 *
 * Отдельно проверяются комбинации, опасные именно в production: локальный
 * адаптер аутентификации, локальный KMS, CORS без allowlist.
 */

const NonEmpty = z.string().min(1);

const Base64Key32 = z.string().refine((v) => {
  try {
    return Buffer.from(v, 'base64').length === 32;
  } catch {
    return false;
  }
}, 'ожидается 32 байта в base64');

const RawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  CORE_PORT: z.coerce.number().int().min(1).max(65535).default(4300),
  // Дефолт — loopback. В контейнере требуется 0.0.0.0, но там границей
  // изоляции служит сама сеть контейнера, а не адрес привязки (RULES.md §3.2).
  CORE_BIND_HOST: z.string().default('127.0.0.1'),
  CORE_PUBLIC_URL: z.url().default('http://localhost:4300'),
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  /**
   * Адреса прокси, чьим заголовкам `X-Forwarded-*` разрешено верить.
   *
   * Через запятую, в форме адреса или CIDR. Пусто — прокси нет, заголовки
   * игнорируются и адрес клиента берётся из соединения. Значение `true` здесь
   * невозможно намеренно: «доверять любому» означает, что клиент подменяет
   * собственный адрес, а вместе с ним — ключ ограничения частоты.
   */
  TRUSTED_PROXY_CIDRS: z.string().default(''),

  DATABASE_URL: NonEmpty,
  /**
   * Отдельное подключение регулируемого контура (логин-роль
   * `app_investments_user`).
   *
   * Роль приложения `app_backend` намеренно НЕ состоит в группе
   * `app_investments`: иначе любая ошибка в коде или SQL-инъекция в
   * пользовательском контуре могла бы переключиться на роль, которой разрешена
   * запись в реестр договоров. Поэтому инвестиционные команды идут не через
   * `SET ROLE`, а через собственное соединение с собственными правами.
   *
   * Пусто — контур недоступен: операции упадут явной ошибкой конфигурации, а не
   * тихо выполнятся под правами пользовательской роли.
   */
  DATABASE_URL_APP_INVESTMENTS: z.string().default(''),
  /**
   * Подключение интеграционного контура. Роль `app_integration` читает проекции
   * для внешних систем и владеет вебхуками; роль приложения в эту группу не
   * входит. Пусто — Integration API недоступен, и это правильное поведение:
   * отдавать данные наружу под правами пользовательской роли нельзя.
   */
  DATABASE_URL_APP_INTEGRATION: z.string().default(''),
  /**
   * Ключ подписи сервисных токенов Integration API.
   *
   * Отдельный от ключа пользовательских сессий намеренно: у контуров разный
   * срок жизни, разные потребители и разная процедура ротации. Общий ключ
   * означает, что компрометация одного контура компрометирует второй.
   */
  INTEGRATION_TOKEN_SIGNING_KEY: z.string().default(''),
  /**
   * Подключение денежного контура. Роль `app_billing` пишет начисления, счета и
   * платежи; роль приложения в эту группу не входит по той же причине, что и в
   * `app_investments`, — ошибка в пользовательском контуре не должна получать
   * право переписать деньги.
   *
   * Пусто — денежные сервисные операции недоступны и падают явной ошибкой
   * конфигурации (ADR-006).
   */
  DATABASE_URL_APP_BILLING: z.string().default(''),
  /**
   * Подключение контура доставки уведомлений. Роль `app_notifications` читает
   * шаблоны и обновляет статусы отправки; читать прикладные данные ей не нужно
   * и не разрешено.
   */
  DATABASE_URL_APP_NOTIFICATIONS: z.string().default(''),
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),

  AUTH_MODE: z.enum(['oidc', 'local']).default('local'),
  OIDC_ISSUER: z.string().default(''),
  OIDC_AUDIENCE: z.string().default(''),
  OIDC_JWKS_CACHE_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(300),
  LOCAL_AUTH_SIGNING_KEY: z.string().default(''),

  // Дефолт — dev-безопасное имя без префикса: cookie с префиксом __Host-,
  // поставленная без Secure по http, молча отбрасывается браузером.
  // В production префикс обязателен и проверяется ниже.
  SESSION_COOKIE_NAME: z.string().default('ul_session'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  CSRF_COOKIE_NAME: z.string().default('ul_csrf'),
  /**
   * Ключ подписи CSRF-токенов. Отдельный от ключа сессий: тот обязателен только
   * при AUTH_MODE=local, а CSRF действует при любой схеме входа через cookie.
   */
  CSRF_SIGNING_KEY: z.string().default(''),

  KMS_MODE: z.enum(['kms', 'local']).default('local'),
  KEK_SEARCH_INDEX: z.string().default(''),
  KEK_KYC_DOCUMENTS: z.string().default(''),
  KEK_KYB_DOCUMENTS: z.string().default(''),
  KEK_PASSPORT_SENSITIVE: z.string().default(''),
  KEK_INVESTMENT_DOCUMENTS: z.string().default(''),
  KEK_NOMINAL_ACCOUNT_EVIDENCE: z.string().default(''),
  KEK_BILLING_DOCUMENTS: z.string().default(''),
  KEK_WEBHOOK_SECRETS: z.string().default(''),

  RATE_LIMIT_DEFAULT_PER_MIN: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_MONEY_PER_MIN: z.coerce.number().int().min(1).default(10),
  // Административные операции — отдельный класс. Денежный лимит 10/мин здесь
  // неприменим: оператор за минуту делает и просмотры, и несколько правок, и
  // такой лимит превращает кабинет в неработающий (проверено живым прогоном).
  RATE_LIMIT_ADMIN_PER_MIN: z.coerce.number().int().min(1).default(60),
  /**
   * Общий счётчик ограничения частоты.
   *
   * Пусто — счётчики живут в памяти процесса. Это работает ровно до второго
   * экземпляра: каждый считает свои запросы, и фактически разрешённая частота
   * умножается на их число, а перезапуск обнуляет счётчики (SEC-11). Поэтому в
   * production переменная обязательна и проверяется ниже.
   */
  REDIS_URL: z.string().default(''),
  /**
   * Пароль счётчика — ОТДЕЛЬНО от адреса, по той же причине, что и у брокера:
   * пароль внутри URL попадает в логи подключения, в тексты ошибок и в конфиги
   * как есть.
   */
  REDIS_PASSWORD: z.string().default(''),
  /** Таймаут команды к общему счётчику. Без него зависший Redis держит запрос. */
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(1_000),

  NATS_URL: z.string().default(''),
  NATS_STREAM: z.string().default('LAUNCH'),
  // Учётные данные брокера держатся ОТДЕЛЬНО от адреса: пароль внутри URL
  // попадает в логи подключения, в сообщения об ошибках и в конфиги как есть.
  NATS_USER: z.string().default(''),
  NATS_PASSWORD: z.string().default(''),
  // Пауза между проходами публикатора outbox. Секунда — компромисс: событие
  // уходит потребителю почти сразу, но холостые проходы не бьют по БД.
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(1_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  // Доставка вебхуков — отдельный ритм: у внешнего потребителя свои таймауты,
  // и частить к нему смысла нет.
  WEBHOOK_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),

  // --- Integration API (service-to-service) -------------------------------
  // Токен сервисного клиента живёт минутами: он не привязан к человеку, его
  // некому отозвать «выходом из аккаунта», и единственная реальная защита от
  // утёкшего токена — короткий срок жизни.
  INTEGRATION_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  /**
   * Заголовок с отпечатком клиентского сертификата, который проставляет
   * терминирующий mTLS прокси. Пусто — проверка отпечатка не выполняется:
   * в dev нет mTLS. В production обязателен (проверка ниже), иначе
   * `client_credentials` остаётся единственным фактором.
   */
  INTEGRATION_CLIENT_CERT_HEADER: z.string().default(''),

  // --- AI-контур ----------------------------------------------------------
  // Шлюз — единственный выход к моделям (ADR-007). Адрес и токен приходят из
  // конфигурации: часть URL из пользовательского ввода была бы SSRF.
  AI_GATEWAY_URL: z.string().default(''),
  AI_GATEWAY_TOKEN: z.string().default(''),
  AI_GATEWAY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),

  // --- Объектное хранилище (материалы проектов) ---------------------------
  // Файл идёт в S3 напрямую по presigned URL: через API он не проходит, чтобы
  // недоверенный контент не касался прикладного процесса.
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('ru-central1'),
  S3_BUCKET: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true'),
  S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  S3_PRESIGN_TTL_SENSITIVE_SECONDS: z.coerce.number().int().min(60).max(1800).default(300),

  /** Плановое обслуживание партиций журнала: интервал прогона. */
  PARTITION_MAINTENANCE_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  PARTITION_MONTHS_AHEAD: z.coerce.number().int().min(1).max(12).default(3),
});

export type RawEnv = z.infer<typeof RawEnvSchema>;

/** Минимальная длина ключа подписи локального адаптера. */
const LOCAL_KEY_MIN_LENGTH = 64;

const EnvSchema = RawEnvSchema.superRefine((env, ctx) => {
  const isProd = env.NODE_ENV === 'production';

  // ---- Аутентификация -----------------------------------------------------
  if (isProd && env.AUTH_MODE !== 'oidc') {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_MODE'],
      message:
        'В production допустим только AUTH_MODE=oidc. Локальный адаптер подписывает ' +
        'токены сам и не имеет ни MFA, ни ротации ключей (ADR-003).',
    });
  }
  if (env.AUTH_MODE === 'oidc') {
    if (!env.OIDC_ISSUER) {
      ctx.addIssue({
        code: 'custom',
        path: ['OIDC_ISSUER'],
        message: 'обязателен при AUTH_MODE=oidc',
      });
    } else if (isProd && !env.OIDC_ISSUER.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['OIDC_ISSUER'],
        message: 'в production issuer обязан быть https',
      });
    }
    if (!env.OIDC_AUDIENCE) {
      ctx.addIssue({
        code: 'custom',
        path: ['OIDC_AUDIENCE'],
        message: 'обязателен: без проверки aud токен другого клиента будет принят',
      });
    }
  }
  // CSRF-токен подписывается всегда, поэтому и ключ нужен всегда.
  if (env.CSRF_SIGNING_KEY.length < LOCAL_KEY_MIN_LENGTH) {
    ctx.addIssue({
      code: 'custom',
      path: ['CSRF_SIGNING_KEY'],
      message: `минимум ${LOCAL_KEY_MIN_LENGTH} символов: токен без подписи не связан с сессией`,
    });
  }
  if (env.AUTH_MODE === 'local' && env.LOCAL_AUTH_SIGNING_KEY.length < LOCAL_KEY_MIN_LENGTH) {
    ctx.addIssue({
      code: 'custom',
      path: ['LOCAL_AUTH_SIGNING_KEY'],
      message: `минимум ${LOCAL_KEY_MIN_LENGTH} символов`,
    });
  }

  // ---- Integration API ----------------------------------------------------
  // Спецификация требует mTLS + client_credentials (Architect_Launch §6.1).
  // Секрет клиента может утечь из конфигурации потребителя; сертификат — второй
  // фактор, и в production он обязателен. Без заголовка от прокси проверить его
  // нечем, поэтому пустое значение в production — ошибка конфигурации.
  // Сервисные токены Integration API подписывались тем же ключом, что и
  // локальные сессии, а его длина проверялась ТОЛЬКО при AUTH_MODE=local. В
  // production, где обязателен oidc, ключ мог остаться пустым — и подпись
  // вычислялась HMAC с пустым, то есть известным, ключом. Свой ключ обязателен
  // всегда, когда контур включён: подпись, которую может вычислить кто угодно,
  // не является подписью.
  if (
    env.DATABASE_URL_APP_INTEGRATION &&
    env.INTEGRATION_TOKEN_SIGNING_KEY.length < LOCAL_KEY_MIN_LENGTH
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['INTEGRATION_TOKEN_SIGNING_KEY'],
      message:
        'Integration API включён без собственного ключа подписи токенов ' +
        `(минимум ${LOCAL_KEY_MIN_LENGTH} символов). Ключ сессий для этого не годится.`,
    });
  }

  if (isProd && env.DATABASE_URL_APP_INTEGRATION && !env.INTEGRATION_CLIENT_CERT_HEADER) {
    ctx.addIssue({
      code: 'custom',
      path: ['INTEGRATION_CLIENT_CERT_HEADER'],
      message:
        'Integration API включён без проверки клиентского сертификата: ' +
        'в production mTLS обязателен (Architect_Launch §6.1).',
    });
  }

  // ---- Криптография -------------------------------------------------------
  if (isProd && env.KMS_MODE !== 'kms') {
    ctx.addIssue({
      code: 'custom',
      path: ['KMS_MODE'],
      message: 'В production ключи хранятся в KMS/Vault, а не в переменных окружения.',
    });
  }
  if (env.KMS_MODE === 'local') {
    // Blind index нужен всегда: без него нельзя ни зарегистрировать, ни найти
    // пользователя по email.
    const parsed = Base64Key32.safeParse(env.KEK_SEARCH_INDEX);
    if (!parsed.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['KEK_SEARCH_INDEX'],
        message: 'при KMS_MODE=local требуется 32 байта в base64',
      });
    }
  }

  // ---- Сеть ---------------------------------------------------------------
  const origins = env.CORS_ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.includes('*')) {
    ctx.addIssue({
      code: 'custom',
      path: ['CORS_ALLOWED_ORIGINS'],
      message: "CORS '*' запрещён: нужен строгий allowlist (RULES.md §3.2)",
    });
  }
  if (isProd) {
    if (origins.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'в production allowlist Origin обязателен',
      });
    }
    for (const origin of origins) {
      if (!origin.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: `в production допустимы только https-Origin: ${origin}`,
        });
      }
    }
    if (!env.CORE_PUBLIC_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORE_PUBLIC_URL'],
        message: 'в production публичный URL обязан быть https',
      });
    }
  }

  // ---- Объектное хранилище ------------------------------------------------
  // Настройка либо полная, либо отсутствует: половина конфигурации — это
  // выдача presigned URL, который никуда не ведёт.
  const s3Parts = [env.S3_ENDPOINT, env.S3_BUCKET, env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY];
  const s3Filled = s3Parts.filter(Boolean).length;
  if (s3Filled > 0 && s3Filled < s3Parts.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['S3_ENDPOINT'],
      message:
        'конфигурация S3 неполна: нужны endpoint, bucket и пара ключей одновременно ' +
        'либо ничего (загрузка материалов будет отключена)',
    });
  }
  const endpointScheme =
    env.S3_ENDPOINT.startsWith('http://') || env.S3_ENDPOINT.startsWith('https://');
  if (env.S3_ENDPOINT && !endpointScheme) {
    ctx.addIssue({ code: 'custom', path: ['S3_ENDPOINT'], message: 'ожидается http(s) URL' });
  }
  if (isProd && env.S3_ENDPOINT && !env.S3_ENDPOINT.startsWith('https://')) {
    ctx.addIssue({
      code: 'custom',
      path: ['S3_ENDPOINT'],
      message: 'в production обращение к хранилищу — только по https',
    });
  }

  // ---- AI-контур ----------------------------------------------------------
  // Адрес и токен идут парой: адрес без токена означает запросы к шлюзу без
  // аутентификации, токен без адреса — секрет в конфигурации без применения.
  if (Boolean(env.AI_GATEWAY_URL) !== Boolean(env.AI_GATEWAY_TOKEN)) {
    ctx.addIssue({
      code: 'custom',
      path: ['AI_GATEWAY_URL'],
      message: 'AI_GATEWAY_URL и AI_GATEWAY_TOKEN задаются вместе либо не задаются вовсе',
    });
  }
  if (isProd && env.AI_GATEWAY_URL && !env.AI_GATEWAY_URL.startsWith('https://')) {
    ctx.addIssue({
      code: 'custom',
      path: ['AI_GATEWAY_URL'],
      message: 'в production обращение к шлюзу — только по https',
    });
  }

  // ---- Cookie -------------------------------------------------------------
  // Префикс __Host- требует Secure, Path=/ и отсутствия Domain. Браузер молча
  // отбросит такую cookie по http, поэтому в production он обязателен, а в
  // dev — наоборот, недопустим.
  // ---- Транспорт до внутренних систем -------------------------------------
  // Внешние адреса в production обязаны быть https, а вот до БД и брокера
  // требования не было вовсе: пароли, ПДн и события шли бы открытым текстом
  // внутри сети. Компрометация сегмента east-west превращается в перехват
  // учётных данных (SEC-09).
  if (isProd && env.DATABASE_SSL !== 'true') {
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_SSL'],
      message: 'в production соединение с БД обязано идти по TLS',
    });
  }
  // Ограничение частоты в памяти процесса — не ограничение частоты, а его
  // видимость: два экземпляра дают двойную частоту, перезапуск обнуляет
  // счётчики (SEC-11). В production общий счётчик обязателен.
  if (isProd && !env.REDIS_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['REDIS_URL'],
      message:
        'в production обязателен общий счётчик ограничения частоты: ' +
        'счётчики в памяти процесса умножают разрешённую частоту на число экземпляров',
    });
  }
  // Тот же довод, что и для БД с брокером: пароль и ключи вёдер не должны идти
  // по сети открытым текстом.
  if (isProd && env.REDIS_URL && !env.REDIS_URL.startsWith('rediss://')) {
    ctx.addIssue({
      code: 'custom',
      path: ['REDIS_URL'],
      message: 'в production общий счётчик подключается по rediss:// (TLS), а не redis://',
    });
  }
  // Учётные данные внутри адреса — это пароль в логах подключения и в текстах
  // ошибок. Тот же запрет, что уже действует для брокера.
  if (env.REDIS_URL.includes('@')) {
    ctx.addIssue({
      code: 'custom',
      path: ['REDIS_URL'],
      message:
        'учётные данные внутри адреса недопустимы: пароль попадёт в логи. ' +
        'Задай REDIS_PASSWORD отдельной переменной.',
    });
  }
  // Счётчик без аутентификации — это доступ к вёдрам лимита из сети (RULES §3.2:
  // ни одного сервиса без аутентификации, даже «внутреннего»).
  if (isProd && env.REDIS_URL && !env.REDIS_PASSWORD) {
    ctx.addIssue({
      code: 'custom',
      path: ['REDIS_PASSWORD'],
      message: 'в production подключение к счётчику обязано быть аутентифицированным',
    });
  }

  if (isProd && env.NATS_URL && !env.NATS_URL.startsWith('tls://')) {
    ctx.addIssue({
      code: 'custom',
      path: ['NATS_URL'],
      message: 'в production брокер подключается по tls://, а не nats://',
    });
  }

  if (isProd && !env.SESSION_COOKIE_NAME.startsWith('__Host-')) {
    ctx.addIssue({
      code: 'custom',
      path: ['SESSION_COOKIE_NAME'],
      message: 'в production имя сессионной cookie обязано начинаться с __Host-',
    });
  }
  // Обратная сторона того же правила. Вне production cookie ставится без
  // Secure (сервер работает по http), а cookie с префиксом __Host- без Secure
  // браузер МОЛЧА отбрасывает: вход просто не работает, и никакой ошибки в
  // ответе при этом нет. Скрипты на fetch этого не замечают — правила
  // префиксов применяет браузер, а не HTTP-клиент.
  if (!isProd) {
    for (const [path, value] of [
      ['SESSION_COOKIE_NAME', env.SESSION_COOKIE_NAME],
      ['CSRF_COOKIE_NAME', env.CSRF_COOKIE_NAME],
    ] as const) {
      if (value.startsWith('__Host-') || value.startsWith('__Secure-')) {
        ctx.addIssue({
          code: 'custom',
          path: [path],
          message:
            'вне production префиксы __Host-/__Secure- недопустимы: браузер отбрасывает ' +
            'такую cookie, если она поставлена без Secure по http',
        });
      }
    }
  }
});

export type AppEnv = Readonly<RawEnv> & {
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly corsOrigins: readonly string[];
};

let cached: AppEnv | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Некорректная конфигурация окружения:\n${details}`);
  }
  const env = parsed.data;
  return Object.freeze({
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    corsOrigins: Object.freeze(
      env.CORS_ALLOWED_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  });
}

export function getEnv(): AppEnv {
  cached ??= loadEnv();
  return cached;
}

/** Только для тестов: сбросить кеш конфигурации. */
export function resetEnvCache(): void {
  cached = null;
}
