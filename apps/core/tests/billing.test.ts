import { describe, expect, it } from 'vitest';
import {
  ClosePlanRequestSchema,
  ProposeCustomPriceRequestSchema,
  PublishPlanRequestSchema,
  UpdateFeatureFlagRequestSchema,
} from '@unicorn/contracts';
import { parseOrThrow } from '../src/common/validation';

/**
 * Контракты административного управления тарифами.
 *
 * Проверяется то, что должно отсекаться ещё до обращения к базе: тариф без
 * цены, индивидуальный тариф с ценой, изменение условий без основания.
 * Неизменяемость истории цен проверяется отдельно — против реального
 * PostgreSQL и живым прогоном, потому что она живёт в триггерах.
 */

const VALID = {
  code: 'founder_t2',
  audience: 'founder',
  name: 'Рост — запрос до 10 млн ₽',
  price: '9990.00',
  askLimit: '10000000.00',
  individualPricing: false,
  billingPeriod: 'monthly',
  features: { included: ['публикация проекта'] },
};

describe('Публикация версии тарифа', () => {
  it('корректная заявка принимается', () => {
    expect(() => parseOrThrow(PublishPlanRequestSchema, VALID)).not.toThrow();
  });

  it('тариф без цены и без признака индивидуальной цены не принимается', () => {
    const { price, ...withoutPrice } = VALID;
    void price;
    expect(() => parseOrThrow(PublishPlanRequestSchema, withoutPrice)).toThrow();
  });

  it('индивидуальный тариф не может иметь фиксированную цену', () => {
    expect(() =>
      parseOrThrow(PublishPlanRequestSchema, { ...VALID, individualPricing: true }),
    ).toThrow();
  });

  it('индивидуальный тариф без цены принимается', () => {
    const { price, ...rest } = VALID;
    void price;
    expect(() =>
      parseOrThrow(PublishPlanRequestSchema, { ...rest, individualPricing: true }),
    ).not.toThrow();
  });

  it('код тарифа — из allowlist, а не произвольная строка', () => {
    expect(() =>
      parseOrThrow(PublishPlanRequestSchema, { ...VALID, code: 'founder_free' }),
    ).toThrow();
  });

  it('цена с тремя знаками после запятой не принимается', () => {
    expect(() => parseOrThrow(PublishPlanRequestSchema, { ...VALID, price: '9990.999' })).toThrow();
  });

  it('отрицательная цена не принимается', () => {
    expect(() => parseOrThrow(PublishPlanRequestSchema, { ...VALID, price: '-100.00' })).toThrow();
  });

  it('неизвестное поле отвергается: тариф не должен принимать лишние параметры', () => {
    expect(() =>
      parseOrThrow(PublishPlanRequestSchema, { ...VALID, validTo: '2027-01-01T00:00:00Z' }),
    ).toThrow();
  });
});

describe('Изменения, затрагивающие деньги, требуют основания', () => {
  it('снятие тарифа с продажи без причины не принимается', () => {
    expect(() => parseOrThrow(ClosePlanRequestSchema, {})).toThrow();
    expect(() =>
      parseOrThrow(ClosePlanRequestSchema, { reason: 'закрываем линейку' }),
    ).not.toThrow();
  });

  it('индивидуальная цена без основания не принимается', () => {
    expect(() => parseOrThrow(ProposeCustomPriceRequestSchema, { price: '1000.00' })).toThrow();
  });

  it('переключение функции платформы без основания не принимается', () => {
    expect(() => parseOrThrow(UpdateFeatureFlagRequestSchema, { enabled: true })).toThrow();
    expect(() =>
      parseOrThrow(UpdateFeatureFlagRequestSchema, { enabled: true, reason: 'релиз' }),
    ).not.toThrow();
  });
});
