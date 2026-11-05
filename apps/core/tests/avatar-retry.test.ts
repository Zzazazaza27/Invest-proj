import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errors } from '../src/common/errors';
import { resetEnvCache } from '../src/config/env';
import type { RequestContext, Tx } from '../src/db/unit-of-work';
import { ProfileService } from '../src/identity/profile.service';

/**
 * Завершение загрузки аватара при отказе (блок 5, задание 4). Исходник удаляется последним:
 * пока профиль не собран, повтор обязан найти тот же файл.
 */
vi.mock('../src/storage/s3.service', async (original) => ({
  ...(await original<typeof import('../src/storage/s3.service')>()),
  putObject: vi.fn(async () => undefined),
}));

const USER = '01890a5d-ac96-774b-bcce-b302099a8057';
const ctx = { userId: USER, traceId: 't', roles: ['founder'] } as unknown as RequestContext;
const row = {
  id: USER,
  display_name: 'Имя',
  primary_role: 'founder',
  status: 'active',
  locale: 'ru-RU',
  service_country: null,
  created_at: new Date(0),
  has_password: true,
  email_ciphertext: Buffer.from('e'),
  phone_ciphertext: null,
  contact_wrapped_dek: Buffer.from('d'),
  avatar_updated_at: null,
  avatar_variants: null,
};

let image: Buffer;
let stored: Buffer | null;
let written: number;
let keysDown: boolean;
let writeFails: boolean;
let readFails: boolean;

const tx = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes('INSERT INTO identity.user_avatars')) written += 1;
    if (sql.includes('FROM identity.users u')) return { rows: [row] };
    if (sql.includes('UPDATE identity.users')) return { rows: [], rowCount: 1 };
    return { rows: [] };
  }),
} as unknown as Tx;

const service = new ProfileService(
  {
    transaction: async (_: unknown, fn: (t: Tx) => Promise<unknown>) => {
      if (writeFails) throw new Error('база недоступна');
      return fn(tx);
    },
    readOnly: async (_: unknown, fn: (t: Tx) => Promise<unknown>) => {
      if (readFails) throw new Error('база недоступна');
      return fn(tx);
    },
  } as never,
  {
    openFields: async () => {
      if (keysDown) throw errors.upstreamUnavailable('kms');
      return { email: Buffer.from('a@b.ru'), phone: null };
    },
  } as never,
  { emit: async () => undefined } as never,
  {} as never,
  {} as never,
  {
    isConfigured: true,
    getObject: async () => (stored ? { body: stored } : null),
    deleteObject: async () => {
      stored = null;
    },
  } as never,
);

beforeEach(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://app:pw@localhost:5433/db',
    AUTH_MODE: 'local',
    LOCAL_AUTH_SIGNING_KEY: 'k'.repeat(64),
    CSRF_SIGNING_KEY: 'c'.repeat(64),
    KMS_MODE: 'local',
    KEK_SEARCH_INDEX: Buffer.alloc(32, 7).toString('base64'),
    KEK_PASSPORT_SENSITIVE: Buffer.alloc(32, 8).toString('base64'),
    KEK_KYB_DOCUMENTS: Buffer.alloc(32, 9).toString('base64'),
    KEK_WEBHOOK_SECRETS: Buffer.alloc(32, 11).toString('base64'),
  });
  resetEnvCache();
  image ??= await sharp({
    create: { width: 400, height: 400, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();
  stored = image;
  written = 0;
  keysDown = false;
  writeFails = false;
  readFails = false;
});

describe('Завершение загрузки аватара', () => {
  it('отказ службы ключей не мешает: контакты помечены недоступными, а не пустыми', async () => {
    keysDown = true;
    const profile = await service.finalizeAvatar(ctx);
    expect(written).toBe(1);
    expect(profile.contactsAvailable).toBe(false);
    expect(profile.emailMasked).toBeNull();
    expect(stored).toBeNull();
  });

  it('сбой чтения профиля после записи: исходник цел, повтор проходит', async () => {
    readFails = true;
    await expect(service.finalizeAvatar(ctx)).rejects.toThrow();
    expect(written).toBe(1);
    expect(stored).not.toBeNull();

    readFails = false;
    const profile = await service.finalizeAvatar(ctx);
    expect(profile.contactsAvailable).toBe(true);
    expect(profile.emailMasked).not.toBeNull();
    expect(stored).toBeNull();
  });

  it('правка имени не зависит от службы ключей', async () => {
    keysDown = true;
    const profile = await service.updateName(ctx, 'Новое имя');
    expect(profile.contactsAvailable).toBe(false);
  });

  it('отказ записи в базу: исходник цел, повтор проходит', async () => {
    writeFails = true;
    await expect(service.finalizeAvatar(ctx)).rejects.toThrow();
    expect(stored).not.toBeNull();

    writeFails = false;
    await service.finalizeAvatar(ctx);
    expect(written).toBe(1);
    expect(stored).toBeNull();
  });

  it('обычный случай: исходник удалён после завершения', async () => {
    await service.finalizeAvatar(ctx);
    expect(written).toBe(1);
    expect(stored).toBeNull();
  });
});
