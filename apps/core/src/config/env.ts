import { z } from 'zod';
import { withSecretFiles } from './secret-files';
import { parseKeyVersions, SIGNING_KEY_NAMES } from '../auth/signing-keys';

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

  // --- Фоновая работа (блок 1) ---------------------------------------------
  // Роль запуска: `all` — HTTP и фон в одном процессе (как было), `http` —
  // только запросы, `worker` — только фон, без публичного порта.
  CORE_ROLE: z.enum(['all', 'http', 'worker']).default('all'),
  // Общий выключатель. Строка, а не coerce.boolean: тот превращает «false» в true.
  BACKGROUND_JOBS_ENABLED: z.enum(['true', 'false']).default('true'),
  // Отдельные задачи, выключенные по имени: `outbox.publish,webhooks.deliver`.
  BACKGROUND_JOBS_DISABLED: z.string().default(''),
  // Общий предел штатного завершения процесса — от сигнала до выхода.
  BACKGROUND_STOP_GRACE_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  // Служебный порт живости и состояния задач. Не задан — CORE_PORT + 100.
  CORE_INTERNAL_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  CORE_INTERNAL_BIND_HOST: z.string().default('127.0.0.1'),
  BACKGROUND_TICK_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  /**
   * Доступность групп функций (4.11): служебная проверка зависимостей раз в 30 с,
   * наблюдение актуально 90 с (Тэнк 08.11), у каждой проверки свой предел времени.
   */
  AVAILABILITY_PROBE_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  AVAILABILITY_FRESH_MS: z.coerce.number().int().min(2_000).max(3_600_000).default(90_000),
  AVAILABILITY_PROBE_TIMEOUT_MS: z.coerce.number().int().min(200).max(30_000).default(5_000),
  BACKGROUND_LIVE_STALE_MS: z.coerce.number().int().min(2_000).max(600_000).default(30_000),
  // Предел ожидания одной зависимости в /ready (блок 8, 8.2: проверки с
  // ограниченным ожиданием). Зависшая зависимость — fail, а не висящий ответ.
  READINESS_CHECK_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(2_000),
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
   * Подключение контура доставки уведомлений. Роль `app_notifications` читает
   * шаблоны и обновляет статусы отправки; читать прикладные данные ей не нужно
   * и не разрешено.
   */
  DATABASE_URL_APP_NOTIFICATIONS: z.string().default(''),
  /**
   * Подключение контура планового обслуживания. Роль `app_maintenance` умеет
   * ровно две вещи: убирать истёкшие записи реестра отзывов и брошенные билеты
   * на загрузку. Ни читать проекты, ни трогать подтверждённые материалы она не
   * может — это ограничено политиками, а не аккуратностью кода (M039).
   *
   * Пусто — уборка не выполняется и объявляет это в логе, а не делает вид, что
   * отработала.
   */
  DATABASE_URL_APP_MAINTENANCE: z.string().default(''),
  /**
   * Подключение для проверки состояния сессий (роль `app_auth`, M046).
   *
   * Раньше рубеж сессий и реестр отозванных токенов читались ролью доставки
   * уведомлений — у неё есть `SELECT` по пользователям и ролям целиком, тогда
   * как проверке входа хватает двух колонок (SEC-21). Пусто — проверка падает
   * явной ошибкой конфигурации, а не выполняется под более широкой ролью.
   */
  DATABASE_URL_APP_AUTH: z.string().default(''),
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
  /** Версии подписей: `kid:секрет,…`, действующая версия и срок приёма токенов без kid. */
  CSRF_SIGNING_KEY_VERSIONS: z.string().default(''),
  CSRF_SIGNING_KEY_ACTIVE: z.string().default(''),
  CSRF_SIGNING_KEY_LEGACY_UNTIL: z.string().default(''),
  LOCAL_AUTH_SIGNING_KEY_VERSIONS: z.string().default(''),
  LOCAL_AUTH_SIGNING_KEY_ACTIVE: z.string().default(''),
  LOCAL_AUTH_SIGNING_KEY_LEGACY_UNTIL: z.string().default(''),
  INTEGRATION_TOKEN_SIGNING_KEY_VERSIONS: z.string().default(''),
  INTEGRATION_TOKEN_SIGNING_KEY_ACTIVE: z.string().default(''),
  INTEGRATION_TOKEN_SIGNING_KEY_LEGACY_UNTIL: z.string().default(''),

  KMS_MODE: z.enum(['kms', 'local']).default('local'),
  /**
   * Формат новых записей, отдельно от места хранения ключа. `legacy` понимает и старое ядро,
   * `vault` — граница возврата (блок 5, задание 4).
   */
  CRYPTO_WRITE_FORMAT: z.enum(['legacy', 'vault']).default('legacy'),
  OPENBAO_ADDR: z.string().default(''),
  OPENBAO_CA_PATH: z.string().default(''),
  /** Файл с токеном, его пишет и продлевает OpenBao Agent. */
  OPENBAO_TOKEN_PATH: z.string().default(''),
  OPENBAO_KEY_PREFIX: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default('prod'),
  /** Версия ключа поиска: новая не включается сама, смена означает пересчёт индексов. */
  OPENBAO_SEARCH_INDEX_VERSION: z.coerce.number().int().min(1).default(1),
  OPENBAO_TIMEOUT_MS: z.coerce.number().int().min(100).default(3_000),
  KEK_SEARCH_INDEX: z.string().default(''),
  KEK_KYC_DOCUMENTS: z.string().default(''),
  KEK_KYB_DOCUMENTS: z.string().default(''),
  KEK_PASSPORT_SENSITIVE: z.string().default(''),
  KEK_WEBHOOK_SECRETS: z.string().default(''),

  RATE_LIMIT_DEFAULT_PER_MIN: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(1).default(30),
  // Административные операции — отдельный класс: оператор за минуту делает и
  // просмотры, и несколько правок, и жёсткий лимит превращает кабинет в
  // неработающий (проверено живым прогоном).
  RATE_LIMIT_ADMIN_PER_MIN: z.coerce.number().int().min(1).default(60),
  /**
   * Потолок частоты по адресу поверх классовых вёдер.
   *
   * Порог намеренно высокий: он не заменяет классовые лимиты, а ограничивает
   * суммарный шторм с одного адреса — в том числе тот, что раньше проходил
   * подделкой cookie (ключ ведра аутентифицированных классов включает
   * непроверенную подсказку сессии). Значение должно быть заметно выше общего
   * лимита, иначе потолок начнёт срабатывать раньше классовых вёдер и
   * замаскирует их.
   */
  RATE_LIMIT_IP_CEILING_PER_MIN: z.coerce.number().int().min(10).default(600),
  /**
   * Порог неудачных входов НА АККАУНТ за окно, после которого вход отклоняется
   * до проверки пароля (и до argon2 — это ещё и защита от CPU-DoS). Считается
   * по blind-индексу контакта, поэтому распределённый перебор с ботнета не
   * обходит его сменой адреса. Окно — LOGIN_THROTTLE_WINDOW_SEC.
   */
  RATE_LIMIT_LOGIN_FAIL_PER_ACCOUNT: z.coerce.number().int().min(3).default(10),
  LOGIN_THROTTLE_WINDOW_SEC: z.coerce.number().int().min(30).default(900),
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

  // --- Почта: восстановление пароля, подтверждение адреса, служебный ящик --
  //
  // Транспорт выбирается переменной:
  //
  //   none — отправлять нечем. Маршруты восстановления и подтверждения
  //          отвечают 503 feature_disabled: обещать письмо, которого не будет,
  //          хуже, чем сказать, что канал не подключён;
  //   file — письмо кладётся файлом в MAIL_OUTBOX_DIR. Это НЕ доставка, а
  //          способ пройти сценарий целиком на стенде и в прогонах. В
  //          production запрещён проверкой ниже: ссылка на смену пароля,
  //          записанная в файл на диске сервера, — это утечка, а не письмо;
  //   smtp — настоящая доставка через smarthost (MAIL_SMTP_*).
  //
  // Остальной код о выборе не знает — он работает с портом MailTransport.
  MAIL_TRANSPORT: z.enum(['none', 'file', 'smtp']).default('none'),
  MAIL_OUTBOX_DIR: z.string().default('var/mail'),
  MAIL_FROM: z.string().default('no-reply@fifth.local'),
  /** Приставка темы письма: называет среду, если она не рабочая. */
  MAIL_SUBJECT_PREFIX: z.string().default(''),
  /**
   * Релей, через который уходят письма (`MAIL_TRANSPORT=smtp`).
   *
   * Отдельные переменные, а не один `smtp://user:pass@host` URL: пароль внутри
   * адреса попадает в лог подключения, в текст ошибки и в конфиги как есть —
   * ровно та же причина, по которой отдельно вынесены учётные данные брокера.
   *
   * Порт по умолчанию 2525, а не 587: на текущем ВПС исходящие 25, 465 и 587
   * закрыты провайдером, и 2525 — единственный, через который письмо уходит.
   */
  MAIL_SMTP_HOST: z.string().default(''),
  MAIL_SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(2_525),
  /**
   * starttls — открыть соединение и обязательно перейти на TLS (587, 2525);
   * tls      — TLS с первого байта (465);
   * plain    — без шифрования; допустим ТОЛЬКО к петле и только без пароля
   *            (локальный приёмник mailpit в прогонах).
   */
  MAIL_SMTP_SECURITY: z.enum(['starttls', 'tls', 'plain']).default('starttls'),
  MAIL_SMTP_USER: z.string().default(''),
  MAIL_SMTP_PASSWORD: z.string().default(''),
  /** Имя в EHLO. Пустое — берётся домен из MAIL_FROM. */
  MAIL_SMTP_EHLO_NAME: z.string().default(''),
  MAIL_SMTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  // Очередь служебных писем (4.11, M162): частота прохода и предел попыток по вине письма.
  MAIL_QUEUE_POLL_MS: z.coerce.number().int().min(500).max(600_000).default(5_000),
  MAIL_QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),
  /**
   * Уведомлять ли служебный ящик о новых регистрациях.
   *
   * Отдельным флагом, а не «раз ящик задан — шлём»: на стенде и в нагрузочных
   * прогонах регистраций тысячи, и ящик, забитый ими, перестают читать — а
   * вместе с регистрациями там лежат обращения в поддержку.
   */
  NOTIFY_INBOX_ON_REGISTRATION: z.enum(['true', 'false']).default('false'),
  /**
   * Служебный ящик проекта: куда падают новые обращения в поддержку и
   * сообщения об ошибках.
   *
   * Это НЕ личная почта сотрудника, а технический адрес: человек уходит в
   * отпуск, адрес остаётся. Пустое значение означает «копия на почту не
   * уходит» — обращение всё равно сохраняется, и в интерфейсе поддержки оно
   * видно. Изображать отправку при ненастроенном ящике нельзя: тогда
   * обращение считалось бы доставленным, не будучи никому показанным.
   */
  SUPPORT_INBOX_EMAIL: z.union([z.literal(''), z.email()]).default(''),
  /**
   * Адрес, по которому человек открывает платформу.
   *
   * Из него собираются ссылки в письмах. Брать его из заголовка `Host`
   * запрещено: подменённый заголовок увёл бы ссылку восстановления пароля на
   * чужой домен, а письмо при этом выглядело бы нашим (классический host header
   * poisoning). Поэтому — конфигурация, а не запрос.
   */
  PUBLIC_BASE_URL: z.url().default('http://127.0.0.1'),
  /**
   * Срок жизни ссылки на смену пароля. По умолчанию 30 минут: ссылка, живущая
   * сутки, — это второй пароль, лежащий в почтовом ящике.
   */
  PASSWORD_RESET_TTL_SEC: z.coerce.number().int().min(300).max(86_400).default(1_800),
  /** Подтверждение почты не даёт входа, поэтому срок длиннее — сутки. */
  EMAIL_VERIFY_TTL_SEC: z.coerce.number().int().min(300).max(86_400).default(86_400),
  /**
   * Сколько писем подтверждения можно запросить на ОДИН контакт за окно.
   *
   * Классовый лимит считает по адресу запрашивающего и не мешает разослать по
   * письму на тысячу разных ящиков или завалить один ящик с тысячи адресов.
   * Счётчик привязан к blind-индексу контакта — как троттлинг перебора пароля.
   */
  RATE_LIMIT_VERIFY_MAIL_PER_CONTACT: z.coerce.number().int().min(1).default(5),
  VERIFY_MAIL_WINDOW_SEC: z.coerce.number().int().min(60).default(3_600),

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
  /**
   * Выпускает ли контур доставки наружу.
   *
   * `capture` — доставка НЕ уходит: запись помечается «перехвачено» с
   * причиной, и её видно в разборе. `live` — обычная отправка.
   *
   * Значения по умолчанию нет: режим задаётся окружением явно (`.env.example`
   * ставит `capture` вне production, боевой конфиг — `live`). Доставка
   * вебхуков — единственный живой канал платформы наружу: почта локальная,
   * платежи тестовые, языковая модель не подключена. Отсутствие рабочих
   * данных в базе от внешнего действия не защищает — подписчик с настоящим
   * адресом получит настоящий POST от любого события, включая заведённое
   * проверкой.
   */
  WEBHOOK_DELIVERY_MODE: z.enum(['capture', 'live']).default('capture'),

  /**
   * Тестовые сессии и просмотр кабинета от чужого лица.
   *
   * Механизм подставляет личность внутри стража доступа: цена ошибки —
   * чтение чужого кабинета. Поэтому включение не полагается на одну
   * переменную: в production он выключен КОДОМ (см. AccessContextService),
   * и переменная там ничего не меняет. Снятие запрета — отдельное решение
   * владельца, а не забытое значение в боевом конфиге.
   */
  TESTING_SESSIONS_ENABLED: z.coerce.boolean().default(false),

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

  // --- Объектное хранилище (материалы проектов) ---------------------------
  // Файл идёт в S3 напрямую по presigned URL: через API он не проходит, чтобы
  // недоверенный контент не касался прикладного процесса.
  S3_ENDPOINT: z.string().default(''),
  /**
   * Публичный адрес загрузки — куда БРАУЗЕР отправляет подписанную форму
   * (блок 4, «Вход и файлы MVP»; 2.1-W06). `S3_ENDPOINT` — внутренний адрес,
   * по которому ходит само ядро. На стенде, где браузер и хранилище на одной
   * машине, не задаётся: форма идёт на `S3_ENDPOINT`, как раньше. На внешнем
   * стенде без него форма вела бы на localhost браузера — такую форму ядро
   * не выдаёт (`S3Service.uploadAddressProblem`).
   */
  S3_PUBLIC_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('ru-central1'),
  S3_BUCKET: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true'),
  S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  S3_PRESIGN_TTL_SENSITIVE_SECONDS: z.coerce.number().int().min(60).max(1800).default(300),

  /**
   * Через сколько часов неподтверждённый билет на загрузку считается брошенным.
   *
   * Минимум — час, и это не настройка вкуса: предельный срок жизни подписанной
   * формы загрузки составляет 3600 секунд, поэтому раньше часа «загрузка ещё
   * идёт» остаётся возможной. Тот же порог продублирован в политике БД (M039).
   */
  MATERIAL_ABANDONED_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),

  /**
   * Срок подписанной формы загрузки материала (2.1.2, решение 30.10.2026).
   *
   * MinIO проверяет срок формы ПОСЛЕ приёма тела (опыт 2.1-W06: форма 60 с,
   * передача 102 с — «Policy expired», объект не сохранён). Поэтому срок
   * формы и есть предел ожидания начала вместе со всей передачей: 95 минут
   * при пределе передачи 90 минут в Caddy (`read_body`). Короче нельзя —
   * большой файл на медленном канале потерялся бы в самом конце.
   */
  MATERIAL_UPLOAD_FORM_TTL_SECONDS: z.coerce.number().int().min(900).max(7200).default(5700),

  /** Плановое обслуживание партиций журнала: интервал прогона. */
  PARTITION_MAINTENANCE_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  PARTITION_MONTHS_AHEAD: z.coerce.number().int().min(1).max(12).default(3),
});

