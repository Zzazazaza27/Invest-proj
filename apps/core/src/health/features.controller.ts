import { Controller, Get } from '@nestjs/common';
import {
  DEFAULT_SKIN,
  FeaturesSchema,
  PUBLIC_FEATURE_KEYS,
  SKIN_IDS,
  UI_SKIN_FLAG,
  type Features,
  type SkinId,
} from '@fifth/contracts';
import { Public } from '../auth/guards';
import { Database } from '../db/unit-of-work';

/**
 * Публичные флаги интерфейса.
 *
 * До M071 у кабинетов не было способа узнать состояние платформы иначе, чем
 * получив отказ `feature_disabled` (заявка-01 §8.8). Кабинет основателя
 * читает отсюда, показывать ли карточку подписки (платёжный барьер) и какую
 * версию интерфейса открывать. Отдаётся строгий allowlist: остальные флаги
 * — состояние платформы, а не интерфейса, и наружу не уходят.
 *
 * Отсутствующий в БД ключ — `false`: неизвестное состояние безопаснее
 * считать выключенным.
 */
@Controller('features')
export class FeaturesController {
  constructor(private readonly db: Database) {}

  @Public()
  @Get()
  async features(): Promise<Features> {
    const anonymous = { userId: null, roles: [], traceId: 'features' };
    const { enabled, skinValue } = await this.db.readOnly(anonymous, async (tx) => {
      const { rows } = await tx.query<{ key: string; enabled: boolean; value: string | null }>(
        `SELECT key, enabled, rules_jsonb->>'value' AS value
           FROM audit.feature_flags WHERE key = ANY($1::text[])`,
        [[...PUBLIC_FEATURE_KEYS, UI_SKIN_FLAG]],
      );
      return {
        enabled: new Map(rows.map((row) => [row.key, row.enabled])),
        skinValue: rows.find((row) => row.key === UI_SKIN_FLAG)?.value ?? null,
      };
    });
    const flags = Object.fromEntries(
      PUBLIC_FEATURE_KEYS.map((key) => [key, enabled.get(key) ?? false]),
    ) as Features['flags'];
    // Скин платформы (M145). Строки ещё нет (первый запуск) или значение не из
    // SKIN_IDS — отдаётся DEFAULT_SKIN, тот же, что в `data-brand` у
    // index.html: интерфейсы остаются как собраны, а не ломаются.
    const skin = (SKIN_IDS as readonly string[]).includes(skinValue ?? '')
      ? (skinValue as SkinId)
      : DEFAULT_SKIN;
    return FeaturesSchema.parse({ flags, skin });
  }
}
