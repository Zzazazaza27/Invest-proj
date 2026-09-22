import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { CryptoService } from '../src/crypto/crypto.service';
import { TokenVerifier } from '../src/auth/token.verifier';
import { TokenRevocationService } from '../src/auth/token-revocation.service';
import { createHmac } from 'node:crypto';
import { OpenApiController } from '../src/health/openapi.controller';
import { normalizedPath, rateLimitClass } from '../src/common/request-path';

/**
 * Юнит-тесты периметра безопасности. Проверяют то, что нельзя увидеть в
 * дымовом прогоне: комбинации конфигурации, которые обязаны ронять старт,
 * и криптографические инварианты.
 */

beforeEach(() => {
  resetEnvCache();
});

/** Идентификатор пользователя обязан быть UUID: на нём построены все политики RLS. */
const SUBJECT = '01890a5d-ac96-774b-bcce-b302099a8057';

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://app:pw@localhost:5433/db',
  AUTH_MODE: 'local',
  LOCAL_AUTH_SIGNING_KEY: 'k'.repeat(64),
  // CSRF-токен подписывается всегда, поэтому ключ обязателен при любой схеме
  // входа — конфигурация без него не проходит валидацию (SEC-12).
  CSRF_SIGNING_KEY: 'c'.repeat(64),
  KMS_MODE: 'local',
  KEK_SEARCH_INDEX: Buffer.alloc(32, 7).toString('base64'),
  // Остальные используемые KEK-домены: конфигурация проверяет все пять
  // на старте (Ф42), а не только blind index — ошибка ключа обязана
  // ронять запуск, а не всплывать на пользовательском запросе.
  KEK_PASSPORT_SENSITIVE: Buffer.alloc(32, 8).toString('base64'),
  KEK_KYB_DOCUMENTS: Buffer.alloc(32, 9).toString('base64'),
  KEK_INVESTMENT_DOCUMENTS: Buffer.alloc(32, 10).toString('base64'),
  KEK_WEBHOOK_SECRETS: Buffer.alloc(32, 11).toString('base64'),
  KEK_AI_PROVIDER_SECRETS: Buffer.alloc(32, 12).toString('base64'),
};

describe('Конфигурация: fail-closed в production', () => {
  it('локальный адаптер аутентификации не запускается в production', () => {
    expect(() =>
      loadEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        AUTH_MODE: 'local',
        CORS_ALLOWED_ORIGINS: 'https://app.unicorn.vc',
        CORE_PUBLIC_URL: 'https://api.unicorn.vc',
        KMS_MODE: 'kms',
      }),
    ).toThrow(/AUTH_MODE/);
  });

  it('локальные ключи шифрования не запускаются в production', () => {
    expect(() =>
      loadEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        AUTH_MODE: 'oidc',
        OIDC_ISSUER: 'https://id.unicorn.vc',
        OIDC_AUDIENCE: 'core',
        CORS_ALLOWED_ORIGINS: 'https://app.unicorn.vc',
        CORE_PUBLIC_URL: 'https://api.unicorn.vc',
        KMS_MODE: 'local',
      }),
    ).toThrow(/KMS_MODE/);
  });

  it("CORS '*' отвергается в любом режиме", () => {
    expect(() => loadEnv({ ...BASE_ENV, CORS_ALLOWED_ORIGINS: '*' })).toThrow(/CORS/);
  });

  it('в production Origin обязаны быть https', () => {
    expect(() =>
      loadEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        AUTH_MODE: 'oidc',
        OIDC_ISSUER: 'https://id.unicorn.vc',
        OIDC_AUDIENCE: 'core',
        KMS_MODE: 'kms',
        CORE_PUBLIC_URL: 'https://api.unicorn.vc',
        CORS_ALLOWED_ORIGINS: 'http://app.unicorn.vc',
      }),
    ).toThrow(/https/);
  });

  it('OIDC без audience не запускается: чужой токен был бы принят', () => {
    expect(() =>
      loadEnv({ ...BASE_ENV, AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://id.unicorn.vc' }),
    ).toThrow(/OIDC_AUDIENCE/);
  });

  it('короткий ключ подписи локального адаптера не принимается', () => {
    expect(() => loadEnv({ ...BASE_ENV, LOCAL_AUTH_SIGNING_KEY: 'short' })).toThrow(
      /LOCAL_AUTH_SIGNING_KEY/,
    );
  });

  it('раздутый суточный предел анализа не запускается в production', () => {
    expect(() =>
      loadEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        AUTH_MODE: 'oidc',
        OIDC_ISSUER: 'https://id.unicorn.vc',
        OIDC_AUDIENCE: 'core',
        KMS_MODE: 'kms',
        CORE_PUBLIC_URL: 'https://api.unicorn.vc',
        CORS_ALLOWED_ORIGINS: 'https://app.unicorn.vc',
        AI_ANALYSIS_DAILY_LIMIT: '1000',
      }),
    ).toThrow(/AI_ANALYSIS_DAILY_LIMIT/);
  });

  it('стендовый предел 1000 вне production принимается: пересчёт каталога не ломается', () => {
    const env = loadEnv({ ...BASE_ENV, AI_ANALYSIS_DAILY_LIMIT: '1000' });
    expect(env.AI_ANALYSIS_DAILY_LIMIT).toBe(1000);
  });

  it('корректная dev-конфигурация загружается', () => {
    const env = loadEnv({ ...BASE_ENV, CORS_ALLOWED_ORIGINS: 'http://localhost:5173' });
    expect(env.isProduction).toBe(false);
    expect(env.corsOrigins).toEqual(['http://localhost:5173']);
    // Дефолт привязки — loopback, а не 0.0.0.0 (RULES.md §3.2).
    expect(env.CORE_BIND_HOST).toBe('127.0.0.1');
  });
});

