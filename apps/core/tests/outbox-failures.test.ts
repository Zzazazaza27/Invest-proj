import { ErrorCode, NatsError } from 'nats';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '../src/config/env';
import { NatsClient } from '../src/events/nats.client';
import { WebhookDeliveryService } from '../src/events/webhook-delivery.service';

/**
 * Узкие регрессии пакета NATS (блок 2, 2.4; замечания Тэнка 08.11):
 *   1. настоящий классификатор NatsClient на настоящих ошибках установленной библиотеки:
 *      попытку события расходует только положительно установленный отказ самого сообщения;
 *   2. потеря аренды доставки ВО ВРЕМЯ HTTP-запроса: проход останавливается, ложного успеха
 *      нет, вторая доставка не отправляется, своя оставшаяся строка освобождается.
 */

const envBase = {
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
};

describe('Классификатор NatsClient на ошибках библиотеки', () => {
  const connected = () => {
    const client = new NatsClient();
    Object.assign(client as object, { connection: { isClosed: () => false }, linkUp: true });
    return client;
  };
  const err = (code: string) => NatsError.errorForCode(code as never);

  it('ошибки доступа и входа не расходуют попытку события', () => {
    const c = connected();
    expect(c.classifyPublishFailure(err(ErrorCode.PermissionsViolation))).toBe('blocked');
    expect(c.classifyPublishFailure(err(ErrorCode.AuthorizationViolation))).toBe('blocked');
    expect(c.classifyPublishFailure(err(ErrorCode.AuthenticationExpired))).toBe('blocked');
  });

  it('нераспознанный отказ и ошибка API — тоже не по вине события', () => {
    const c = connected();
    expect(c.classifyPublishFailure(new Error('что-то иное'))).toBe('blocked');
    expect(c.classifyPublishFailure(err(ErrorCode.ApiError))).toBe('blocked');
    expect(c.classifyPublishFailure(err(ErrorCode.Unknown))).toBe('blocked');
  });

  it('только отказ самого сообщения засчитывается событию', () => {
    const c = connected();
    expect(c.classifyPublishFailure(err(ErrorCode.MaxPayloadExceeded))).toBe('event');
    expect(c.classifyPublishFailure(err(ErrorCode.BadSubject))).toBe('event');
    expect(c.classifyPublishFailure(err(ErrorCode.BadHeader))).toBe('event');
  });

  it('потерянное подтверждение и недоступный брокер различаются', () => {
    const c = connected();
    expect(c.classifyPublishFailure(err(ErrorCode.Timeout))).toBe('unknown');
    expect(c.classifyPublishFailure(err(ErrorCode.ConnectionRefused))).toBe('broker');
    expect(c.classifyPublishFailure(err(ErrorCode.NoResponders))).toBe('broker');
    const down = new NatsClient();
    expect(down.classifyPublishFailure(err(ErrorCode.PermissionsViolation))).toBe('broker');
  });
});

const posted: string[] = [];
vi.mock('../src/events/webhooks.service', async (original) => ({
  ...(await original<typeof import('../src/events/webhooks.service')>()),
  assertPublicDestination: vi.fn(async () => ['93.184.216.34']),
}));
vi.mock('../src/events/pinned-fetch', async (original) => ({
  ...(await original<typeof import('../src/events/pinned-fetch')>()),
  postPinned: vi.fn(async (url: string) => {
    posted.push(url);
    return { status: 200 };
  }),
}));

describe('Доставка вебхука: аренда потеряна во время запроса', () => {
  beforeEach(() => {
    posted.length = 0;
    Object.assign(process.env, {
      ...envBase,
      WEBHOOK_DELIVERY_MODE: 'live',
      DATABASE_URL_APP_INTEGRATION: 'postgres://int:pw@localhost:5433/db',
      INTEGRATION_TOKEN_SIGNING_KEY: 'i'.repeat(64),
    });
    resetEnvCache();
  });

  it('итог не записан — проход стоп, успеха нет, следующая не отправлена и освобождена', async () => {
    const row = (id: string) => ({
      id,
      lease_id: `lease-${id}`,
      endpoint_id: 'e',
      event_id: `ev-${id}`,
      attempts: 0,
      url: `https://example.org/${id}`,
      secret_ciphertext: Buffer.from('x'),
      endpoint_status: 'active',
      outbox_id: `ev-${id}`,
      aggregate_type: 'a',
      aggregate_id: 'b',
      aggregate_version: '1',
      event_type: 'x.y',
      payload_jsonb: {},
      nats_subject: 's',
      schema_version: 1,
      message_key: 'k',
      created_at: new Date(0),
    });
    const released: unknown[] = [];
    const tx = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('SET lease_id = $4::uuid')) return { rows: [{ id: 'd1' }, { id: 'd2' }] };
        if (sql.includes('SELECT d.id, d.lease_id')) return { rows: [row('d1'), row('d2')] };
        if (sql.includes('SET lease_until = now()')) return { rowCount: 1, rows: [] };
        // Пока шёл HTTP-запрос, захват ушёл другому исполнителю: итог не записывается.
        if (sql.includes("SET status = 'delivered'")) return { rowCount: 0, rows: [] };
        if (sql.includes('SET lease_id = NULL, lease_until = NULL')) {
          released.push(params[0]);
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
      },
    };
    const service = new WebhookDeliveryService(
      {
        asServiceRole: async (_r: string, _c: unknown, fn: (t: unknown) => unknown) => fn(tx),
      } as never,
      { openDirect: async () => Buffer.from('secret') } as never,
      { register() {} } as never,
    );
    const delivered = await service.runOnce();
    expect(posted).toEqual(['https://example.org/d1']);
    expect(delivered).toBe(0);
    expect(released).toEqual([['d2']]);
  });
});
