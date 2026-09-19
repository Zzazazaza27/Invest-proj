import { describe, expect, it } from 'vitest';
import {
  ClosePlanRequestSchema,
  PublishPlanRequestSchema,
  UpdateFeatureFlagRequestSchema,
} from '@unicorn/contracts';
import { parseOrThrow } from '../src/common/validation';

/**
 * Контракты административного управления тарифами ИНВЕСТОРА.
 *
 * Подписка основателя по сумме привлечения отменена (M094): тарифы остались
 * только у инвестора, индивидуальной цены и лимита запроса больше нет.
 * Проверяется то, что должно отсекаться ещё до обращения к базе: тариф без
 * цены, кривой код, изменение условий без основания. Неизменяемость истории
 * цен проверяется отдельно — против реального PostgreSQL, потому что она
 * живёт в триггерах.
 */

const VALID = {
  code: 'investor_membership',
  name: 'Членство инвестора',
  price: '9990.00',
  billingPeriod: 'monthly',
  features: { included: ['полные карточки проектов'] },
};

describe('Публикация версии тарифа', () => {
  it('корректная заявка принимается', () => {
    expect(() => parseOrThrow(PublishPlanRequestSchema, VALID)).not.toThrow();
  });

  it('тариф без цены не принимается: бесплатный тариф — это отсутствие тарифа', () => {
    const { price, ...withoutPrice } = VALID;
    void price;
    expect(() => parseOrThrow(PublishPlanRequestSchema, withoutPrice)).toThrow();
  });

  it('код тарифа — по форме, а не произвольная строка', () => {
    expect(() =>
      parseOrThrow(PublishPlanRequestSchema, { ...VALID, code: 'Тариф Инвестора' }),
    ).toThrow();
    expect(() =>
      parseOrThrow(PublishPlanRequestSchema, { ...VALID, code: 'investor_pro_2027' }),
    ).not.toThrow();
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
    // Поля отменённой модели не должны приниматься «по инерции».
    expect(() =>
      parseOrThrow(PublishPlanRequestSchema, { ...VALID, askLimit: '10000000.00' }),
    ).toThrow();
    expect(() =>
      parseOrThrow(PublishPlanRequestSchema, { ...VALID, audience: 'founder' }),
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

  it('переключение функции платформы без основания не принимается', () => {
    expect(() => parseOrThrow(UpdateFeatureFlagRequestSchema, { enabled: true })).toThrow();
    expect(() =>
      parseOrThrow(UpdateFeatureFlagRequestSchema, { enabled: true, reason: 'релиз' }),
    ).not.toThrow();
  });
});
