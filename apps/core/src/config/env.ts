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

  DATABASE_URL: NonEmpty,
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),

  AUTH_MODE: z.enum(['oidc', 'local']).default('local'),
  OIDC_ISSUER: z.string().default(''),
  OIDC_AUDIENCE: z.string().default(''),
  OIDC_JWKS_CACHE_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(300),
  LOCAL_AUTH_SIGNING_KEY: z.string().default(''),

  SESSION_COOKIE_NAME: z.string().default('__Host-ul_session'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  CSRF_COOKIE_NAME: z.string().default('__Host-ul_csrf'),

  KMS_MODE: z.enum(['kms', 'local']).default('local'),
  KEK_SEARCH_INDEX: z.string().default(''),
  KEK_KYC_DOCUMENTS: z.string().default(''),
  KEK_KYB_DOCUMENTS: z.string().default(''),
  KEK_PASSPORT_SENSITIVE: z.string().default(''),
  KEK_INVESTMENT_DOCUMENTS: z.string().default(''),
  KEK_NOMINAL_ACCOUNT_EVIDENCE: z.string().default(''),
  KEK_BILLING_DOCUMENTS: z.string().default(''),

  RATE_LIMIT_DEFAULT_PER_MIN: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_MONEY_PER_MIN: z.coerce.number().int().min(1).default(10),

  NATS_URL: z.string().default(''),
  NATS_STREAM: z.string().default('LAUNCH'),
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
  if (env.AUTH_MODE === 'local' && env.LOCAL_AUTH_SIGNING_KEY.length < LOCAL_KEY_MIN_LENGTH) {
    ctx.addIssue({
      code: 'custom',
      path: ['LOCAL_AUTH_SIGNING_KEY'],
      message: `минимум ${LOCAL_KEY_MIN_LENGTH} символов`,
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

  // ---- Cookie -------------------------------------------------------------
  // Префикс __Host- требует Secure, Path=/ и отсутствия Domain. Браузер молча
  // отбросит такую cookie по http, поэтому в production он обязателен, а в
  // dev — наоборот, недопустим.
  if (isProd && !env.SESSION_COOKIE_NAME.startsWith('__Host-')) {
    ctx.addIssue({
      code: 'custom',
      path: ['SESSION_COOKIE_NAME'],
      message: 'в production имя сессионной cookie обязано начинаться с __Host-',
    });
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