describe('Envelope encryption', () => {
  const crypto = new CryptoService();

  function withKeys<T>(fn: () => T): T {
    const saved = { ...process.env };
    resetEnvCache();
    Object.assign(process.env, {
      ...BASE_ENV,
      KEK_PASSPORT_SENSITIVE: Buffer.alloc(32, 3).toString('base64'),
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    });
    try {
      return fn();
    } finally {
      process.env = saved;
      resetEnvCache();
    }
  }

  it('nonce анализа детерминирован по входу и непредсказуем без ключа', () => {
    withKeys(() => {
      const a = crypto.analysisNonce('id|2026-08-26T00:00:00.000Z|Заголовок|Текст');
      const again = crypto.analysisNonce('id|2026-08-26T00:00:00.000Z|Заголовок|Текст');
      const other = crypto.analysisNonce('id|2026-08-26T00:00:00.000Z|Заголовок|Текст.');
      expect(a).toMatch(/^[0-9a-f]{32}$/);
      expect(again).toBe(a);
      expect(other).not.toBe(a);
      // Без серверного ключа маркер не воспроизвести: это не хеш входа.
      const plainHash = createHmac('sha256', '').update(a).digest('hex').slice(0, 32);
      expect(plainHash).not.toBe(a);
    });
  });

  it('значение расшифровывается обратно', () => {
    withKeys(() => {
      const sealed = crypto.seal('passport_sensitive', 'секрет');
      expect(crypto.open('passport_sensitive', sealed).toString('utf8')).toBe('секрет');
    });
  });

  it('подмена шифртекста обнаруживается тегом аутентичности', () => {
    withKeys(() => {
      const sealed = crypto.seal('passport_sensitive', 'секрет');
      const last = sealed.ciphertext.length - 1;
      sealed.ciphertext.writeUInt8(sealed.ciphertext.readUInt8(last) ^ 0xff, last);
      expect(() => crypto.open('passport_sensitive', sealed)).toThrow();
    });
  });

  it('каждое значение получает собственный DEK', () => {
    withKeys(() => {
      const a = crypto.seal('passport_sensitive', 'одно и то же');
      const b = crypto.seal('passport_sensitive', 'одно и то же');
      expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
      expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
    });
  });

  it('поля, зашифрованные одним DEK, нельзя поменять местами', () => {
    withKeys(() => {
      const sealed = crypto.sealMany('passport_sensitive', {
        email: 'a@b.ru',
        phone: '+79990000000',
      });
      // Расшифровка телефона под видом email не проходит проверку AAD.
      expect(() =>
        crypto.openField(
          'passport_sensitive',
          sealed.wrappedDek,
          sealed.ciphertexts.phone!,
          'email',
        ),
      ).toThrow();
    });
  });

  it('пустое поле остаётся пустым, а не превращается в шифртекст', () => {
    withKeys(() => {
      const sealed = crypto.sealMany('passport_sensitive', { email: 'a@b.ru', phone: null });
      expect(sealed.ciphertexts.phone).toBeNull();
    });
  });
});