export type RawEnv = z.infer<typeof RawEnvSchema>;

/** Минимальная длина ключа подписи локального адаптера. */
const LOCAL_KEY_MIN_LENGTH = 64;

/**
 * Литерал петли — проверяется именно ЛИТЕРАЛ, а не результат DNS.
 *
 * Имя, которое сегодня резолвится в 127.0.0.1, завтра резолвится куда угодно,
 * и разрешение «без шифрования на локальный приёмник» превратилось бы в
 * «без шифрования куда скажет чужой DNS».
 */
function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost' || bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (!octets) return false;
  const parts = octets.slice(1).map(Number);
  return parts.every((value) => value <= 255) && parts[0] === 127;
}

/** Адрес указывает на эту же машину (литерал петли, без DNS). Битый URL — не петля. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

const EnvSchema = RawEnvSchema.superRefine((env, ctx) => {
  const isProd = env.NODE_ENV === 'production';

  // ---- Аутентификация -----------------------------------------------------
  // Обычный вход по логину и паролю разрешён и в production (решение Томаса, блок 5): его ключ
  // проверяется ниже, версии подписей и защита cookie действуют как для любого входа.
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
  // ---- Тестовые сессии -----------------------------------------------------
  if (isProd && env.TESTING_SESSIONS_ENABLED) {
    ctx.addIssue({
      code: 'custom',
      path: ['TESTING_SESSIONS_ENABLED'],
      message:
        'в production механизм выключен кодом; включённая переменная означает, что ' +
        'боевой конфиг собран по образцу тестового — это стоит заметить сейчас, а не потом',
    });
  }

  // ---- Внешние вызовы ------------------------------------------------------
  if (isProd && env.WEBHOOK_DELIVERY_MODE === 'capture') {
    ctx.addIssue({
      code: 'custom',
      path: ['WEBHOOK_DELIVERY_MODE'],
      message:
        'capture в production означает, что подписчики не получают событий, а очередь ' +
        'выглядит обработанной. Это тихий отказ интеграции, а не безопасность.',
    });
  }

  // ---- Почта ---------------------------------------------------------------
  if (isProd && env.MAIL_TRANSPORT === 'file') {
    ctx.addIssue({
      code: 'custom',
      path: ['MAIL_TRANSPORT'],
      message:
        'file-транспорт в production означает, что ссылки на смену пароля пишутся ' +
        'в файлы на диске сервера и никому не доставляются. Это утечка, а не почта.',
    });
  }
  if (env.MAIL_TRANSPORT === 'smtp') {
    if (!env.MAIL_SMTP_HOST) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_SMTP_HOST'],
        message: 'транспорт smtp выбран, но релей не задан — отправлять некуда',
      });
    }
    // Незашифрованный SMTP наружу — это и письма, и пароль от релея в чужой
    // сети. Разрешён только локальный приёмник прогонов, и только без пароля;
    // остальное проверяет сам транспорт перед каждой отправкой.
    if (env.MAIL_SMTP_SECURITY === 'plain' && !isLoopbackHost(env.MAIL_SMTP_HOST)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_SMTP_SECURITY'],
        message: 'без шифрования письма уходят только на локальный приёмник (127.0.0.0/8, ::1)',
      });
    }
    if (env.MAIL_SMTP_USER && !env.MAIL_SMTP_PASSWORD) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_SMTP_PASSWORD'],
        message: 'для входа на релей задано имя без пароля',
      });
    }
    if (isProd && env.MAIL_SMTP_SECURITY === 'plain') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_SMTP_SECURITY'],
        message: 'в production канал до релея обязан быть зашифрован',
      });
    }
    if (isProd && !env.MAIL_SMTP_USER) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_SMTP_USER'],
        message:
          'релей без аутентификации в production — это открытый ретранслятор либо чужой ' +
          'сервер, который примет письмо от кого угодно от нашего имени',
      });
    }
  }
  if (env.NOTIFY_INBOX_ON_REGISTRATION === 'true' && !env.SUPPORT_INBOX_EMAIL) {
    ctx.addIssue({
      code: 'custom',
      path: ['SUPPORT_INBOX_EMAIL'],
      message: 'уведомления о регистрациях включены, но служебный ящик не задан',
    });
  }
  // Проверка безусловна, хотя письма может ещё не быть.
  //
  // Привязать её к включённому транспорту было заманчиво — «нет писем, нет и
  // ссылок», — но тогда правило не срабатывало бы никогда, пока боевой контур
  // не подключит релей. Проверка, которая не может сработать, — это не защита,
  // а зелёный флаг без основания. Поэтому боевой контур обязан знать свой
  // публичный адрес заранее: значение очевидно, а неверное всплывёт в первой
  // же ссылке из письма.
  if (isProd && !env.PUBLIC_BASE_URL.startsWith('https://')) {
    ctx.addIssue({
      code: 'custom',
      path: ['PUBLIC_BASE_URL'],
      message:
        'ссылки в письмах обязаны быть https: токен восстановления в открытом канале ' +
        'читается любым, кто видит трафик',
    });
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
  if (env.KMS_MODE === 'local' && env.CRYPTO_WRITE_FORMAT === 'vault') {
    ctx.addIssue({
      code: 'custom',
      path: ['CRYPTO_WRITE_FORMAT'],
      message: 'формат vault пишется только через Transit: нужен KMS_MODE=kms',
    });
  }
  if (env.KMS_MODE === 'kms') {
    const secure = env.OPENBAO_ADDR.startsWith('https://');
    if (!secure && (isProd || !env.OPENBAO_ADDR.startsWith('http://'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENBAO_ADDR'],
        message: 'при KMS_MODE=kms нужен адрес OpenBao, в production только https',
      });
    }
    if (secure && !env.OPENBAO_CA_PATH) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENBAO_CA_PATH'],
        message: 'нужен сертификат OpenBao',
      });
    }
    if (!env.OPENBAO_TOKEN_PATH) {
      ctx.addIssue({ code: 'custom', path: ['OPENBAO_TOKEN_PATH'], message: 'нужен файл токена' });
    }
    // Ключ в окружении при рабочем KMS — это запасной путь в обход OpenBao.
    for (const name of [
      'KEK_SEARCH_INDEX',
      'KEK_KYC_DOCUMENTS',
      'KEK_PASSPORT_SENSITIVE',
      'KEK_KYB_DOCUMENTS',
      'KEK_WEBHOOK_SECRETS',
    ] as const) {
      if (env[name]) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'при KMS_MODE=kms ядру KEK не выдаётся',
        });
      }
    }
  }
  for (const name of SIGNING_KEY_NAMES) {
    let versions = new Map<string, string>();
    try {
      versions = parseKeyVersions(env[`${name}_VERSIONS`]);
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: [`${name}_VERSIONS`],
        message: 'нужен вид kid:секрет через запятую, kid не повторяются',
      });
    }
    for (const secret of versions.values()) {
      if (secret.length < LOCAL_KEY_MIN_LENGTH || secret === env[name]) {
        ctx.addIssue({
          code: 'custom',
          path: [`${name}_VERSIONS`],
          message: `минимум ${LOCAL_KEY_MIN_LENGTH} символов, и версия не повторяет прежний ключ`,
        });
      }
    }
    const active = env[`${name}_ACTIVE`];
    if (active && !versions.has(active)) {
      ctx.addIssue({
        code: 'custom',
        path: [`${name}_ACTIVE`],
        message: 'действующая версия не зарегистрирована',
      });
    }
    if (active && Number.isNaN(Date.parse(env[`${name}_LEGACY_UNTIL`]))) {
      ctx.addIssue({
        code: 'custom',
        path: [`${name}_LEGACY_UNTIL`],
        message: 'нужен конкретный срок приёма токенов без kid',
      });
    }
  }
  if (env.KMS_MODE === 'local') {
    // Проверяются ВСЕ фактически используемые домены, а не один blind index:
    // прежде остальные семь падали при первом использовании — ошибка
    // конфигурации всплывала на пользовательском запросе вместо старта
    // (LOW внешнего аудита №2). Домен `kyc_documents` намеренно
    // зарезервирован схемой и кодом не вызывается — решение Ф27, его
    // отсутствие в `.env` законно и держится гейтом `gate:kek`. Домены
    // инвестиционных, денежных документов и ключей ИИ удалены в 2.1-W05.
    const REQUIRED_KEK_ENVS = [
      'KEK_SEARCH_INDEX',
      'KEK_PASSPORT_SENSITIVE',
      'KEK_KYB_DOCUMENTS',
      'KEK_WEBHOOK_SECRETS',
    ] as const;
    for (const name of REQUIRED_KEK_ENVS) {
      if (!Base64Key32.safeParse(env[name]).success) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'при KMS_MODE=local требуется 32 байта в base64',
        });
      }
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
  // Внутренний адрес по http допустим только на той же машине: трафик ядра к
  // хранилищу не выходит за пределы узла. Всё остальное — https.
  if (
    isProd &&
    env.S3_ENDPOINT &&
    !env.S3_ENDPOINT.startsWith('https://') &&
    !isLoopbackUrl(env.S3_ENDPOINT)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['S3_ENDPOINT'],
      message: 'в production обращение к хранилищу вне узла — только по https',
    });
  }
  if (env.S3_PUBLIC_ENDPOINT) {
    if (!/^https?:\/\//.test(env.S3_PUBLIC_ENDPOINT)) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_PUBLIC_ENDPOINT'],
        message: 'ожидается http(s) URL',
      });
    } else if (isProd && !env.S3_PUBLIC_ENDPOINT.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_PUBLIC_ENDPOINT'],
        message: 'в production публичный адрес загрузки — только https',
      });
    }
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
  // TLS шифрует канал, но НЕ говорит брокеру, кто подключился. У сервера NATS по
  // умолчанию аутентификации нет вовсе: до этой проверки production требовал
  // только tls://, а `NATS_USER`/`NATS_PASSWORD` имели пустые значения по
  // умолчанию — клиент просто не передавал учётных данных. Любой, кто дотянулся
  // до брокера по сети, мог публиковать события и читать чужие (SEC-05).
  if (isProd && env.NATS_URL && (!env.NATS_USER || !env.NATS_PASSWORD)) {
    ctx.addIssue({
      code: 'custom',
      path: ['NATS_USER'],
      message:
        'в production подключение к брокеру обязано быть аутентифицированным: ' +
        'задай NATS_USER и NATS_PASSWORD (шифрование канала не заменяет проверку публикующего)',
    });
  }
  // Тот же запрет, что для Redis и БД: учётные данные внутри адреса попадают в
  // логи подключения и в тексты ошибок.
  if (env.NATS_URL.includes('@')) {
    ctx.addIssue({
      code: 'custom',
      path: ['NATS_URL'],
      message:
        'учётные данные внутри адреса недопустимы: пароль попадёт в логи. ' +
        'Задай NATS_USER и NATS_PASSWORD отдельными переменными.',
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
  const resolved = withSecretFiles(source);
  // Ключи шифрования и часть служебных значений читаются из process.env напрямую.
  if (source === process.env) {
    Object.assign(process.env, resolved);
    // `_FILE` снимается: повторная загрузка иначе приняла бы значение за конфликт.
    for (const key of Object.keys(source)) if (!(key in resolved)) delete process.env[key];
  }
  const parsed = EnvSchema.safeParse(resolved);
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
