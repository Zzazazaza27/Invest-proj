import { describe, expect, it } from 'vitest';
import {
  RoundQuoteSchema,
  computeRoundQuote,
  type RoundOffering,
  type RoundQuoteInput,
  type RoundQuotePackage,
} from '../src/domain/round-pricing';

/**
 * Расчёт стоимости запуска раунда (5.9.2).
 *
 * Проверяется то, из-за чего расчёт вообще вынесен в одно место: подбор
 * пакета по диапазону, право выбрать более полный пакет и докупить услугу,
 * отказ вместо догадки, когда правило не задано или сетка не покрывает
 * сумму, и арифметика без плавающей точки.
 */

const CHECK = { code: 'legal_check', name: 'Проверка документов' };
const REPORT = { code: 'report', name: 'Отчёт для инвестора' };
const EXPERT = { code: 'expert_call', name: 'Разбор с экспертом' };

const BASIC: RoundQuotePackage = {
  code: 'basic',
  version: 1,
  name: 'Базовый',
  price: '15000.00',
  currency: 'RUB',
  minTarget: '0.00',
  maxTarget: '5000000.00',
  services: [CHECK],
};

const FULL: RoundQuotePackage = {
  code: 'full',
  version: 1,
  name: 'Расширенный',
  price: '40000.00',
  currency: 'RUB',
  minTarget: '5000000.00',
  maxTarget: null,
  services: [CHECK, REPORT],
};

/** Пакет дороже базового, но с ДРУГИМ набором: полнее он не становится. */
const SIDEWAYS: RoundQuotePackage = {
  code: 'sideways',
  version: 1,
  name: 'Особый',
  price: '90000.00',
  currency: 'RUB',
  minTarget: '900000000.00',
  maxTarget: null,
  services: [EXPERT],
};

const OFFERING: RoundOffering = {
  packages: [BASIC, FULL, SIDEWAYS],
  serviceOffers: [
    { code: 'expert_call', name: 'Разбор с экспертом', price: '7000.00', currency: 'RUB' },
    { code: 'report', name: 'Отчёт для инвестора', price: '5000.50', currency: 'RUB' },
  ],
};

function input(over: Partial<RoundQuoteInput> = {}): RoundQuoteInput {
  return {
    countryCode: 'ru',
    policyVersion: 3,
    policy: { paidPackagesEnabled: true, freeAttractionEnabled: false, baseCurrency: 'RUB' },
    target: '1000000.00',
    currency: 'RUB',
    selection: { serviceCodes: [] },
    offering: OFFERING,
    ...over,
  };
}

