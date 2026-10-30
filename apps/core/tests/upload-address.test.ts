import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { AppError } from '../src/common/errors';
import { S3Service } from '../src/storage/s3.service';

/**
 * Публичный адрес загрузки (блок 4, «Вход и файлы MVP»; 2.1-W06).
 *
 * Форма уходит в браузер пользователя. На внешнем стенде форма с адресом
 * петли вела бы браузер на его же компьютер — так было на VPS до W06. Её ядро
 * не выдаёт; стенд, где и платформа на петле, работает как раньше.
 */

const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://app:pw@localhost:5433/db',
  AUTH_MODE: 'local',
  LOCAL_AUTH_SIGNING_KEY: 'k'.repeat(64),
  CSRF_SIGNING_KEY: 'c'.repeat(64),
  KMS_MODE: 'local',
  KEK_SEARCH_INDEX: Buffer.alloc(32, 7).toString('base64'),
  KEK_PASSPORT_SENSITIVE: Buffer.alloc(32, 8).toString('base64'),
  KEK_KYB_DOCUMENTS: Buffer.alloc(32, 9).toString('base64'),
  KEK_WEBHOOK_SECRETS: Buffer.alloc(32, 11).toString('base64'),
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'unicorn-launch',
  S3_ACCESS_KEY_ID: 'probe',
  S3_SECRET_ACCESS_KEY: 'probe-secret',
};

const saved = { ...process.env };
function withEnv<T>(extra: NodeJS.ProcessEnv, fn: () => T): T {
  resetEnvCache();
  process.env = { ...BASE, ...extra };
  try {
    return fn();
  } finally {
    process.env = { ...saved };
    resetEnvCache();
  }
}
afterEach(() => resetEnvCache());

const form = (s3: S3Service) =>
  s3.presignUpload({ key: 'k', contentType: 'application/pdf', maxBytes: 10 });

describe('Публичный адрес загрузки', () => {
  it('локальный стенд: форма на внутренний адрес, как раньше', () => {
    withEnv({ PUBLIC_BASE_URL: 'http://127.0.0.1' }, () => {
      const s3 = new S3Service();
      expect(s3.uploadAddressProblem()).toBeNull();
      expect(form(s3).url).toBe('http://localhost:9000/unicorn-launch');
    });
  });

  it('внешний стенд без публичного адреса: форму НЕ выдаёт, причина названа', () => {
    withEnv({ PUBLIC_BASE_URL: 'https://5espace.com' }, () => {
      const s3 = new S3Service();
      expect(s3.uploadAddressProblem()).toMatch(/S3_PUBLIC_ENDPOINT/);
      expect(() => form(s3)).toThrow(AppError);
    });
  });

  it('внешний стенд с публичным адресом: форма на него, ядро — по внутреннему', () => {
    withEnv(
      { PUBLIC_BASE_URL: 'https://5espace.com', S3_PUBLIC_ENDPOINT: 'https://files.5espace.com' },
      () => {
        const s3 = new S3Service();
        expect(s3.uploadAddressProblem()).toBeNull();
        expect(form(s3).url).toBe('https://files.5espace.com/unicorn-launch');
      },
    );
  });

  it('публичный адрес петлёй на внешнем стенде — тоже отказ', () => {
    withEnv(
      { PUBLIC_BASE_URL: 'https://5espace.com', S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000' },
      () => {
        expect(new S3Service().uploadAddressProblem()).not.toBeNull();
      },
    );
  });
});

describe('Конфигурация хранилища', () => {
  const prod = {
    ...BASE,
    NODE_ENV: 'production',
    AUTH_MODE: 'oidc',
    PUBLIC_BASE_URL: 'https://5espace.com',
  };

  it('публичный адрес — только http(s) URL', () => {
    expect(() => loadEnv({ ...BASE, S3_PUBLIC_ENDPOINT: 'files.5espace.com' })).toThrow(
      /S3_PUBLIC_ENDPOINT/,
    );
  });

  it('в production публичный адрес по http не принимается', () => {
    expect(() => loadEnv({ ...prod, S3_PUBLIC_ENDPOINT: 'http://files.5espace.com' })).toThrow(
      /S3_PUBLIC_ENDPOINT: в production публичный адрес загрузки — только https/,
    );
  });

  it('внутренний адрес по http вне узла в production не принимается', () => {
    expect(() => loadEnv({ ...prod, S3_ENDPOINT: 'http://storage.internal:9000' })).toThrow(
      /S3_ENDPOINT: в production обращение к хранилищу вне узла/,
    );
  });

  it('срок формы материала по умолчанию — 95 минут', () => {
    expect(loadEnv(BASE).MATERIAL_UPLOAD_FORM_TTL_SECONDS).toBe(5700);
  });
});
