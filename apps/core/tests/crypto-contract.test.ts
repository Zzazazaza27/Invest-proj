import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getEnv, loadEnv, resetEnvCache } from '../src/config/env';
import { CryptoService, isKmsUnavailable } from '../src/crypto/crypto.service';
import { legacyToVault, vaultToLegacy } from '../src/crypto/key-format';

/**
 * Контракты шифрования (блок 5, задание 4).
 *
 * Контрольные примеры сняты с настоящего прежнего синхронного CryptoService. Transit здесь —
 * заглушка с той же раскладкой байтов; настоящий OpenBao проверяет scripts/check-crypto-transit.mjs.
 */
const vectors = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'crypto-legacy.json'), 'utf8'),
) as Vectors;

interface Vectors {
  seal: { domain: 'passport_sensitive'; plain: string; ciphertext: string; wrappedDek: string };
  sealAad: Vectors['seal'] & { aad: string };
  sealMany: {
    domain: 'passport_sensitive';
    email: string;
    ciphertext: string;
    phone: null;
    wrappedDek: string;
  };
  kyb: {
    domain: 'kyb_documents';
    inn: string;
    ogrn: string;
    innCiphertext: string;
    ogrnCiphertext: string;
    wrappedDek: string;
  };
  direct: { domain: 'webhook_secrets'; plain: string; aad: string; payload: string };
  blindIndex: { value: string; kind: 'email' | 'phone' | 'inn'; index: string }[];
  contextHash: { value: string; hash: string }[];
}

const DOMAINS = ['passport_sensitive', 'kyb_documents', 'webhook_secrets', 'search_index'] as const;
const keyOf = (domain: string): Buffer =>
  createHash('sha256').update(`fifth-vectors:${domain}`).digest();
const hex = (value: string): Buffer => Buffer.from(value, 'hex');

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
  KEK_SEARCH_INDEX: keyOf('search_index').toString('base64'),
  KEK_PASSPORT_SENSITIVE: keyOf('passport_sensitive').toString('base64'),
  KEK_KYB_DOCUMENTS: keyOf('kyb_documents').toString('base64'),
  KEK_WEBHOOK_SECRETS: keyOf('webhook_secrets').toString('base64'),
};

async function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const saved = process.env;
  process.env = { ...env };
  resetEnvCache();
  try {
    return await fn();
  } finally {
    process.env = saved;
    resetEnvCache();
  }
}

// ---- заглушка Transit: ключи те же, байты как в OpenBao: iv || ciphertext || tag ---------------
let server: Server;
let dir: string;
let transitEnv: NodeJS.ProcessEnv;
let down = false;
const calls: string[] = [];

function domainOf(name: string): string {
  return name.replace(/^prod-/, '').replaceAll('-', '_');
}