describe('Blind index', () => {
  const crypto = new CryptoService();

  function withKeys<T>(fn: () => T): T {
    const saved = { ...process.env };
    Object.assign(process.env, BASE_ENV);
    resetEnvCache();
    try {
      return fn();
    } finally {
      process.env = saved;
      resetEnvCache();
    }
  }

  it('нормализует регистр email: иначе один адрес даст два аккаунта', () => {
    withKeys(() => {
      expect(crypto.blindIndex('User@Example.RU', 'email')).toEqual(
        crypto.blindIndex('user@example.ru', 'email'),
      );
    });
  });

  it('нормализует форматирование телефона', () => {
    withKeys(() => {
      expect(crypto.blindIndex('+7 (999) 000-00-00', 'phone')).toEqual(
        crypto.blindIndex('+79990000000', 'phone'),
      );
    });
  });

  it('разные значения дают разные индексы', () => {
    withKeys(() => {
      expect(crypto.blindIndex('a@b.ru', 'email')).not.toEqual(
        crypto.blindIndex('c@d.ru', 'email'),
      );
    });
  });

  it('одно значение в разных ролях даёт разные индексы', () => {
    withKeys(() => {
      expect(crypto.blindIndex('1234567890', 'inn')).not.toEqual(
        crypto.blindIndex('1234567890', 'phone'),
      );
    });
  });
});

describe('Проверка токена', () => {
  const verifier = new TokenVerifier();

  /**
   * Окружение на время одного теста.
   *
   * Помощник ОБЯЗАН дожидаться `fn`. Прежняя версия возвращала промис из `try`,
   * поэтому `finally` восстанавливал `process.env` уже на первом `await` внутри
   * теста: всё, что шло после первого ожидания, работало с ПУСТЫМ окружением.
   * Тесты этого не замечали, потому что конфигурация кешируется на первом
   * синхронном вызове, — то есть были зелёными по неверной причине.
   */
  async function withEnv<T>(fn: () => T | Promise<T>): Promise<T> {
    const saved = { ...process.env };
    Object.assign(process.env, BASE_ENV, { NODE_ENV: 'development' });
    resetEnvCache();
    try {
      return await fn();
    } finally {
      process.env = saved;
      resetEnvCache();
    }
  }

  it('валидный локальный токен принимается', async () => {
    await withEnv(async () => {
      const token = verifier.issueLocal({ subject: SUBJECT, roles: ['founder'], ttlSeconds: 60 });
      const result = await verifier.verify(token);
      expect(result.subject).toBe(SUBJECT);
      expect(result.roles).toEqual(['founder']);
    });
  });

  it('подделанная подпись отвергается', async () => {
    await withEnv(async () => {
      const token = verifier.issueLocal({ subject: SUBJECT, roles: ['founder'], ttlSeconds: 60 });
      const [body] = token.split('.');
      await expect(verifier.verify(`${body}.AAAA`)).rejects.toThrow();
    });
  });

  it('изменённая полезная нагрузка отвергается', async () => {
    await withEnv(async () => {
      const token = verifier.issueLocal({ subject: SUBJECT, roles: ['founder'], ttlSeconds: 60 });
      const [, signature] = token.split('.');
      const forged = Buffer.from(
        JSON.stringify({ sub: SUBJECT, roles: ['admin'], exp: Math.floor(Date.now() / 1000) + 60 }),
      ).toString('base64url');
      await expect(verifier.verify(`${forged}.${signature}`)).rejects.toThrow();
    });
  });

  it('истёкший токен отвергается', async () => {
    await withEnv(async () => {
      const token = verifier.issueLocal({ subject: SUBJECT, roles: [], ttlSeconds: -10 });
      await expect(verifier.verify(token)).rejects.toThrow();
    });
  });

  it('выпуск локального токена в production невозможен', () => {
    const saved = { ...process.env };
    Object.assign(process.env, BASE_ENV, {
      NODE_ENV: 'production',
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: 'https://id.unicorn.vc',
      OIDC_AUDIENCE: 'core',
      KMS_MODE: 'kms',
      CORE_PUBLIC_URL: 'https://api.unicorn.vc',
      CORS_ALLOWED_ORIGINS: 'https://app.unicorn.vc',
    });
    resetEnvCache();
    try {
      expect(() => verifier.issueLocal({ subject: SUBJECT, roles: [], ttlSeconds: 60 })).toThrow();
    } finally {
      process.env = saved;
      resetEnvCache();
    }
  });
});

