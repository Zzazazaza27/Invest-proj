import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errors } from '../src/common/errors';
import { resetEnvCache } from '../src/config/env';
import { WebhookDeliveryService } from '../src/events/webhook-delivery.service';

/** Доставка вебхука при отказе службы ключей (блок 5, задание 5). */
vi.mock('../src/events/webhooks.service', async (original) => ({
  ...(await original<typeof import('../src/events/webhooks.service')>()),
  assertPublicDestination: vi.fn(async () => ['93.184.216.34']),
}));

const updates: { sql: string; params: unknown[] }[] = [];
let failure: Error;

const service = new WebhookDeliveryService(
  {
    asServiceRole: async (_: string, __: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params: unknown[]) => {
          updates.push({ sql, params });
          return { rowCount: 1, rows: [] };
        },
      }),
  } as never,
  {
    openDirect: async () => {
      throw failure;
    },
  } as never,
  {} as never,
);

const item = {
  id: 'd1',
  attempts: 3,
  url: 'https://example.org/hook',
  secret_ciphertext: Buffer.from('x'),
  outbox_id: 'o1',
  event_id: 'e1',
  event_type: 'x.y',
  aggregate_type: 'a',
  aggregate_id: 'b',
  aggregate_version: 1,
  payload_jsonb: {},
  nats_subject: 's',
  schema_version: 1,
  message_key: 'k',
  created_at: new Date(0),
};

const deliver = (): Promise<string> =>
  (service as unknown as { deliverOne: (t: string, i: unknown) => Promise<string> }).deliverOne(
    't',
    item,
  );

beforeEach(() => {
  updates.length = 0;
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
    WEBHOOK_DELIVERY_MODE: 'live',
  });
  resetEnvCache();
});

describe('Доставка вебхука и служба ключей', () => {
  it('отказ службы ключей откладывает доставку, попытка не тратится', async () => {
    failure = errors.upstreamUnavailable('kms');
    expect(await deliver()).toBe('not_delivered');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.sql).not.toMatch(/attempts/);
    expect(updates[0]!.sql).toMatch(/next_retry_at/);
  });

  it('порча секрета остаётся обычным сбоем: попытка тратится', async () => {
    failure = new Error('повреждённые данные');
    expect(await deliver()).toBe('not_delivered');
    expect(updates[0]!.sql).toMatch(/attempts = \$2/);
    expect(updates[0]!.params[1]).toBe(4);
  });
});
