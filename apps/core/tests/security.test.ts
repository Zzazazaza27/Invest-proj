import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { CryptoService } from '../src/crypto/crypto.service';
import { TokenVerifier } from '../src/auth/token.verifier';

/**
 * Юнит-тесты периметра безопасности. Проверяют то, что нельзя увидеть в
 * дымовом прогоне: комбинации конфигурации, которые обязаны ронять старт,
 * и криптографические инварианты.
 */

beforeEach(() => {
  resetEnvCache();
});

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://app:pw@localhost:5433/db',
  AUTH_MODE: 'local',
  LOCAL_AUTH_SIGNING_KEY: 'k'.repeat(64),
  KMS_MODE: 'local',
  KEK_SEARCH_INDEX: Buffer.alloc(32, 7).toString('base64'),
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

  function withEnv<T>(fn: () => T | Promise<T>): T | Promise<T> {
    const saved = { ...process.env };
    Object.assign(process.env, BASE_ENV, { NODE_ENV: 'development' });
    resetEnvCache();
    try {
      return fn();
    } finally {
      process.env = saved;
      resetEnvCache();
    }
  }

  it('валидный локальный токен принимается', async () => {
    await withEnv(async () => {
      const token = verifier.issueLocal({ subject: 'u1', roles: ['founder'], ttlSeconds: 60 });
      const result = await verifier.verify(token);
      expect(result.subject).toBe('u1');
      expect(result.roles).toEqual(['founder']);
    });
  });

  it('подделанная подпись отвергается', async () => {
    await withEnv(async () => {
      const token = verifier.issueLocal({ subject: 'u1', roles: ['founder'], ttlSeconds: 60 });
      const [body] = token.split('.');
      await expect(verifier.verify(`${body}.AAAA`)).rejects.toThrow();
    });
  });

  it('изменённая полезная нагрузка отвергается', async () => {
    await withEnv(async () => {
      const token = verifier.issueLocal({ subject: 'u1', roles: ['founder'], ttlSeconds: 60 });
      const [, signature] = token.split('.');
      const forged = Buffer.from(
        JSON.stringify({ sub: 'u1', roles: ['admin'], exp: Math.floor(Date.now() / 1000) + 60 }),
      ).toString('base64url');
      await expect(verifier.verify(`${forged}.${signature}`)).rejects.toThrow();
    });
  });

  it('истёкший токен отвергается', async () => {
    await withEnv(async () => {
      const token = verifier.issueLocal({ subject: 'u1', roles: [], ttlSeconds: -10 });
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
      expect(() => verifier.issueLocal({ subject: 'u', roles: [], ttlSeconds: 60 })).toThrow();
    } finally {
      process.env = saved;
      resetEnvCache();
    }
  });
});