describe('Ключ подписи CSRF', () => {
  it('обязателен при любой схеме входа', () => {
    // Токен без подписи не связан с сессией: подставленная чужая cookie снова
    // образовала бы согласованную пару с заголовком (SEC-12).
    expect(() => loadEnv({ ...BASE_ENV, CSRF_SIGNING_KEY: '' })).toThrow(/CSRF_SIGNING_KEY/);
    expect(() => loadEnv({ ...BASE_ENV, CSRF_SIGNING_KEY: 'короткий' })).toThrow(
      /CSRF_SIGNING_KEY/,
    );
  });

  it('не подменяется ключом сессий', () => {
    // Ключ сессий проверяется только при AUTH_MODE=local и в production может
    // быть пустым — использовать его для CSRF значило бы повторить SEC-01.
    const env = loadEnv({ ...BASE_ENV, CSRF_SIGNING_KEY: 'c'.repeat(64) });
    expect(env.CSRF_SIGNING_KEY).not.toBe(env.LOCAL_AUTH_SIGNING_KEY);
  });
});

describe('Транспорт до внутренних систем в production', () => {
  const PROD_ENV = {
    ...BASE_ENV,
    NODE_ENV: 'production',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example.org',
    OIDC_AUDIENCE: 'unicorn',
    KMS_MODE: 'kms',
    SESSION_COOKIE_NAME: '__Host-ul_session',
    CSRF_COOKIE_NAME: '__Host-ul_csrf',
    // Две разные переменные, и путать их нельзя: CORE_PUBLIC_URL — адрес API,
    // PUBLIC_BASE_URL — адрес, по которому платформу открывает человек (из него
    // собираются ссылки в письмах, Ф51). Когда-то здесь стояло только имя
    // PUBLIC_BASE_URL при несуществующей тогда переменной, и набор оставался
    // зелёным потому, что проверял текст ошибки, а не факт отказа.
    CORE_PUBLIC_URL: 'https://unicorn.example.org',
    PUBLIC_BASE_URL: 'https://unicorn.example.org',
    CORS_ALLOWED_ORIGINS: 'https://unicorn.example.org',
    DATABASE_SSL: 'true',
    // Задаётся явно: по умолчанию режим доставки — capture, а в production
    // он запрещён (M128). Правило пришло позже этой фикстуры, и позитивный
    // контроль «корректная конфигурация принимается» стал падать на
    // постороннем условии.
    WEBHOOK_DELIVERY_MODE: 'live',
  };

  it('открытое соединение с БД не проходит', () => {
    // Пароли, ПДн и события пошли бы внутри сети открытым текстом (SEC-09).
    expect(() => loadEnv({ ...PROD_ENV, DATABASE_SSL: 'false' })).toThrow(/DATABASE_SSL/);
  });

  it('брокер по nats:// не проходит', () => {
    expect(() => loadEnv({ ...PROD_ENV, NATS_URL: 'nats://broker:4222' })).toThrow(/NATS_URL/);
  });

  it('tls:// принимается', () => {
    // Контроль: правило запрещает открытый транспорт, а не подключение вообще.
    expect(() => loadEnv({ ...PROD_ENV, NATS_URL: 'tls://broker:4222' })).not.toThrow(/NATS_URL/);
  });

  it('production без общего счётчика частоты не поднимается', () => {
    // Счётчики в памяти процесса умножают разрешённую частоту на число
    // экземпляров, а перезапуск обнуляет их целиком (SEC-11).
    expect(() => loadEnv({ ...PROD_ENV, REDIS_URL: '' })).toThrow(/REDIS_URL/);
  });

  it('счётчик по открытому redis:// в production не проходит', () => {
    expect(() =>
      loadEnv({ ...PROD_ENV, REDIS_URL: 'redis://cache:6379', REDIS_PASSWORD: 'p'.repeat(24) }),
    ).toThrow(/REDIS_URL/);
  });

  it('счётчик без аутентификации в production не проходит', () => {
    expect(() =>
      loadEnv({ ...PROD_ENV, REDIS_URL: 'rediss://cache:6379', REDIS_PASSWORD: '' }),
    ).toThrow(/REDIS_PASSWORD/);
  });

  it('учётные данные внутри адреса счётчика запрещены в любом режиме', () => {
    // Пароль внутри URL попадает в логи подключения и в тексты ошибок как есть
    // — тот же довод, по которому у брокера логин и пароль вынесены отдельно.
    expect(() => loadEnv({ ...BASE_ENV, REDIS_URL: 'redis://:pw@localhost:6380' })).toThrow(
      /REDIS_URL/,
    );
  });

  it('корректная конфигурация счётчика принимается', () => {
    // Контроль: правила запрещают конкретные ошибки, а не счётчик как таковой.
    expect(() =>
      loadEnv({
        ...PROD_ENV,
        REDIS_URL: 'rediss://cache.internal:6379',
        REDIS_PASSWORD: 'p'.repeat(24),
      }),
    ).not.toThrow();
  });
});

