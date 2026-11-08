import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '../src/config/env';
import {
  EgressMonitor,
  brokerBreaker,
  classifyDeliveryFailure,
  destinationOf,
  egressMonitor,
  resetEventsHealth,
} from '../src/events/events-health';
import { errors } from '../src/common/errors';
import { WebhookDeliveryService } from '../src/events/webhook-delivery.service';
import { OutboxPublisherService } from '../src/events/publisher.service';

/** Группа «События» (4.11, пакет 5): правила контура доставки и независимость контуров. */
const phase = (code: string, deliveryPhase: 'connect' | 'sent') =>
  Object.assign(new Error(code), { code, deliveryPhase });

describe('Чей отказ доставки', () => {
  it('сеть до получателя до передачи тела — транспорт', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']) {
      expect(classifyDeliveryFailure(phase(code, 'connect'))).toBe('transport');
    }
  });

  it('тело передано, ответа нет — неизвестно, а не отказ получателя', () => {
    expect(classifyDeliveryFailure(phase('ECONNRESET', 'sent'))).toBe('unknown');
    expect(classifyDeliveryFailure(phase('ETIMEDOUT', 'sent'))).toBe('unknown');
  });

  it('сертификат — отказ получателя, в общий сигнал не входит', () => {
    for (const code of [
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
    ]) {
      expect(classifyDeliveryFailure(phase(code, 'connect'))).toBe('receiver');
    }
  });

  it('DNS: временный сбой резолвера — транспорт; «имени нет» — получатель', () => {
    const dns = (dnsCode: string) => Object.assign(errors.validation([]), { dnsCode });
    expect(classifyDeliveryFailure(dns('EAI_AGAIN'))).toBe('transport');
    expect(classifyDeliveryFailure(dns('ETIMEOUT'))).toBe('transport');
    expect(classifyDeliveryFailure(dns('ENOTFOUND'))).toBe('receiver');
  });

  it('внутренний адрес по факту соединения — получатель; служба ключей — наша', () => {
    expect(
      classifyDeliveryFailure(
        Object.assign(new Error('x'), { deliveryPhase: 'sent', deliveryKind: 'receiver' }),
      ),
    ).toBe('receiver');
    expect(classifyDeliveryFailure(errors.upstreamUnavailable('kms'))).toBe('platform');
  });

  it('узел назначения: три подписки на один адрес — один узел', () => {
    expect(destinationOf('https://Hooks.Example.org/a')).toBe('hooks.example.org:443');
    expect(destinationOf('https://hooks.example.org:443/b?x=1')).toBe('hooks.example.org:443');
    expect(destinationOf('https://hooks.example.org/c')).toBe('hooks.example.org:443');
    expect(destinationOf('https://hooks.example.org:8443/a')).toBe('hooks.example.org:8443');
  });
});

describe('Предполагаемый общий сбой исходящей сети', () => {
  const make = () => {
    let now = 1_000_000;
    const m = new EgressMonitor(
      { windowMs: 60_000, threshold: 3, basePauseMs: 30_000, maxPauseMs: 120_000 },
      () => now,
    );
    return { m, tick: (ms: number) => (now += ms) };
  };

  it('считаются разные узлы, а не подписки и не отказы', () => {
    const { m } = make();
    for (let i = 0; i < 10; i += 1) m.transportFailure('a:443');
    m.transportFailure('b:443');
    expect(m.gate()).toBe('open');
    m.transportFailure('c:443');
    expect(m.gate()).toBe('paused');
  });

  it('отказы вне окна не копятся; любой ответ получателя снимает признак', () => {
    const { m, tick } = make();
    m.transportFailure('a:443');
    m.transportFailure('b:443');
    tick(61_000);
    m.transportFailure('c:443');
    expect(m.gate()).toBe('open');
    m.transportFailure('d:443');
    m.networkWorks();
    m.transportFailure('e:443');
    expect(m.gate()).toBe('open');
  });

  it('у паузы есть выход: проба, при отказе — вдвое до предела, при успехе — открыто', () => {
    const { m, tick } = make();
    ['a', 'b', 'c'].forEach((d) => m.transportFailure(`${d}:443`));
    expect(m.gate()).toBe('paused');
    tick(30_001);
    expect(m.gate()).toBe('probe');
    m.transportFailure('a:443');
    tick(59_000);
    expect(m.gate()).toBe('paused');
    tick(2_000);
    expect(m.gate()).toBe('probe');
    m.transportFailure('a:443');
    m.transportFailure('a:443');
    tick(120_001);
    expect(m.gate()).toBe('probe');
    m.networkWorks();
    expect(m.gate()).toBe('open');
  });
});

describe('Контуры независимы, ручной запрет останавливает оба', () => {
  beforeEach(() => {
    Object.assign(process.env, {
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
  });

  const restricted = (mode: 'unavailable' | null) => ({
    restrictionOf: vi.fn(async () => mode),
  });

  it('доставка не смотрит на брокер: размыкатель брокера открыт — проход идёт', async () => {
    resetEventsHealth();
    for (let i = 0; i < 3; i += 1) brokerBreaker().record('write', false);
    expect(brokerBreaker().isOpen('write')).toBe(true);
    const asServiceRole = vi.fn(async () => []);
    const svc = new WebhookDeliveryService(
      { asServiceRole } as never,
      {} as never,
      {} as never,
      restricted(null) as never,
    );
    await svc.runOnce();
    expect(asServiceRole).toHaveBeenCalledTimes(1);
  });

  it('публикация не смотрит на исходящую сеть: признак общего сбоя — проход идёт', async () => {
    resetEventsHealth();
    ['a', 'b', 'c'].forEach((d) => egressMonitor().transportFailure(`${d}:443`));
    expect(egressMonitor().gate()).toBe('paused');
    const transaction = vi.fn(async () => ({ batch: [], leases: new Map() }));
    const pub = new OutboxPublisherService(
      { transaction } as never,
      {} as never,
      {} as never,
      restricted(null) as never,
    );
    await pub.runOnce();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('ручной запрет: ни захвата доставок, ни захвата публикации', async () => {
    resetEventsHealth();
    const asServiceRole = vi.fn();
    const transaction = vi.fn();
    await new WebhookDeliveryService(
      { asServiceRole } as never,
      {} as never,
      {} as never,
      restricted('unavailable') as never,
    ).runOnce();
    await new OutboxPublisherService(
      { transaction } as never,
      {} as never,
      {} as never,
      restricted('unavailable') as never,
    ).runOnce();
    expect(asServiceRole).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
