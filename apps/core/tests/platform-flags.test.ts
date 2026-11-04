import { describe, expect, it } from 'vitest';
import { UpdateFeatureFlagRequestSchema } from '@fifth/contracts';
import { parseOrThrow } from '../src/common/validation';

/**
 * Переключение функции платформы — решение оператора, и без основания оно не
 * принимается ещё до обращения к базе. Тарифы, подписки и прочий денежный
 * контур, которые проверялись здесь раньше, удалены в 2.1-W05.
 */
describe('Переключение функции платформы требует основания', () => {
  it('без основания не принимается', () => {
    expect(() => parseOrThrow(UpdateFeatureFlagRequestSchema, { enabled: true })).toThrow();
    expect(() =>
      parseOrThrow(UpdateFeatureFlagRequestSchema, { enabled: true, reason: 'релиз' }),
    ).not.toThrow();
  });
});
