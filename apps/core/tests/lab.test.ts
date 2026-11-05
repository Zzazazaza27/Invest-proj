import { KMS_ENV } from './kms-env';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CatalogQuerySchema,
  CreateProjectRequestSchema,
  RequestUploadSchema,
} from '@fifth/contracts';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { parseOrThrow } from '../src/common/validation';
import { decodeCursor, encodeCursor } from '../src/lab/catalog.service';
import { S3Service, signingKey, toAmzDate } from '../src/storage/s3.service';

/**
 * Юнит-тесты фазы проектов и каталога.
 *
 * Здесь проверяется то, что дымовой прогон показать не может: форма подписи
 * загрузки, устойчивость курсора к подделке и границы схем запроса. Живое
 * поведение API проверяется отдельно, прогоном по запущенному серверу.
 */

beforeEach(() => {
  resetEnvCache();
});

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

const S3_ENV: NodeJS.ProcessEnv = {
  ...BASE_ENV,
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_BUCKET: 'unicorn-launch',
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_REGION: 'ru-central1',
  S3_FORCE_PATH_STYLE: 'true',
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
function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const saved = { ...process.env };
  resetEnvCache();
  process.env = { NODE_ENV: 'test', ...env } as NodeJS.ProcessEnv;
  try {
    return fn();
  } finally {
    process.env = saved;
    resetEnvCache();
  }
}

describe('Конфигурация хранилища', () => {
  it('половина настроек S3 не принимается: подпись вела бы в никуда', () => {
    expect(() => loadEnv({ ...BASE_ENV, S3_ENDPOINT: 'http://127.0.0.1:9000' })).toThrow(/S3/);
  });

  it('полная настройка принимается', () => {
    expect(() => loadEnv(S3_ENV)).not.toThrow();
  });

  it('в production обращение к хранилищу только по https', () => {
    expect(() =>
      loadEnv({
        ...S3_ENV,
        NODE_ENV: 'production',
        AUTH_MODE: 'oidc',
        OIDC_ISSUER: 'https://id.5espace.test',
        OIDC_AUDIENCE: 'launch',
        ...KMS_ENV,
        CORS_ALLOWED_ORIGINS: 'https://app.5espace.test',
        CORE_PUBLIC_URL: 'https://api.5espace.test',
      }),
    ).toThrow(/https/);
  });

  it('без настроек хранилища сервис честно объявляет себя ненастроенным', () => {
    withEnv(BASE_ENV, () => {
      expect(new S3Service().isConfigured).toBe(false);
    });
  });
});

