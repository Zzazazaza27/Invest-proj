import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env';
import { CryptoService, isKmsUnavailable } from '../src/crypto/crypto.service';

/**
 * Настоящий OpenBao, искусственные ключи. Запускается только из scripts/check-crypto-transit.mjs:
 * он поднимает контейнер и выдаёт токен с рабочей политикой ядра.
 */
const ADDR = process.env['LIVE_OPENBAO_ADDR'];
const TOKEN_PATH = process.env['LIVE_OPENBAO_TOKEN_PATH'];
const ROOT = process.env['LIVE_OPENBAO_ROOT'];

const vectors = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'crypto-legacy.json'), 'utf8'),
) as {
  seal: { plain: string; ciphertext: string; wrappedDek: string };
  kyb: { inn: string; innCiphertext: string; wrappedDek: string };
  direct: { plain: string; aad: string; payload: string };
  blindIndex: { value: string; kind: 'email' | 'phone' | 'inn'; index: string }[];
  contextHash: { value: string; hash: string }[];
};
const hex = (value: string): Buffer => Buffer.from(value, 'hex');
const key = (domain: string): string =>
  createHash('sha256').update(`fifth-vectors:${domain}`).digest('base64');

const COMMON: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://app:pw@localhost:5433/db',
  AUTH_MODE: 'local',
  LOCAL_AUTH_SIGNING_KEY: 'k'.repeat(64),
  CSRF_SIGNING_KEY: 'c'.repeat(64),
};
const LOCAL: NodeJS.ProcessEnv = {
  ...COMMON,
  KMS_MODE: 'local',
  KEK_SEARCH_INDEX: key('search_index'),
  KEK_PASSPORT_SENSITIVE: key('passport_sensitive'),
  KEK_KYB_DOCUMENTS: key('kyb_documents'),
  KEK_WEBHOOK_SECRETS: key('webhook_secrets'),
};
const TRANSIT: NodeJS.ProcessEnv = {
  ...COMMON,
  KMS_MODE: 'kms',
  OPENBAO_ADDR: ADDR ?? '',
  OPENBAO_TOKEN_PATH: TOKEN_PATH ?? '',
};
const VAULT: NodeJS.ProcessEnv = { ...TRANSIT, CRYPTO_WRITE_FORMAT: 'vault' };

async function inEnv<T>(env: NodeJS.ProcessEnv, fn: (c: CryptoService) => Promise<T>): Promise<T> {
  const saved = process.env;
  process.env = { ...env };
  resetEnvCache();
  try {
    return await fn(new CryptoService());
  } finally {
    process.env = saved;
    resetEnvCache();
  }
}

