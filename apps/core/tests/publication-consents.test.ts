import { describe, expect, it } from 'vitest';
import { PUBLICATION_DELETION_SLA_MINUTES } from '@unicorn/contracts';
import { deletionDeadline } from '../src/identity/publication-consents.service';

/**
 * Срок удаления публичной проекции после отзыва согласия.
 *
 * Пятнадцать минут — обязательство перед субъектом ПДн, а не пожелание
 * медиаконтуру. Значение приходит из контрактов, а не зашито здесь числом:
 * тест, повторяющий константу своей копией, остаётся зелёным ровно тогда,
 * когда константу поменяли, а код за ней не последовал.
 */
describe('крайний срок удаления проекции', () => {
  it('отсчитывается от момента отзыва', () => {
    const revokedAt = new Date('2026-08-21T10:00:00.000Z');
    expect(deletionDeadline(revokedAt)).toBe('2026-08-21T10:15:00.000Z');
  });

  it('равен сроку из контрактов, а не собственному числу', () => {
    const revokedAt = new Date('2026-01-01T00:00:00.000Z');
    const gapMinutes = (Date.parse(deletionDeadline(revokedAt)) - revokedAt.getTime()) / 60_000;
    expect(gapMinutes).toBe(PUBLICATION_DELETION_SLA_MINUTES);
  });
});