describe('Строгий разбор токена (SEC-22)', () => {
  const verifier = new TokenVerifier();

  async function withEnv<T>(fn: () => T | Promise<T>): Promise<T> {
    const saved = { ...process.env };
    Object.assign(process.env, BASE_ENV, { NODE_ENV: 'development' });
    resetEnvCache();
    try {
      return await fn();
    } finally {
      process.env = saved;
      resetEnvCache();
    }
  }

  it('идентификатор пользователя обязан быть UUID', async () => {
    await withEnv(async () => {
      // Значение уходит в app.current_user_id, на котором построены ВСЕ
      // политики RLS: произвольная строка превращалась там в ошибку приведения
      // типа внутри запроса, то есть в 500 вместо честного отказа на входе.
      await expect(
        verifier.verify(signLocal({ sub: 'u1', roles: [], exp: nowPlus(60) })),
      ).rejects.toThrow();
      await expect(
        verifier.verify(signLocal({ sub: '', roles: [], exp: nowPlus(60) })),
      ).rejects.toThrow();
      await expect(
        verifier.verify(signLocal({ sub: 42, roles: [], exp: nowPlus(60) })),
      ).rejects.toThrow();
    });
  });

  it('неизвестная роль из токена отбрасывается', async () => {
    await withEnv(async () => {
      const verified = await verifier.verify(
        signLocal({
          sub: SUBJECT,
          roles: ['founder', 'system', 'superadmin', 42],
          exp: nowPlus(60),
        }),
      );
      // Иначе имя роли из claim'а становится частью выражения любой будущей
      // политики app.has_role(...), и новая политика задним числом расширяет
      // права уже выданных токенов.
      expect(verified.roles).toEqual(['founder']);
    });
  });

  it('неизвестный уровень аутентификации не принимается за признак', async () => {
    await withEnv(async () => {
      const forged = await verifier.verify(
        signLocal({ sub: SUBJECT, roles: [], acr: 'totally-mfa', exp: nowPlus(60) }),
      );
      expect(forged.acr).toBeNull();
      const real = await verifier.verify(
        signLocal({ sub: SUBJECT, roles: [], acr: 'mfa', exp: nowPlus(60) }),
      );
      // Контроль: allowlist не ломает настоящий признак второго фактора.
      expect(real.acr).toBe('mfa');
    });
  });
});

