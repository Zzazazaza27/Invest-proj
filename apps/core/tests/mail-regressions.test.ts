import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '../src/config/env';
import { MailQueueService } from '../src/comms/mail-queue.service';
import { VerificationService } from '../src/identity/verification.service';

/**
 * Две регрессии пакета «Почта» (замечания Тэнка 08.11):
 *   1. отказ лимита писем не выдаёт ссылку смены пароля — выдача гасит прежнюю;
 *   2. служебное письмо при заданном получателе сохраняется и без транспорта; ждёт отправщик.
 */
const ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://app:pw@localhost:5433/db',
  AUTH_MODE: 'local',
  LOCAL_AUTH_SIGNING_KEY: 'k'.repeat(64),
  CSRF_SIGNING_KEY: 'c'.repeat(64),
  KMS_MODE: 'local',
  KEK_SEARCH_INDEX: Buffer.alloc(32, 7).toString('base64'),
  KEK_PASSPORT_SENSITIVE: Buffer.alloc(32, 8).toString('base64'),
  KEK_KYB_DOCUMENTS: Buffer.alloc(32, 9).toString('base64'),
  KEK_WEBHOOK_SECRETS: Buffer.alloc(32, 11).toString('base64'),
  SUPPORT_INBOX_EMAIL: 'inbox@fifth.local',
};
const saved = { ...process.env };
beforeEach(() => {
  resetEnvCache();
  process.env = { ...ENV };
});
afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

/** Транзакция-заглушка: пишет запросы, на вставку отметки отвечает «новая запись». */
function fakeTx() {
  const queries: string[] = [];
  const tx = {
    query: vi.fn(async (text: string) => {
      queries.push(text);
      if (text.includes('INSERT INTO comms.mail_dispatches')) {
        return { rows: [{ created_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  return { tx, queries };
}

describe('Отказ лимита писем не трогает действующую ссылку', () => {
  it('ссылка не выдаётся, письмо не отправляется, ответ тот же', async () => {
    const { tx, queries } = fakeTx();
    const db = {
      asServiceRole: vi.fn(async (_r: string, _c: unknown, fn: (t: typeof tx) => unknown) =>
        fn(tx),
      ),
    };
    const crypto = {
      blindIndex: vi.fn(async () => Buffer.alloc(32, 1)),
      contextHash: vi.fn(async () => Buffer.alloc(32, 2)),
    };
    const mail = { available: true, send: vi.fn() };
    const throttle = { allow: vi.fn(async () => false) };
    const svc = new VerificationService(
      db as never,
      crypto as never,
      {} as never,
      mail as never,
      throttle as never,
      {} as never,
    );
    await expect(
      svc.requestPasswordReset(
        { userId: null, roles: [], traceId: 't' },
        'a@test.local',
        'k'.repeat(20),
      ),
    ).resolves.toBeUndefined();
    expect(throttle.allow).toHaveBeenCalledTimes(1);
    // Выдача ссылки гасит прежнюю — при отказе лимита её не должно быть вовсе.
    expect(queries.some((q) => q.includes('issue_verification_token'))).toBe(false);
    expect(queries.some((q) => q.includes("state = 'skipped'"))).toBe(true);
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe('Служебное письмо без транспорта', () => {
  const jobs = { register: vi.fn(), instanceId: 'core-test' };

  it('получатель задан, транспорт выключен — письмо сохранено', async () => {
    const { tx, queries } = fakeTx();
    const queue = new MailQueueService({} as never, { available: false } as never, jobs as never);
    await queue.enqueue(tx as never, {
      source: 'support.ticket.opened',
      sourceId: '01a1a865-93dd-7000-9eaa-0bd2fceec5b1',
      subject: 's',
      text: 't',
    });
    expect(queries.some((q) => q.includes('INSERT INTO comms.mail_queue'))).toBe(true);
  });

  it('получатель не задан — намеренно выключено, письма нет', async () => {
    process.env = { ...ENV, SUPPORT_INBOX_EMAIL: '' };
    resetEnvCache();
    const { tx, queries } = fakeTx();
    const queue = new MailQueueService({} as never, { available: true } as never, jobs as never);
    await queue.enqueue(tx as never, {
      source: 'support.ticket.opened',
      sourceId: '01a1a865-93dd-7000-9eaa-0bd2fceec5b1',
      subject: 's',
      text: 't',
    });
    expect(queries).toHaveLength(0);
  });

  it('транспорт выключен — отправщик не берёт письма и не расходует попыток', async () => {
    const db = { transaction: vi.fn() };
    const queue = new MailQueueService(db as never, { available: false } as never, jobs as never);
    expect(await queue.runOnce()).toBe(0);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
