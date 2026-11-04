import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  CreateServiceAccountRequestSchema,
  CreateWebhookRequestSchema,
  INTEGRATION_SCOPES,
  IntegrationTokenRequestSchema,
} from '@fifth/contracts';
import { resetEnvCache } from '../src/config/env';
import { parseOrThrow } from '../src/common/validation';
import { decodeIntegrationCursor, encodeIntegrationCursor } from '../src/common/keyset-cursor';
import { issueServiceToken, verifyServiceToken } from '../src/integration/service-auth';

/**
 * Юнит-тесты Integration API.
 *
 * Здесь проверяется то, чего живой прогон не покажет: устойчивость токена к
 * подделке отдельных частей, поведение курсора на испорченном входе и границы
 * схем запроса. Поведение маршрутов и изоляция ролей БД проверяются прогоном
 * по запущенному серверу и негативными тестами RLS.
 */

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
  KEK_WEBHOOK_SECRETS: Buffer.alloc(32, 11).toString('base64'),
};

/*
 * Обстановка теста задаётся ЦЕЛИКОМ, а не поверх машины.
 *
 * Прежде переменные подмешивались к настоящему process.env: результат
 * зависел от того, что лежит в окружении у запускающего, и проверка
 * конфигурации могла пройти или упасть по причине, к продукту отношения не
 * имеющей. Теперь окружение на время вызова ЗАМЕНЯЕТСЯ целиком и
 * восстанавливается в finally — даже если проверка упала.
 */
function withEnv<T>(fn: () => T, extra: NodeJS.ProcessEnv = {}): T {
  const saved = { ...process.env };
  resetEnvCache();
  process.env = { NODE_ENV: 'test', ...BASE_ENV, ...extra } as NodeJS.ProcessEnv;
  try {
    return fn();
  } finally {
    process.env = saved;
    resetEnvCache();
  }
}

beforeEach(() => {
  resetEnvCache();
});

describe('Токен сервисного клиента', () => {
  const input = {
    serviceAccountId: '018f2b7c-0000-7000-8000-000000000001',
    clientId: 'capital',
    scopes: ['webhooks:manage'],
    tokenEpoch: 1,
  };

  it('выпущенный токен проверяется и несёт свои скоупы', () => {
    withEnv(() => {
      const { token, expiresIn } = issueServiceToken(input);
      const payload = verifyServiceToken(token);
      expect(payload.sub).toBe(input.serviceAccountId);
      expect(payload.cid).toBe('capital');
      expect(payload.scopes).toEqual(input.scopes);
      expect(expiresIn).toBe(900);
    });
  });

  it('подделка полезной нагрузки ломает подпись', () => {
    withEnv(() => {
      const { token } = issueServiceToken(input);
      const [, signature] = token.split('.');
      const forged = Buffer.from(
        JSON.stringify({
          sub: input.serviceAccountId,
          cid: 'capital',
          scopes: [...INTEGRATION_SCOPES],
          exp: Math.floor(Date.now() / 1000) + 900,
          aud: 'integration',
        }),
        'utf8',
      ).toString('base64url');
      expect(() => verifyServiceToken(`${forged}.${signature}`)).toThrow();
    });
  });

  it('истёкший токен не принимается', () => {
    withEnv(
      () => {
        const { token } = issueServiceToken(input);
        // Срок нельзя «подправить» в самом токене — он под подписью. Поэтому
        // проверяем единственным честным способом: сдвигаем часы вперёд.
        expect(() => verifyServiceToken(token)).not.toThrow();
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date(Date.now() + 61_000));
          expect(() => verifyServiceToken(token)).toThrow();
        } finally {
          vi.useRealTimers();
        }
      },
      { INTEGRATION_TOKEN_TTL_SECONDS: '60' },
    );
  });

  it('токен пользовательской сессии не проходит как сервисный', () => {
    withEnv(() => {
      // Формат совпадает (body.mac), но контекст подписи другой — и это
      // единственное, что мешает подставить один токен вместо другого.
      const body = Buffer.from(
        JSON.stringify({ sub: 'user', roles: ['admin'], exp: Math.floor(Date.now() / 1000) + 900 }),
        'utf8',
      ).toString('base64url');
      const mac = createHmac('sha256', 'k'.repeat(64)).update(body).digest('base64url');
      expect(() => verifyServiceToken(`${body}.${mac}`)).toThrow();
    });
  });

  it('мусор вместо токена отвергается, а не роняет процесс', () => {
    withEnv(() => {
      for (const bad of ['', '.', 'abc', 'a.b.c', '!!!.???']) {
        expect(() => verifyServiceToken(bad)).toThrow();
      }
    });
  });

  // Рубеж аккаунта (M042, находка SEC-08). Сам токен по-прежнему проверяется
  // подписью и сроком; сверка рубежа с БД — работа гварда, здесь проверяется,
  // что рубеж вообще ДОЕЗЖАЕТ до проверяющего и не подделывается.
  it('рубеж аккаунта попадает в токен', () => {
    withEnv(() => {
      const { token } = issueServiceToken({ ...input, tokenEpoch: 7 });
      expect(verifyServiceToken(token).ep).toBe(7);
    });
  });

  it('подмена рубежа в токене ломает подпись', () => {
    withEnv(() => {
      const { token } = issueServiceToken({ ...input, tokenEpoch: 7 });
      const [body, signature] = token.split('.');
      const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as {
        ep: number;
      };
      payload.ep = 8; // «продлить» отозванный токен, вернув его к новому рубежу
      const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      expect(() => verifyServiceToken(`${forged}.${signature}`)).toThrow();
    });
  });
});