describe('Идентификатор токена и точечный отзыв (M038)', () => {
  const verifier = new TokenVerifier();

  /**
   * Окружение на время одного теста.
   *
   * Помощник ОБЯЗАН дожидаться `fn`. Прежняя версия возвращала промис из `try`,
   * поэтому `finally` восстанавливал `process.env` уже на первом `await` внутри
   * теста: всё, что шло после первого ожидания, работало с ПУСТЫМ окружением.
   * Тесты этого не замечали, потому что конфигурация кешируется на первом
   * синхронном вызове, — то есть были зелёными по неверной причине.
   */
  async function withEnv<T>(fn: () => T | Promise<T>): Promise<T> {
    const saved = { ...process.env };
    Object.assign(process.env, BASE_ENV, { NODE_ENV: 'development' });
    resetEnvCache();
    try {
      return await fn();
    } finally {
      process.env = saved;
      resetEnvCache();
    }
  }

  it('локальный токен получает идентификатор, и он разный у разных выпусков', async () => {
    await withEnv(async () => {
      const first = await verifier.verify(
        verifier.issueLocal({ subject: SUBJECT, roles: ['founder'], ttlSeconds: 60 }),
      );
      const second = await verifier.verify(
        verifier.issueLocal({ subject: SUBJECT, roles: ['founder'], ttlSeconds: 60 }),
      );
      expect(first.tokenId).toBeTruthy();
      expect(second.tokenId).toBeTruthy();
      // Одинаковый идентификатор означал бы, что отзыв одной сессии закрывает
      // все — ровно то, что рубеж сессий уже умеет и что здесь не нужно.
      expect(first.tokenId).not.toBe(second.tokenId);
    });
  });

  it('идентификатор вне допустимой длины отбрасывается, а не доходит до запроса', async () => {
    await withEnv(async () => {
      const forged = { sub: SUBJECT, roles: [], jti: 'x'.repeat(500), exp: nowPlus(60) };
      expect((await verifier.verify(signLocal(forged))).tokenId).toBeNull();
      expect((await verifier.verify(signLocal({ ...forged, jti: 'short' }))).tokenId).toBeNull();
      expect((await verifier.verify(signLocal({ ...forged, jti: 42 }))).tokenId).toBeNull();
    });
  });

  it('отзыв опрашивает реестр только при наличии идентификатора', async () => {
    const queried: (string | null)[] = [];
    const service = new TokenRevocationService({
      asServiceRole: async (
        _role: string,
        _ctx: unknown,
        work: (tx: unknown) => Promise<unknown>,
      ) => {
        queried.push('snapshot');
        return work({ query: async () => ({ rows: [{ jti: 'revoked-token-id' }] }) });
      },
    } as never);

    // Токен без идентификатора: отзывать нечего, реестр не трогаем.
    expect(await service.isRevoked(null)).toBe(false);
    expect(queried).toHaveLength(0);

    expect(await service.isRevoked('revoked-token-id')).toBe(true);
    expect(await service.isRevoked('another-token-id')).toBe(false);
    // Снимок читается один раз на окно, а не на каждую проверку.
    expect(queried).toHaveLength(1);
  });

  it('недоступный реестр не превращается в «токен действителен»', async () => {
    const service = new TokenRevocationService({
      asServiceRole: async () => {
        throw new Error('БД недоступна');
      },
    } as never);
    // Снимок прочитать не удалось: проверка обязана падать, а не отвечать «нет».
    await expect(service.isRevoked('some-token-id')).rejects.toThrow();
  });
});