const admin = (path: string, method = 'POST', body?: object): Promise<Response> =>
  fetch(`${ADDR}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': ROOT ?? '', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe.skipIf(!ADDR)('CryptoService и настоящий Transit', () => {
  it('контрольные примеры прежнего сервиса читаются', async () => {
    await inEnv(TRANSIT, async (crypto) => {
      const { seal, kyb, direct } = vectors;
      const sealed = { ciphertext: hex(seal.ciphertext), wrappedDek: hex(seal.wrappedDek) };
      expect((await crypto.open('passport_sensitive', sealed)).toString('utf8')).toBe(seal.plain);
      const inn = await crypto.openField(
        'kyb_documents',
        hex(kyb.wrappedDek),
        hex(kyb.innCiphertext),
        'inn',
      );
      expect(inn.toString('utf8')).toBe(kyb.inn);
      const secret = await crypto.openDirect('webhook_secrets', hex(direct.payload), direct.aad);
      expect(secret.toString('utf8')).toBe(direct.plain);
    });
  });

  it('индексы и метки совпадают с прежними значениями', async () => {
    await inEnv(TRANSIT, async (crypto) => {
      for (const item of vectors.blindIndex) {
        expect((await crypto.blindIndex(item.value, item.kind)).toString('hex')).toBe(item.index);
      }
      for (const item of vectors.contextHash) {
        expect((await crypto.contextHash(item.value)).toString('hex')).toBe(item.hash);
      }
    });
  });

  it('запись переходного выпуска читает прежний путь, запись прежнего читает Transit', async () => {
    const fromTransit = await inEnv(TRANSIT, (c) => c.seal('passport_sensitive', 'значение'));
    const seenLocally = await inEnv(LOCAL, (c) => c.open('passport_sensitive', fromTransit));
    expect(seenLocally.toString('utf8')).toBe('значение');

    const fromLocal = await inEnv(LOCAL, (c) =>
      c.sealMany('passport_sensitive', { email: 'a@b.ru', phone: null }),
    );
    const seenInTransit = await inEnv(TRANSIT, (c) =>
      c.openField(
        'passport_sensitive',
        fromLocal.wrappedDek,
        fromLocal.ciphertexts.email!,
        'email',
      ),
    );
    expect(seenInTransit.toString('utf8')).toBe('a@b.ru');
  });

  it('новая версия ключа: новые записи её используют, старые читаются своей', async () => {
    const before = await inEnv(VAULT, (c) =>
      c.sealDirect('webhook_secrets', 'до смены', 'webhook:signing'),
    );
    expect(before.toString('ascii')).toMatch(/^vault:v1:/);
    expect((await admin('transit/keys/prod-webhook-secrets/rotate')).status).toBeLessThan(300);

    const after = await inEnv(VAULT, (c) =>
      c.sealDirect('webhook_secrets', 'после смены', 'webhook:signing'),
    );
    expect(after.toString('ascii')).toMatch(/^vault:v2:/);
    await inEnv(VAULT, async (crypto) => {
      const old = await crypto.openDirect('webhook_secrets', before, 'webhook:signing');
      expect(old.toString('utf8')).toBe('до смены');
      const fresh = await crypto.openDirect('webhook_secrets', after, 'webhook:signing');
      expect(fresh.toString('utf8')).toBe('после смены');
    });
  });

  it('переходный выпуск и после смены ключа пишет версией 1: прежний путь её понимает', async () => {
    const payload = await inEnv(TRANSIT, (c) =>
      c.sealDirect('webhook_secrets', 'переход', 'webhook:signing'),
    );
    const seen = await inEnv(LOCAL, (c) =>
      c.openDirect('webhook_secrets', payload, 'webhook:signing'),
    );
    expect(seen.toString('utf8')).toBe('переход');
  });

  it('новая версия ключа поиска не меняет индексы, пока версия не сменена настройкой', async () => {
    const before = await inEnv(TRANSIT, (c) => c.blindIndex('a@b.ru', 'email'));
    expect((await admin('transit/keys/prod-search-index/rotate')).status).toBeLessThan(300);
    const after = await inEnv(TRANSIT, (c) => c.blindIndex('a@b.ru', 'email'));
    expect(after.equals(before)).toBe(true);
  });

  it('чужой AAD и несуществующая версия не открывают запись', async () => {
    await inEnv(VAULT, async (crypto) => {
      const payload = await crypto.sealDirect('webhook_secrets', 'значение', 'webhook:signing');
      await expect(crypto.openDirect('webhook_secrets', payload, 'чужой')).rejects.toThrow(
        /повреждённые данные/,
      );
      const unknown = Buffer.from(
        payload.toString('ascii').replace(/^vault:v\d+:/, 'vault:v9:'),
        'ascii',
      );
      await expect(
        crypto.openDirect('webhook_secrets', unknown, 'webhook:signing'),
      ).rejects.toThrow(/повреждённые данные/);
    });
  });

  it('рабочая политика не даёт ни выгрузки, ни управления ключами', async () => {
    const token = readFileSync(TOKEN_PATH ?? '', 'utf8').trim();
    for (const [method, path] of [
      ['GET', 'transit/export/encryption-key/prod-webhook-secrets'],
      ['POST', 'transit/keys/prod-webhook-secrets/rotate'],
    ] as const) {
      const res = await fetch(`${ADDR}/v1/${path}`, {
        method,
        headers: { 'X-Vault-Token': token },
        signal: AbortSignal.timeout(10_000),
      });
      expect(res.status).toBe(403);
    }
  });

  it('отозванный токен — отказ службы, а не подмена ключа', async () => {
    const token = readFileSync(TOKEN_PATH ?? '', 'utf8').trim();
    const revoked = await admin('auth/token/revoke', 'POST', { token });
    expect(revoked.status).toBeLessThan(300);
    const failure = await inEnv(TRANSIT, (c) =>
      c.seal('passport_sensitive', 'значение').catch((e: unknown) => e),
    );
    expect(isKmsUnavailable(failure)).toBe(true);
  });
});
