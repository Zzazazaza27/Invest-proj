import { describe, expect, it } from 'vitest';
import { parseClientErrorReport } from '@fifth/contracts';
import {
  ClientErrorLimiter,
  PER_ADDRESS_LIMIT,
  TOTAL_LIMIT,
  clientErrorRecord,
} from '../src/health/client-errors.controller';
import { safeFields } from '../src/common/logging/safe-log';
import type { Counters } from '../src/cache/counters';

/**
 * Приёмник ошибок интерфейса (8.4): запись журнала без имён лишних полей; локальный предел
 * при отказе Valkey — только этого приёмника и на экземпляр; одна запись о превышении.
 */
const SECRET = 'tok_9f8e7d6c5b4a@leak.example';

describe('запись журнала', () => {
  it('секрет в имени неизвестного поля не попадает в запись, только число', () => {
    const parsed = parseClientErrorReport({
      cabinet: 'lab',
      screen: '/',
      version: 'abc1234',
      code: 'js.uncaught',
      stage: 'unknown',
      count: 3,
      [SECRET]: SECRET,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const line = JSON.stringify(safeFields(clientErrorRecord(parsed.report, parsed.dropped)));
    expect(line).not.toContain('tok_9f8e7d6c5b4a');
    expect(line).not.toContain('dropped"');
    expect(JSON.parse(line)).toMatchObject({
      reported: 'browser',
      cabinet: 'lab',
      code: 'js.uncaught',
      count: 3,
      droppedFields: 1,
    });
  });
});

describe('ограничитель', () => {
  const brokenValkey = {
    hit: async () => {
      throw new Error('valkey down');
    },
  } as unknown as Counters;

  it('без Valkey — локальный предел экземпляра; превышение — одна запись', async () => {
    const limiter = new ClientErrorLimiter(brokenValkey, () => 1_000_000);
    const verdicts = [];
    for (let i = 0; i < PER_ADDRESS_LIMIT + 5; i += 1)
      verdicts.push(await limiter.admit('10.0.0.1'));
    expect(verdicts.filter((v) => v.admitted)).toHaveLength(PER_ADDRESS_LIMIT);
    const notices = verdicts.filter((v) => v.notice);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.notice).toEqual({
      reason: 'address',
      limit: PER_ADDRESS_LIMIT,
      scope: 'instance',
    });
    // Другой адрес в том же окне — свой счётчик.
    expect((await limiter.admit('10.0.0.2')).admitted).toBe(true);
  });

  it('общий предел и новое окно', async () => {
    let now = 0;
    const limiter = new ClientErrorLimiter(null, () => now);
    let admitted = 0;
    for (let i = 0; i < TOTAL_LIMIT + 10; i += 1) {
      if ((await limiter.admit(`10.1.${Math.floor(i / 20)}.${i % 20}`)).admitted) admitted += 1;
    }
    expect(admitted).toBe(TOTAL_LIMIT);
    now = 60_000;
    expect((await limiter.admit('10.9.9.9')).admitted).toBe(true);
  });

  it('с Valkey — общий счётчик платформы', async () => {
    const store = new Map<string, number>();
    const valkey = {
      hit: async (key: string) => {
        const used = (store.get(key) ?? 0) + 1;
        store.set(key, used);
        return { used, ttlMs: 60_000 };
      },
    } as unknown as Counters;
    const limiter = new ClientErrorLimiter(valkey, () => 0);
    for (let i = 0; i < PER_ADDRESS_LIMIT; i += 1) await limiter.admit('10.0.0.1');
    const over = await limiter.admit('10.0.0.1');
    expect(over.admitted).toBe(false);
    expect(over.notice?.scope).toBe('platform');
  });
});