function nowPlus(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

/**
 * Подписать произвольную полезную нагрузку ключом локального адаптера.
 *
 * Ключ берётся из BASE_ENV, а не из `process.env`: помощник `withEnv`
 * восстанавливает окружение синхронно, то есть уже на первом `await` внутри
 * асинхронного теста — к моменту вызова отсюда переменной там может не быть.
 */
function signLocal(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', BASE_ENV.LOCAL_AUTH_SIGNING_KEY as string)
    .update(body)
    .digest('base64url');
  return `${body}.${mac}`;
}

describe('Реконнесанс-поверхность (SEC-21)', () => {
  const PROD = {
    ...BASE_ENV,
    NODE_ENV: 'production',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example.org',
    OIDC_AUDIENCE: 'unicorn',
    KMS_MODE: 'kms',
    SESSION_COOKIE_NAME: '__Host-ul_session',
    CSRF_COOKIE_NAME: '__Host-ul_csrf',
    CORE_PUBLIC_URL: 'https://unicorn.example.org',
    // Адрес, по которому платформу открывает человек: из него собираются
    // ссылки в письмах, и в production он обязан быть https (Ф51).
    PUBLIC_BASE_URL: 'https://unicorn.example.org',
    CORS_ALLOWED_ORIGINS: 'https://unicorn.example.org',
    DATABASE_SSL: 'true',
    REDIS_URL: 'rediss://cache.internal:6379',
    REDIS_PASSWORD: 'p'.repeat(24),
  };

  /** Описание API строится из живого графа контроллеров; для теста он не нужен. */
  const controller = new OpenApiController({ getControllers: () => [] } as never);

  function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
    const saved = { ...process.env };
    process.env = { ...env };
    resetEnvCache();
    try {
      return fn();
    } finally {
      process.env = saved;
      resetEnvCache();
    }
  }

  it('в production описание API анониму не отдаётся', () => {
    withEnv(PROD, () => {
      // Документ перечисляет все маршруты, включая административные и
      // интеграционные: анониму это карта поверхности атаки одним запросом.
      expect(() => controller.document({ userId: null, roles: [], traceId: 't' })).toThrow();
    });
  });

  it('в production описание API отдаётся по сессии', () => {
    withEnv(PROD, () => {
      const doc = controller.document({ userId: SUBJECT, roles: ['founder'], traceId: 't' });
      expect(doc.openapi).toBe('3.1.0');
    });
  });

  it('вне production описание анониму ТОЖЕ закрыто', () => {
    withEnv({ ...BASE_ENV, NODE_ENV: 'development' }, () => {
      // Раньше здесь проверялось обратное: документ оставался открытым вне
      // production, потому что «разработке он нужен анонимно». 2026-09-13
      // выяснилось, чем это кончается: на боевом стенде стоял
      // NODE_ENV=development, и /v1/openapi.json отдавал 117 маршрутов кому
      // угодно — включая административные. Защита была написана, но снята
      // одним значением переменной.
      //
      // Теперь правило не про окружение, а про сессию. Разработке это не
      // мешает: локально вход есть, и следующая проверка это подтверждает.
      expect(() => controller.document({ userId: null, roles: [], traceId: 't' })).toThrow();
    });
  });

  it('вне production по сессии описание открывается', () => {
    withEnv({ ...BASE_ENV, NODE_ENV: 'development' }, () => {
      // Позитивный контроль: закрыли анониму, а не сломали документ вообще.
      const doc = controller.document({ userId: SUBJECT, roles: ['founder'], traceId: 't' });
      expect(doc.openapi).toBe('3.1.0');
    });
  });
});

describe('Потолок частоты по адресу', () => {
  it('порог не опускается ниже разумного', () => {
    // Потолок не заменяет классовые вёдра: слишком низкое значение начнёт
    // срабатывать раньше них и замаскирует их работу.
    const env = loadEnv({ ...BASE_ENV, RATE_LIMIT_IP_CEILING_PER_MIN: '600' });
    expect(env.RATE_LIMIT_IP_CEILING_PER_MIN).toBe(600);
    expect(() => loadEnv({ ...BASE_ENV, RATE_LIMIT_IP_CEILING_PER_MIN: '1' })).toThrow();
  });

  it('по умолчанию потолок выставлен, а не выключен', () => {
    // Отсутствие значения не должно означать «без потолка»: обход классового
    // ведра подделкой подсказки сессии тогда снова становится безграничным.
    expect(loadEnv({ ...BASE_ENV }).RATE_LIMIT_IP_CEILING_PER_MIN).toBeGreaterThan(0);
  });
});

describe('Классификация rate-limit по нормализованному пути (Ф40)', () => {
  it('обычный путь не меняется', () => {
    expect(normalizedPath('/v1/auth/login')).toBe('/v1/auth/login');
  });

  it('percent-encoded путь сводится к канону — обход класса auth закрыт', () => {
    // Именно этот запрос уходил из класса auth (30/мин) в default (120/мин).
    expect(normalizedPath('/v1/%61uth/login')).toBe('/v1/auth/login');
  });

  it('двойное кодирование тоже раскрывается', () => {
    expect(normalizedPath('/v1/%2561uth/login')).toBe('/v1/auth/login');
  });

  it('денежные маршруты не уводятся кодировкой', () => {
    expect(normalizedPath('/v1/billing/%70ayments')).toBe('/v1/billing/payments');
    expect(normalizedPath('/v1/investments/%61greements')).toBe('/v1/investments/agreements');
  });

  it('строка запроса отбрасывается', () => {
    expect(normalizedPath('/v1/auth/login?next=%2Fadmin')).toBe('/v1/auth/login');
  });

  it('верхний регистр приводится к нижнему', () => {
    expect(normalizedPath('/V1/AUTH/LOGIN')).toBe('/v1/auth/login');
  });

  it('битая кодировка не бросает исключение и не открывает обход', () => {
    // %zz не декодируется: возвращается предыдущее состояние, а не исключение,
    // которое уронило бы вычисление лимита (и, значит, сам лимит).
    expect(() => normalizedPath('/v1/auth/%zz')).not.toThrow();
    expect(normalizedPath('/v1/auth/%zz').startsWith('/v1/auth/')).toBe(true);
  });
});