describe('Курсор Integration API', () => {
  it('переживает кодирование и декодирование', () => {
    const payload = { at: '2026-08-11T06:00:00.000Z', id: '018f2b7c-0000-7000-8000-000000000001' };
    expect(decodeIntegrationCursor(encodeIntegrationCursor(payload))).toEqual(payload);
  });

  it('подделанный курсор отвергается', () => {
    const forged = Buffer.from(JSON.stringify({ at: 'вчера', id: 'нет' }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeIntegrationCursor(forged)).toThrow();
    expect(() => decodeIntegrationCursor('не-base64url!!')).toThrow();
  });

  it('курсор без идентификатора не принимается: keyset без него неоднозначен', () => {
    const partial = Buffer.from(JSON.stringify({ at: '2026-08-11T06:00:00.000Z' })).toString(
      'base64url',
    );
    expect(() => decodeIntegrationCursor(partial)).toThrow();
  });
});

describe('Контракты Integration API', () => {
  it('секрет клиента короче 32 символов не принимается', () => {
    expect(() =>
      parseOrThrow(IntegrationTokenRequestSchema, { clientId: 'capital', clientSecret: 'x' }),
    ).toThrow();
  });

  it('client_id ограничен строгим набором символов', () => {
    for (const clientId of ['Capital', 'ca', 'client id', 'клиент', 'a'.repeat(65)]) {
      expect(
        CreateServiceAccountRequestSchema.safeParse({
          name: 'X',
          clientId,
          scopes: ['webhooks:manage'],
          mtlsCertFingerprint: 'a'.repeat(64),
        }).success,
      ).toBe(false);
    }
  });

  it('аккаунт без скоупов не создаётся: клиент без прав бессмыслен', () => {
    expect(
      CreateServiceAccountRequestSchema.safeParse({
        name: 'X',
        clientId: 'capital',
        scopes: [],
        mtlsCertFingerprint: 'a'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('вебхук принимает только https', () => {
    for (const url of ['http://example.org/hook', 'ftp://example.org', 'javascript:alert(1)']) {
      expect(CreateWebhookRequestSchema.safeParse({ url, subscribedVerbs: ['a.b'] }).success).toBe(
        false,
      );
    }
    expect(
      CreateWebhookRequestSchema.safeParse({
        url: 'https://example.org/hook',
        subscribedVerbs: ['lab.listing.published'],
      }).success,
    ).toBe(true);
  });

  it('подписка без единого события не создаётся', () => {
    expect(
      CreateWebhookRequestSchema.safeParse({ url: 'https://example.org', subscribedVerbs: [] })
        .success,
    ).toBe(false);
  });
});
