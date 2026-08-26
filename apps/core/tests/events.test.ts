import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { buildEnvelope, type OutboxRow } from '../src/events/publisher.service';
import { absoluteDeadlineMs, readCapped } from '../src/events/pinned-fetch';
import { deliveryLeaseSeconds } from '../src/events/webhook-delivery.service';
import { resetEnvCache } from '../src/config/env';
import {
  deliveryTimeoutMs,
  isForbiddenAddress,
  signDelivery,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
} from '../src/events/webhooks.service';
import { addressInCidrs } from '../src/events/ip-classifier';

/**
 * Юнит-тесты контура событий.
 *
 * Проверяется чистая логика, от которой зависит безопасность доставки: список
 * адресов, куда сервер не пойдёт никогда, форма подписи и форма конверта.
 * Живой прогон показывает, что цепочка работает целиком; здесь — что она
 * работает на крайних случаях, которые в прогоне не воспроизвести.
 */

/**
 * Часть проверок читает конфигурацию (таймауты доставки). Окружение ставится
 * на время вызова и возвращается обратно: тест, оставивший переменные после
 * себя, ломает соседние — и находится это долго.
 */
function withEnv<T>(fn: () => T, extra: NodeJS.ProcessEnv = {}): T {
  const saved = { ...process.env };
  resetEnvCache();
  Object.assign(
    process.env,
    {
      DATABASE_URL: 'postgres://app:pw@localhost:5433/db',
      AUTH_MODE: 'local',
      LOCAL_AUTH_SIGNING_KEY: 'k'.repeat(64),
      CSRF_SIGNING_KEY: 'c'.repeat(64),
      KMS_MODE: 'local',
      KEK_SEARCH_INDEX: Buffer.alloc(32, 7).toString('base64'),
      // Остальные используемые KEK-домены: конфигурация проверяет все пять
      // на старте (Ф42), а не только blind index — ошибка ключа обязана
      // ронять запуск, а не всплывать на пользовательском запросе.
      KEK_PASSPORT_SENSITIVE: Buffer.alloc(32, 8).toString('base64'),
      KEK_KYB_DOCUMENTS: Buffer.alloc(32, 9).toString('base64'),
      KEK_INVESTMENT_DOCUMENTS: Buffer.alloc(32, 10).toString('base64'),
      KEK_WEBHOOK_SECRETS: Buffer.alloc(32, 11).toString('base64'),
      KEK_AI_PROVIDER_SECRETS: Buffer.alloc(32, 12).toString('base64'),
    },
    extra,
  );
  try {
    return fn();
  } finally {
    process.env = saved;
    resetEnvCache();
  }
}

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

    // Ниже — обходы, воспроизведённые внешним аудитом (SEC-07) на прежней
    // реализации, которая сравнивала строковые ПРЕФИКСЫ вместо байтов адреса.
    ['link-local IPv6 вне литерала fe80 (fe80::/10)', 'fe90::1'],
    ['верхняя граница link-local IPv6', 'febf::1'],
    ['IPv4-mapped loopback в шестнадцатеричном виде', '::ffff:7f00:1'],
    ['multicast IPv4', '224.0.0.1'],
    ['benchmark-сеть 198.18/15', '198.18.0.1'],

    // Тот же класс: другая форма записи не должна менять решение.
    ['link-local IPv6 с идентификатором зоны', 'fe80::1%eth0'],
    ['IPv4-mapped метаданные облака в hex', '::ffff:a9fe:a9fe'],
    ['NAT64 к loopback', '64:ff9b::127.0.0.1'],
    ['6to4 с встроенной частной сетью', '2002:c0a8:0101::1'],
    ['multicast IPv6', 'ff02::1'],
    ['broadcast IPv4', '255.255.255.255'],
    ['зарезервированный класс E', '240.0.0.1'],
    ['документационная сеть TEST-NET-1', '192.0.2.1'],
    ['документационная сеть IPv6', '2001:db8::1'],
    ['развёрнутый loopback IPv6', '0000:0000:0000:0000:0000:0000:0000:0001'],
    // Дополнение по реестру IANA (Ф36, SEC-MED-01).
    ['local-use IPv4/IPv6 translation', '64:ff9b:1::1'],
    ['dummy prefix', '100:0:0:1::1'],
    ['benchmarking IPv6', '2001:2::1'],
    ['documentation 3fff::/20', '3fff:abc::1'],
    ['SRv6 SIDs', '5f00::1'],
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

    // Контроль: классификатор не запрещает всё подряд. Без этих случаев
    // «блокируем каждый адрес» прошло бы как исправление.
    ['граница link-local IPv6 снизу', 'fe7f::1'],
    ['граница link-local IPv6 сверху', 'fec0::1'],
    ['граница benchmark-сети снизу', '198.17.255.255'],
    ['граница benchmark-сети сверху', '198.20.0.1'],
    ['граница multicast снизу', '223.255.255.255'],
    ['IPv4-mapped публичный адрес', '::ffff:93.184.216.34'],
    ['6to4 с встроенным публичным адресом', '2002:5db8:d822::1'],
    ['публичный IPv6 в другой группе', '2a00:1450:4001:80f::200e'],
    // Границы новых диапазонов (Ф36): сосед запрещённого — не запрещён.
    ['граница 3fff::/20 сверху', '4000::1'],
    ['граница 5f00::/16 сверху', '5f01::1'],
    ['NAT64 well-known без суффикса 1', '64:ff9b::93.184.216.34'],
  ] as const;

  for (const [label, address] of allowed) {
    it(`допускается: ${label}`, () => {
      expect(isForbiddenAddress(address)).toBe(false);
    });
  }
});