function answer(path: string, body: Record<string, string | number>): [number, object] {
  const [, op, name] = path.split('/').slice(2);
  const key = keyOf(domainOf(name!));
  const aad = Buffer.from(String(body['associated_data'] ?? ''), 'base64');
  if (op === 'encrypt') {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    const data = Buffer.concat([
      cipher.update(Buffer.from(String(body['plaintext']), 'base64')),
      cipher.final(),
    ]);
    const raw = Buffer.concat([iv, data, cipher.getAuthTag()]).toString('base64');
    return [200, { data: { ciphertext: `vault:v${body['key_version'] ?? 2}:${raw}` } }];
  }
  if (op === 'decrypt') {
    const match = /^vault:v([12]):(.+)$/.exec(String(body['ciphertext']));
    if (!match) return [400, { errors: ['версия'] }];
    const raw = Buffer.from(match[2]!, 'base64');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), {
        authTagLength: 16,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const plain = Buffer.concat([
        decipher.update(raw.subarray(12, raw.length - 16)),
        decipher.final(),
      ]);
      return [200, { data: { plaintext: plain.toString('base64') } }];
    } catch {
      return [400, { errors: ['расшифровка'] }];
    }
  }
  const digest = createHmac('sha256', key)
    .update(Buffer.from(String(body['input']), 'base64'))
    .digest('base64');
  return [200, { data: { hmac: `vault:v${body['key_version']}:${digest}` } }];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crypto-contract-'));
  writeFileSync(join(dir, 'token'), 'искусственный\n'.replace('искусственный', 'lab-token'));
  server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    req.on('end', () => {
      calls.push(req.url ?? '');
      const [status, reply] = down
        ? [503, { errors: ['sealed'] }]
        : answer(req.url ?? '', JSON.parse(text) as Record<string, string>);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  transitEnv = {
    ...COMMON,
    KMS_MODE: 'kms',
    OPENBAO_ADDR: `http://127.0.0.1:${port}`,
    OPENBAO_TOKEN_PATH: join(dir, 'token'),
  };
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

/** Все контрольные примеры одним набором: и местные ключи, и Transit обязаны их читать. */
async function readsVectors(crypto: CryptoService): Promise<void> {
  const { seal, sealAad, sealMany, kyb, direct } = vectors;
  const sealed = { ciphertext: hex(seal.ciphertext), wrappedDek: hex(seal.wrappedDek) };
  expect((await crypto.open(seal.domain, sealed)).toString('utf8')).toBe(seal.plain);
  const withAad = { ciphertext: hex(sealAad.ciphertext), wrappedDek: hex(sealAad.wrappedDek) };
  expect((await crypto.open(sealAad.domain, withAad, sealAad.aad)).toString('utf8')).toBe(
    sealAad.plain,
  );
  const email = await crypto.openField(
    sealMany.domain,
    hex(sealMany.wrappedDek),
    hex(sealMany.ciphertext),
    'email',
  );
  expect(email.toString('utf8')).toBe(sealMany.email);
  const opened = await crypto.openFields(kyb.domain, hex(kyb.wrappedDek), {
    inn: hex(kyb.innCiphertext),
    ogrn: hex(kyb.ogrnCiphertext),
  });
  expect(opened.inn?.toString('utf8')).toBe(kyb.inn);
  expect(opened.ogrn?.toString('utf8')).toBe(kyb.ogrn);
  const secret = await crypto.openDirect(direct.domain, hex(direct.payload), direct.aad);
  expect(secret.toString('utf8')).toBe(direct.plain);
  for (const item of vectors.blindIndex) {
    expect((await crypto.blindIndex(item.value, item.kind)).toString('hex')).toBe(item.index);
  }
  for (const item of vectors.contextHash) {
    expect((await crypto.contextHash(item.value)).toString('hex')).toBe(item.hash);
  }
}

describe('Контрольные примеры прежнего CryptoService', () => {
  it('читаются местными ключами', async () => {
    await withEnv(LOCAL, () => readsVectors(new CryptoService()));
  });

  it('читаются через Transit без подбора ключей', async () => {
    await withEnv(transitEnv, () => readsVectors(new CryptoService()));
  });

  it('нормализация индексов сохранена', () => {
    const [a, b, c, d, e, f] = vectors.blindIndex.map((item) => item.index);
    expect(a).toBe(b);
    expect(c).toBe(d);
    expect(e).toBe(f);
  });

  it('раскладка байтов переводится без потерь', () => {
    const payload = hex(vectors.direct.payload);
    expect(vaultToLegacy(legacyToVault(payload)).equals(payload)).toBe(true);
  });
});

describe('Режим записи отделён от места хранения ключа', () => {
  const written = async (env: NodeJS.ProcessEnv) =>
    withEnv(env, async () => {
      const crypto = new CryptoService();
      return {
        sealed: await crypto.seal('passport_sensitive', 'значение'),
        many: await crypto.sealMany('kyb_documents', { inn: '7707083893', ogrn: null }),
        direct: await crypto.sealDirect('webhook_secrets', 'секрет', 'webhook:signing'),
      };
    });

  it('переходный выпуск пишет прежний формат: его читает прежний путь', async () => {
    const out = await written({ ...transitEnv, CRYPTO_WRITE_FORMAT: 'legacy' });
    expect(out.sealed.wrappedDek.subarray(0, 6).toString('latin1')).not.toBe('vault:');
    await withEnv(LOCAL, async () => {
      const crypto = new CryptoService();
      expect((await crypto.open('passport_sensitive', out.sealed)).toString('utf8')).toBe(
        'значение',
      );
      const inn = await crypto.openField(
        'kyb_documents',
        out.many.wrappedDek,
        out.many.ciphertexts.inn!,
        'inn',
      );
      expect(inn.toString('utf8')).toBe('7707083893');
      const secret = await crypto.openDirect('webhook_secrets', out.direct, 'webhook:signing');
      expect(secret.toString('utf8')).toBe('секрет');
    });
  });

  it('запись местного ядра читается переходным выпуском', async () => {
    const out = await written(LOCAL);
    await withEnv(transitEnv, async () => {
      const crypto = new CryptoService();
      expect((await crypto.open('passport_sensitive', out.sealed)).toString('utf8')).toBe(
        'значение',
      );
    });
  });

  it('новый формат хранит версию внутри и читается обратно', async () => {
    const env = { ...transitEnv, CRYPTO_WRITE_FORMAT: 'vault' };
    const out = await written(env);
    expect(out.direct.toString('ascii')).toMatch(/^vault:v2:/);
    await withEnv(env, async () => {
      const crypto = new CryptoService();
      expect((await crypto.open('passport_sensitive', out.sealed)).toString('utf8')).toBe(
        'значение',
      );
    });
  });

  it('местные ключи запись vault не читают и не угадывают', async () => {
    const out = await written({ ...transitEnv, CRYPTO_WRITE_FORMAT: 'vault' });
    await withEnv(LOCAL, async () => {
      await expect(
        new CryptoService().openDirect('webhook_secrets', out.direct, 'webhook:signing'),
      ).rejects.toThrow(/vault/);
    });
  });

  it('повреждённый новый формат — отказ, а не чтение прежним способом', async () => {
    await withEnv(transitEnv, async () => {
      const crypto = new CryptoService();
      for (const text of ['vault:', 'vault:v1:', 'vault:vX:AAAA', 'vault:v0:AAAA', 'vault:v1:!!']) {
        calls.length = 0;
        await expect(
          crypto.openDirect('webhook_secrets', Buffer.from(text, 'ascii'), 'webhook:signing'),
        ).rejects.toThrow(/повреждённые данные/);
        expect(calls).toEqual([]);
      }
    });
  });

  it('неизвестная версия ключа — отказ', async () => {
    await withEnv(transitEnv, async () => {
      const raw = randomBytes(40).toString('base64');
      await expect(
        new CryptoService().openDirect(
          'webhook_secrets',
          Buffer.from(`vault:v9:${raw}`, 'ascii'),
          'webhook:signing',
        ),
      ).rejects.toThrow(/повреждённые данные/);
    });
  });

  it('чужой AAD не открывает запись', async () => {
    await withEnv(transitEnv, async () => {
      await expect(
        new CryptoService().openDirect(
          vectors.direct.domain,
          hex(vectors.direct.payload),
          'чужой-контекст',
        ),
      ).rejects.toThrow(/повреждённые данные/);
    });
  });
});

describe('Отказ службы ключей', () => {
  it('отказывает операции и не откатывается к ключу из окружения', async () => {
    down = true;
    try {
      await withEnv(transitEnv, async () => {
        // Настройки такого не пропускают: ключ появляется уже после проверки при запуске.
        getEnv();
        process.env['KEK_PASSPORT_SENSITIVE'] = LOCAL['KEK_PASSPORT_SENSITIVE'];
        const crypto = new CryptoService();
        const failure = await crypto
          .seal('passport_sensitive', 'значение')
          .catch((e: unknown) => e);
        expect(isKmsUnavailable(failure)).toBe(true);
        const index = await crypto.blindIndex('a@b.ru', 'email').catch((e: unknown) => e);
        expect(isKmsUnavailable(index)).toBe(true);
      });
    } finally {
      down = false;
    }
  });

  it('ключ данных очищается и при отказе упаковки', async () => {
    down = true;
    try {
      await withEnv(transitEnv, async () => {
        const crypto = new CryptoService();
        const seen: Buffer[] = [];
        const target = crypto as unknown as {
          encrypt: (key: Buffer, ...rest: unknown[]) => Buffer;
        };
        const original = target.encrypt.bind(crypto);
        target.encrypt = (key, ...rest) => {
          seen.push(key);
          return original(key, ...rest);
        };
        await expect(crypto.sealMany('passport_sensitive', { email: 'a@b.ru' })).rejects.toThrow();
        await expect(crypto.seal('passport_sensitive', 'значение')).rejects.toThrow();
        expect(seen).toHaveLength(2);
        for (const key of seen) expect(key.every((byte) => byte === 0)).toBe(true);
      });
    } finally {
      down = false;
    }
  });
});

describe('Настройки', () => {
  const load = (extra: NodeJS.ProcessEnv) => () => loadEnv({ ...COMMON, ...extra });
  const transit = {
    KMS_MODE: 'kms',
    OPENBAO_ADDR: 'http://127.0.0.1:8200',
    OPENBAO_TOKEN_PATH: '/t',
  };

  it('рабочий режим Transit загружается', () => {
    expect(load(transit)().CRYPTO_WRITE_FORMAT).toBe('legacy');
  });

  it('формат vault без Transit запрещён', () => {
    expect(load({ ...LOCAL, CRYPTO_WRITE_FORMAT: 'vault' })).toThrow(/CRYPTO_WRITE_FORMAT/);
  });

  it('KEK в окружении при Transit запрещён', () => {
    expect(load({ ...transit, KEK_SEARCH_INDEX: 'x' })).toThrow(/KEK_SEARCH_INDEX/);
  });

  it('Transit без адреса и токена не запускается', () => {
    expect(load({ KMS_MODE: 'kms' })).toThrow(/OPENBAO_ADDR/);
    expect(load({ KMS_MODE: 'kms', OPENBAO_ADDR: 'https://a' })).toThrow(/OPENBAO_CA_PATH/);
  });

  it('значение KEK не попадает в сообщение об ошибке', () => {
    expect(load({ ...transit, KEK_SEARCH_INDEX: 'значение-ключа' })).not.toThrow(/значение-ключа/);
  });

  it('домены проверены все', () => {
    expect(DOMAINS).toHaveLength(4);
  });
});
