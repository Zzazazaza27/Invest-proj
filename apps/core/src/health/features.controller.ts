import { Controller, Get } from '@nestjs/common';
import { FeaturesSchema, PUBLIC_FEATURE_KEYS, type Features } from '@unicorn/contracts';
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
    const enabled = await this.db.readOnly(anonymous, async (tx) => {
      const { rows } = await tx.query<{ key: string; enabled: boolean }>(
        `SELECT key, enabled FROM audit.feature_flags WHERE key = ANY($1::text[])`,
        [[...PUBLIC_FEATURE_KEYS]],
      );
      return new Map(rows.map((row) => [row.key, row.enabled]));
    });
    const flags = Object.fromEntries(
      PUBLIC_FEATURE_KEYS.map((key) => [key, enabled.get(key) ?? false]),
    ) as Features['flags'];
    return FeaturesSchema.parse({ flags });
  }
}