describe('Подписанная загрузка', () => {
  const s3 = new S3Service();

  it('ключ объекта строит сервер: имя файла пользователя в путь не попадает', () => {
    const key = s3.buildMaterialKey(
      '018f0000-0000-7000-8000-000000000001',
      '018f0000-0000-7000-8000-000000000002',
      'deck',
    );
    expect(key).toBe(
      'projects/018f0000-0000-7000-8000-000000000001/materials/deck/018f0000-0000-7000-8000-000000000002',
    );
    expect(key).not.toContain('..');
  });

  it('policy ограничивает размер, тип и точный ключ', () => {
    withEnv(S3_ENV, () => {
      const form = s3.presignUpload({
        key: 'projects/p/materials/deck/m',
        contentType: 'application/pdf',
        maxBytes: 1024,
      });
      const policy = JSON.parse(Buffer.from(form.fields.policy!, 'base64').toString('utf8')) as {
        conditions: unknown[];
      };

      expect(policy.conditions).toContainEqual({ key: 'projects/p/materials/deck/m' });
      expect(policy.conditions).toContainEqual({ 'Content-Type': 'application/pdf' });
      expect(policy.conditions).toContainEqual(['content-length-range', 1, 1024]);
      expect(form.url).toBe('http://127.0.0.1:9000/unicorn-launch');
    });
  });

  it('подпись меняется при изменении любого условия', () => {
    withEnv(S3_ENV, () => {
      const a = s3.presignUpload({ key: 'k', contentType: 'application/pdf', maxBytes: 1024 });
      const b = s3.presignUpload({ key: 'k', contentType: 'application/pdf', maxBytes: 2048 });
      expect(a.fields['x-amz-signature']).not.toBe(b.fields['x-amz-signature']);
    });
  });

  it('секрет не попадает ни в одно поле формы', () => {
    withEnv(S3_ENV, () => {
      const form = s3.presignUpload({ key: 'k', contentType: 'application/pdf', maxBytes: 1024 });
      expect(JSON.stringify(form.fields)).not.toContain('test-secret');
    });
  });

  it('цепочка ключей SigV4 детерминирована и зависит от даты', () => {
    const a = signingKey('secret', '20260810', 'ru-central1', 's3').toString('hex');
    const b = signingKey('secret', '20260810', 'ru-central1', 's3').toString('hex');
    const c = signingKey('secret', '20260811', 'ru-central1', 's3').toString('hex');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('формат даты соответствует SigV4', () => {
    expect(toAmzDate(new Date('2026-08-10T12:34:56.789Z'))).toBe('20260810T123456Z');
  });
});

describe('Курсор каталога', () => {
  it('кодируется и читается обратно', () => {
    const cursor = encodeCursor({
      v: '2026-08-10T00:00:00.000Z',
      id: '018f0000-0000-7000-8000-000000000001',
    });
    expect(decodeCursor(cursor)).toEqual({
      v: '2026-08-10T00:00:00.000Z',
      id: '018f0000-0000-7000-8000-000000000001',
    });
  });

  it('мусор вместо курсора отвергается, а не разбирается частично', () => {
    expect(() => decodeCursor('не-base64-и-не-json')).toThrow();
    expect(() => decodeCursor(Buffer.from('{"v":1}').toString('base64url'))).toThrow();
  });

  it('идентификатор в курсоре обязан быть UUID: иначе это внедрение своей строки', () => {
    const forged = Buffer.from(JSON.stringify({ v: '1', id: "1' OR '1'='1" })).toString(
      'base64url',
    );
    expect(() => decodeCursor(forged)).toThrow();
  });

  it('слишком длинное значение курсора отвергается', () => {
    const forged = Buffer.from(
      JSON.stringify({ v: 'x'.repeat(200), id: '018f0000-0000-7000-8000-000000000001' }),
    ).toString('base64url');
    expect(() => decodeCursor(forged)).toThrow();
  });
});

describe('Схема запроса каталога', () => {
  it('лимит ограничен сверху: выдача не превращается в выгрузку базы', () => {
    expect(CatalogQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
    expect(CatalogQuerySchema.parse({}).limit).toBe(20);
  });

  it('сортировка — только из allowlist', () => {
    expect(CatalogQuerySchema.safeParse({ sort: 'listed_at_desc' }).success).toBe(true);
    expect(CatalogQuerySchema.safeParse({ sort: 'investment_ask; DROP TABLE' }).success).toBe(
      false,
    );
    // Сортировка по IRS объявлена в общем контракте, но каталогом не принимается:
    // скоринга ещё нет, и сортировать было бы не по чему.
    expect(CatalogQuerySchema.safeParse({ sort: 'irs_desc' }).success).toBe(false);
  });
});

describe('Схема запроса загрузки', () => {
  const base = {
    projectId: '018f0000-0000-7000-8000-000000000001',
    fileName: 'deck.pdf',
    sizeBytes: 1024,
  };

  it('тип содержимого — из allowlist', () => {
    expect(
      RequestUploadSchema.safeParse({ ...base, type: 'deck', contentType: 'application/pdf' })
        .success,
    ).toBe(true);
    expect(
      RequestUploadSchema.safeParse({ ...base, type: 'deck', contentType: 'text/html' }).success,
    ).toBe(false);
  });

  it('внешняя ссылка не загружается как файл', () => {
    expect(
      RequestUploadSchema.safeParse({
        ...base,
        type: 'product_link',
        contentType: 'application/pdf',
      }).success,
    ).toBe(false);
  });
});

describe('Валидация на границе', () => {
  const valid = {
    title: 'Проект',
    stage: 'mvp',
    taxonomyId: '018f0000-0000-7000-8000-000000000001',
    investmentAsk: '5000000.00',
    askCurrency: 'RUB',
  };

  it('корректное тело принимается', () => {
    expect(() => parseOrThrow(CreateProjectRequestSchema, valid)).not.toThrow();
  });

  it('неизвестное поле отвергается, а не отбрасывается молча', () => {
    // Поле, которого нет в контракте, — отказ, а не молчаливый пропуск: так
    // клиент не может протащить в проект служебный параметр.
    expect(() =>
      parseOrThrow(CreateProjectRequestSchema, {
        ...valid,
        requiredPlanId: '018f0000-0000-7000-8000-000000000009',
      }),
    ).toThrow();
  });

  it('опечатка в имени поля не проходит как «поле не задано»', () => {
    expect(() =>
      parseOrThrow(CreateProjectRequestSchema, { ...valid, tagLine: 'опечатка' }),
    ).toThrow();
  });
});