describe('расчёт стоимости запуска раунда', () => {
  it('выключенные платные пакеты дают бесплатный запуск независимо от сетки', () => {
    const quote = computeRoundQuote(
      input({
        policy: { paidPackagesEnabled: false, freeAttractionEnabled: false, baseCurrency: 'RUB' },
      }),
    );
    expect(quote.mode).toBe('free');
    expect(quote.total).toBe('0.00');
    expect(quote.lines).toHaveLength(0);
    // Требуемый пакет всё равно назван: это факт сетки, а не счёт.
    expect(quote.requiredPackage?.code).toBe('basic');
    expect(quote.explanation[0]).toContain('бесплатен');
    expect(() => RoundQuoteSchema.parse(quote)).not.toThrow();
  });

  it('включённая бесплатная граница — отказ, а не молчаливое «бесплатно»', () => {
    const quote = computeRoundQuote(
      input({
        policy: { paidPackagesEnabled: true, freeAttractionEnabled: true, baseCurrency: 'RUB' },
      }),
    );
    expect(quote.mode).toBe('blocked');
    expect(quote.total).toBe('0.00');
    expect(quote.blockers[0]?.message).toContain('база её учёта не определена');
  });

  it('сумма определяет требуемый пакет по диапазону [от, до)', () => {
    expect(computeRoundQuote(input({ target: '4999999.99' })).requiredPackage?.code).toBe('basic');
    // Ровно нижняя граница — уже следующий пакет: диапазон полуоткрыт.
    expect(computeRoundQuote(input({ target: '5000000.00' })).requiredPackage?.code).toBe('full');
  });

  it('счёт по требуемому пакету объясняет итог и валюту', () => {
    const quote = computeRoundQuote(input());
    expect(quote.mode).toBe('priced');
    expect(quote.total).toBe('15000.00');
    expect(quote.currency).toBe('RUB');
    expect(quote.lines).toEqual([
      {
        kind: 'package',
        role: 'required_package',
        code: 'basic',
        title: 'Базовый',
        amount: '15000.00',
        currency: 'RUB',
      },
    ]);
    expect(quote.explanation.at(-1)).toBe('Итого: 15000.00 RUB.');
  });

  it('более полный пакет выбрать можно: состав включает весь требуемый', () => {
    const quote = computeRoundQuote(
      input({ selection: { packageCode: 'full', serviceCodes: [] } }),
    );
    expect(quote.mode).toBe('priced');
    expect(quote.chosenPackage?.code).toBe('full');
    expect(quote.lines[0]?.role).toBe('chosen_package');
    expect(quote.total).toBe('40000.00');
    expect(quote.explanation.some((line) => line.includes('более полный'))).toBe(true);
  });

  it('дороже не значит полнее: пакет с другим набором не заменяет требуемый', () => {
    const quote = computeRoundQuote(
      input({ selection: { packageCode: 'sideways', serviceCodes: [] } }),
    );
    expect(quote.mode).toBe('blocked');
    expect(quote.blockers[0]?.path).toBe('packageCode');
    expect(quote.blockers[0]?.message).toContain('не включает всё');
    expect(quote.blockers[0]?.message).toContain('Проверка документов');
  });

  it('докупка услуги складывается с пакетом без потери копеек', () => {
    const quote = computeRoundQuote(
      input({ selection: { serviceCodes: ['expert_call', 'report'] } }),
    );
    expect(quote.mode).toBe('priced');
    expect(quote.extraServices.map((s) => s.code)).toEqual(['expert_call', 'report']);
    // 15000.00 + 7000.00 + 5000.50
    expect(quote.total).toBe('27000.50');
    expect(quote.lines.filter((l) => l.role === 'extra_service')).toHaveLength(2);
  });

  it('услуга, входящая в пакет, второй раз не оплачивается', () => {
    const quote = computeRoundQuote(input({ selection: { serviceCodes: ['legal_check'] } }));
    expect(quote.mode).toBe('blocked');
    expect(quote.blockers[0]?.message).toContain('«Проверка документов» уже входит в пакет');
  });

  it('выбор более полного пакета меняет то, что считается докупкой', () => {
    // report входит в «Расширенный»: с ним докупать его нельзя.
    const quote = computeRoundQuote(
      input({ selection: { packageCode: 'full', serviceCodes: ['report'] } }),
    );
    expect(quote.mode).toBe('blocked');
    expect(quote.blockers[0]?.message).toContain('«Отчёт для инвестора» уже входит в пакет');
  });

  it('услуга без действующей цены в стране не докупается', () => {
    const quote = computeRoundQuote(input({ selection: { serviceCodes: ['unknown_service'] } }));
    expect(quote.mode).toBe('blocked');
    expect(quote.blockers[0]?.message).toContain('нет действующей цены');
  });

  it('сетка без подходящего диапазона — отказ с причиной, а не ноль', () => {
    const quote = computeRoundQuote(
      input({ target: '1000.00', offering: { packages: [FULL], serviceOffers: [] } }),
    );
    expect(quote.mode).toBe('blocked');
    expect(quote.total).toBe('0.00');
    expect(quote.blockers[0]?.message).toContain('не покрывает сумму');
  });

  it('незаданная сумма в платном режиме — отказ', () => {
    const quote = computeRoundQuote(input({ target: null }));
    expect(quote.mode).toBe('blocked');
    expect(quote.blockers[0]?.path).toBe('target');
  });

  it('валюта раунда и валюта пакета обязаны совпадать', () => {
    const quote = computeRoundQuote(input({ currency: 'EUR' }));
    expect(quote.mode).toBe('blocked');
    expect(quote.blockers.some((b) => b.path === 'currency')).toBe(true);
  });

  it('пересекающиеся диапазоны не дают случайной цены', () => {
    const overlapping: RoundOffering = {
      packages: [BASIC, { ...FULL, code: 'other', minTarget: '0.00', maxTarget: null }],
      serviceOffers: [],
    };
    const quote = computeRoundQuote(input({ offering: overlapping }));
    expect(quote.mode).toBe('blocked');
    expect(quote.requiredPackage).toBeNull();
  });
});
