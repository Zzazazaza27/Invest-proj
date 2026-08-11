import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildEnvelope, type OutboxRow } from '../src/events/publisher.service';
import {
  isForbiddenAddress,
  signDelivery,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
} from '../src/events/webhooks.service';

/**
 * Юнит-тесты контура событий.
 *
 * Проверяется чистая логика, от которой зависит безопасность доставки: список
 * адресов, куда сервер не пойдёт никогда, форма подписи и форма конверта.
 * Живой прогон показывает, что цепочка работает целиком; здесь — что она
 * работает на крайних случаях, которые в прогоне не воспроизвести.
 */

describe('Адреса, недопустимые для доставки', () => {
  const forbidden = [
    ['loopback IPv4', '127.0.0.1'],
    ['loopback в другом виде', '127.255.255.254'],
    ['нулевой адрес', '0.0.0.0'],
    ['частная сеть 10/8', '10.1.2.3'],
    ['частная сеть 172.16/12', '172.16.0.1'],
    ['частная сеть 172.31/12', '172.31.255.254'],
    ['частная сеть 192.168/16', '192.168.1.1'],
    ['метаданные облака', '169.254.169.254'],
    ['link-local IPv4', '169.254.1.1'],
    ['CGNAT', '100.64.0.1'],
    ['loopback IPv6', '::1'],
    ['неопределённый IPv6', '::'],
    ['ULA IPv6', 'fd00::1'],
    ['link-local IPv6', 'fe80::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped частная сеть', '::ffff:10.0.0.1'],
    ['не адрес вовсе', 'не-адрес'],
  ] as const;

  for (const [label, address] of forbidden) {
    it(`отвергается: ${label}`, () => {
      expect(isForbiddenAddress(address)).toBe(true);
    });
  }

  const allowed = [
    ['публичный IPv4', '93.184.216.34'],
    ['граница частного диапазона снизу', '172.15.255.255'],
    ['граница частного диапазона сверху', '172.32.0.1'],
    ['похожий на CGNAT, но публичный', '100.63.255.255'],
    ['публичный IPv6', '2606:2800:220:1:248:1893:25c8:1946'],
  ] as const;

  for (const [label, address] of allowed) {
    it(`допускается: ${label}`, () => {
      expect(isForbiddenAddress(address)).toBe(false);
    });
  }
});

describe('Подпись доставки', () => {
  const secret = 'k'.repeat(43);
  const body = JSON.stringify({ eventId: 'x', verb: 'lab.project.graduated' });

  it('совпадает с независимым вычислением получателя', () => {
    const timestamp = 1_760_000_000;
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${body}`, 'utf8')
      .digest('hex');
    expect(signDelivery(secret, timestamp, body)).toBe(`t=${timestamp},v1=${expected}`);
  });

  it('метка времени входит в подпись: тело с другой меткой даёт другой MAC', () => {
    const a = signDelivery(secret, 1_760_000_000, body);
    const b = signDelivery(secret, 1_760_000_001, body);
    expect(a).not.toBe(b);
  });

  it('другое тело даёт другую подпись', () => {
    const timestamp = 1_760_000_000;
    expect(signDelivery(secret, timestamp, body)).not.toBe(
      signDelivery(secret, timestamp, `${body} `),
    );
  });

  it('чужой секрет не воспроизводит подпись', () => {
    const timestamp = 1_760_000_000;
    expect(signDelivery(secret, timestamp, body)).not.toBe(
      signDelivery('x'.repeat(43), timestamp, body),
    );
  });

  it('окно повтора объявлено и не бесконечно', () => {
    expect(WEBHOOK_SIGNATURE_TOLERANCE_SECONDS).toBeGreaterThan(0);
    expect(WEBHOOK_SIGNATURE_TOLERANCE_SECONDS).toBeLessThanOrEqual(600);
  });
});

describe('Конверт события', () => {
  const row: OutboxRow = {
    id: '018f2b7c-0000-7000-8000-000000000001',
    aggregate_type: 'project',
    aggregate_id: '018f2b7c-0000-7000-8000-000000000002',
    // BIGINT приходит из драйвера строкой — именно этот случай и проверяем.
    aggregate_version: '42',
    event_type: 'lab.project.graduated',
    payload_jsonb: { projectId: 'x', irs: 71.5 },
    nats_subject: 'lab.project.graduated',
    schema_version: 1,
    message_key: 'x',
    attempts: 0,
    created_at: new Date('2026-08-11T06:00:00.000Z'),
  };

  it('версия агрегата приводится к числу, а не остаётся строкой', () => {
    expect(buildEnvelope(row).aggregateVersion).toBe(42);
  });

  it('момент события берётся из времени записи, а не из времени публикации', () => {
    expect(buildEnvelope(row).occurredAt).toBe('2026-08-11T06:00:00.000Z');
  });

  it('полезная нагрузка не переписывается конвертом', () => {
    expect(buildEnvelope(row).payload).toEqual({ projectId: 'x', irs: 71.5 });
  });

  it('в конверте нет внутренних полей очереди', () => {
    const envelope = buildEnvelope(row);
    for (const internal of ['attempts', 'nats_subject', 'message_key', 'locked_at', 'last_error']) {
      expect(internal in envelope).toBe(false);
    }
  });
});