describe('Принадлежность CIDR доверенного прокси (Ф36, SEC-CRIT-03)', () => {
  it('адрес внутри IPv4-CIDR распознаётся', () => {
    expect(addressInCidrs('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(addressInCidrs('10.1.2.3', ['192.168.0.0/16'])).toBe(false);
  });

  it('IPv4-mapped запись равна точечной', () => {
    expect(addressInCidrs('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(addressInCidrs('::ffff:11.1.2.3', ['10.0.0.0/8'])).toBe(false);
  });

  it('одиночный адрес без маски — точное совпадение', () => {
    expect(addressInCidrs('127.0.0.1', ['127.0.0.1'])).toBe(true);
    expect(addressInCidrs('127.0.0.2', ['127.0.0.1'])).toBe(false);
  });

  it('IPv6-CIDR работает', () => {
    expect(addressInCidrs('fd00::5', ['fd00::/8'])).toBe(true);
    expect(addressInCidrs('2a00::1', ['fd00::/8'])).toBe(false);
  });

  it('пустой список и мусор — отказ, а не пропуск', () => {
    expect(addressInCidrs('10.0.0.1', [])).toBe(false);
    expect(addressInCidrs('не-адрес', ['10.0.0.0/8'])).toBe(false);
    expect(addressInCidrs('10.0.0.1', ['мусор/8'])).toBe(false);
  });
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

/**
 * Пределы чтения ответа получателя (SEC-07).
 *
 * Прежний код после превышения предела ПЕРЕСТАВАЛ СОХРАНЯТЬ данные, но
 * продолжал их принимать: получатель мог лить в нас сколько угодно, ограничен
 * был только объём в памяти. Здесь проверяется, что превышение обрывает
 * соединение.
 */
describe('Предел чтения ответа доставки', () => {
  it('в пределах лимита тело читается целиком, соединение не рвётся', async () => {
    const stream = new PassThrough();
    let aborted = 0;
    const reading = readCapped(stream, () => (aborted += 1), 64);
    stream.end('короткий ответ');
    expect(await reading).toBe('короткий ответ');
    expect(aborted).toBe(0);
  });

  it('превышение предела обрывает соединение, а не просто выбрасывает данные', async () => {
    const stream = new PassThrough();
    let aborted = 0;
    const reading = readCapped(stream, () => (aborted += 1), 16);
    stream.write('0123456789012345'); // ровно предел
    stream.write('лишнее');
    const body = await reading;
    expect(aborted).toBe(1);
    expect(body).toBe('0123456789012345');
  });

  it('обрыв соединения завершает чтение, а не подвешивает доставку', async () => {
    const stream = new PassThrough();
    const reading = readCapped(stream, () => undefined, 64);
    stream.write('начало');
    stream.destroy();
    expect(await reading).toBe('начало');
  });

  it('обрыв вызывается один раз, сколько бы данных ни пришло сверх предела', async () => {
    const stream = new PassThrough();
    let aborted = 0;
    const reading = readCapped(stream, () => (aborted += 1), 4);
    stream.write('первый кусок сверх предела');
    stream.write('второй кусок сверх предела');
    stream.end();
    await reading;
    expect(aborted).toBe(1);
  });
});

/**
 * Абсолютный предельный срок доставки (SEC-07).
 *
 * `req.setTimeout` — таймаут БЕЗДЕЙСТВИЯ: получатель, отдающий по байту чаще,
 * чем раз в `timeoutMs`, не срабатывает по нему никогда.
 */
describe('Предельный срок доставки', () => {
  it('по умолчанию кратен таймауту бездействия и строго больше него', () => {
    expect(absoluteDeadlineMs({ timeoutMs: 5000 })).toBe(15000);
    expect(absoluteDeadlineMs({ timeoutMs: 5000 })).toBeGreaterThan(5000);
  });

  it('явно заданный срок имеет приоритет', () => {
    expect(absoluteDeadlineMs({ timeoutMs: 5000, deadlineMs: 7000 })).toBe(7000);
  });
});

/**
 * Срок аренды доставки (SEC-06).
 *
 * Прежняя схема брала ОДНУ аренду в 60 секунд на всю пачку (по умолчанию до
 * пятидесяти строк) и отправляла их последовательно. Арифметика не сходилась:
 * к концу пачки аренда истекала, другой экземпляр забирал те же строки и слал
 * вебхук второй раз — с настоящим побочным эффектом у получателя.
 *
 * Теперь аренда продлевается перед каждой доставкой, и её срок обязан
 * покрывать ровно одну доставку с её абсолютным предельным сроком.
 */
describe('Аренда доставки вебхука', () => {
  it('срок аренды строго покрывает предельную длительность одной доставки', () => {
    withEnv(() => {
      const deadlineSeconds = absoluteDeadlineMs({ timeoutMs: deliveryTimeoutMs() }) / 1000;
      expect(deliveryLeaseSeconds()).toBeGreaterThan(deadlineSeconds);
    });
  });

  it('аренды НЕ хватило бы на всю пачку — потому она и продлевается построчно', () => {
    withEnv(() => {
      // Именно это соотношение и было дефектом: одна аренда против пачки.
      // Проверка фиксирует, что схема «одна аренда на пачку» вернуться не может
      // незаметно — она арифметически несостоятельна при любом разумном пределе.
      const perDelivery = absoluteDeadlineMs({ timeoutMs: deliveryTimeoutMs() }) / 1000;
      const batchWorstCase = perDelivery * 50;
      expect(deliveryLeaseSeconds()).toBeLessThan(batchWorstCase);
    });
  });
});