/**
 * Класс входит в КЛЮЧ ведра, а не только в порог (Ф52).
 *
 * Плагин ограничения частоты держит один счётчик на ключ и сравнивает его с
 * порогом текущего запроса. Пока класс в ключ не входил, обычные чтения
 * кабинета набивали тот же счётчик, с которым потом сравнивался денежный порог
 * 10: одиннадцать безобидных `GET /v1/billing/subscriptions` — и ПЕРВОЕ
 * оформление подписки отвечало 429.
 */
describe('Классы ограничения частоты (Ф52)', () => {
  it('вход и выдача сервисного токена — класс auth', () => {
    expect(rateLimitClass('/v1/auth/login', 'POST')).toBe('auth');
    expect(rateLimitClass('/v1/integration/token', 'POST')).toBe('auth');
    // Все маршруты, где проверяется секрет, — мутации, и они в auth.
    expect(rateLimitClass('/v1/auth/register', 'POST')).toBe('auth');
    expect(rateLimitClass('/v1/auth/password/reset', 'POST')).toBe('auth');
    expect(rateLimitClass('/v1/auth/logout', 'POST')).toBe('auth');
  });

  it('чтение собственной сессии в класс входа НЕ попадает', () => {
    // Ведро auth считается по адресу целиком, поэтому `GET /v1/auth/me`
    // упирался в 30/мин на обычной работе: каждый кабинет спрашивает профиль
    // при загрузке, вкладок несколько. Интерфейс показывал это как выход из
    // аккаунта. Подбирать здесь нечего — секрета маршрут не принимает.
    expect(rateLimitClass('/v1/auth/me', 'GET')).toBe('default');
    expect(rateLimitClass('/v1/auth/authz/console', 'GET')).toBe('default');
    expect(rateLimitClass('/v1/auth/me', 'HEAD')).toBe('default');
  });

  it('послабление не распространяется на остальные GET под /v1/auth/', () => {
    // Здесь в запросе одноразовый токен из письма — это подбираемый секрет.
    expect(rateLimitClass('/v1/auth/email/verify/status', 'GET')).toBe('auth');
    expect(rateLimitClass('/v1/auth/consents/templates', 'GET')).toBe('auth');
    // И на мутацию того же пути: послабление только для чтения.
    expect(rateLimitClass('/v1/auth/me', 'POST')).toBe('auth');
  });

  it('percent-encoded чтение сессии классифицируется так же', () => {
    // Классификатор смотрит на нормализованный путь, поэтому обход
    // кодированием не даёт ни послабления, ни ужесточения.
    expect(rateLimitClass(normalizedPath('/v1/%61uth/me'), 'GET')).toBe('default');
    expect(rateLimitClass(normalizedPath('/v1/%61uth/login'), 'POST')).toBe('auth');
  });

  it('денежный класс — только мутации', () => {
    expect(rateLimitClass('/v1/billing/subscriptions', 'POST')).toBe('money');
    expect(rateLimitClass('/v1/billing/payments', 'POST')).toBe('money');
    expect(rateLimitClass('/v1/investments/agreements', 'POST')).toBe('money');
    expect(rateLimitClass('/v1/investments/tranches/confirm', 'POST')).toBe('money');
    // Чтение своих счетов и подписок в денежный класс НЕ попадает: иначе
    // пользователь упирался бы в 429 на обычном просмотре кабинета.
    expect(rateLimitClass('/v1/billing/subscriptions', 'GET')).toBe('default');
    expect(rateLimitClass('/v1/billing/invoices', 'GET')).toBe('default');
  });

  it('административный и общий классы различаются', () => {
    expect(rateLimitClass('/v1/admin/plans', 'GET')).toBe('admin');
    expect(rateLimitClass('/v1/projects', 'GET')).toBe('default');
  });

  it('класс денег и класс чтения — РАЗНЫЕ, поэтому и вёдра разные', () => {
    // Это и есть суть исправления: пока оба класса совпадали бы, чтения и
    // мутации делили бы один счётчик.
    expect(rateLimitClass('/v1/billing/subscriptions', 'GET')).not.toBe(
      rateLimitClass('/v1/billing/subscriptions', 'POST'),
    );
  });
});
