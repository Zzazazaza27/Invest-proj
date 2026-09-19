import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type CloseRoundPackageRequest,
  type CreateRoundServiceRequest,
  type PublishRoundPackageRequest,
  type PublishRoundServiceOfferRequest,
  type RoundPackage,
  type RoundService,
  type RoundServiceOffer,
  type SetPackageAlternativeRequest,
  type UpdateRoundServiceRequest,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Настройка разовой оплаты запуска раунда (5.9.1).
 *
 * Здесь настраивается ПРЕДЛОЖЕНИЕ: каталог услуг, версии пакетов с ценой и
 * диапазоном суммы запроса, цены докупаемых услуг. Продажи этим модулем не
 * включаются: расчёт стоимости и оплата появятся отдельно, а условия страны
 * по-прежнему держат платные пакеты выключенными.
 *
 * Два правила стоят до записи и повторяются в БД, потому что цена — не то
 * место, где хватает одной проверки:
 *
 *  1. в пакет и в докупку попадает только РЕАЛИЗОВАННАЯ услуга;
 *  2. цена действующей версии не правится — публикуется новая версия, а
 *     прежняя закрывается тем же моментом. Диапазоны сумм внутри страны не
 *     пересекаются, иначе «подходящий пакет» зависел бы от порядка строк.
 *
 * Валюта проверяется по условиям страны: продавать в валюте, которой у
 * страны нет, нельзя.
 */
@Injectable()
export class RoundPackagesService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  // ------------------------------------------------------------------ услуги

  async listServices(ctx: RequestContext): Promise<RoundService[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<ServiceRow>(
        `SELECT id, code, name, description, is_implemented, created_at
           FROM billing.round_services ORDER BY code`,
      );
      return rows.map(mapService);
    });
  }

  async createService(
    ctx: RequestContext,
    input: CreateRoundServiceRequest,
  ): Promise<RoundService> {
    return this.db.transaction(ctx, async (tx) => {
      const id = uuidv7();
      // Код — имя настройки, и повторный код это не сбой сервера, а занятое
      // имя: отвечаем конфликтом, а не падением уникального индекса.
      const { rowCount } = await tx.query(
        `INSERT INTO billing.round_services (id, code, name, description, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (code) DO NOTHING`,
        [id, input.code, input.name, input.description ?? null, ctx.userId],
      );
      if (rowCount === 0) throw errors.conflict('Услуга с таким кодом уже заведена');
      await this.audit.emit(tx, {
        verb: 'billing.round_service.created',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'round_service',
        subjectId: id,
        context: { code: input.code },
        traceId: ctx.traceId,
      });
      return this.readService(tx, id);
    });
  }

  /**
   * Правка услуги, включая отметку «реализована».
   *
   * Снятие отметки не трогает совершённые покупки и уже опубликованные
   * пакеты: цена и состав в них — исторический факт. Новые пакеты с этой
   * услугой собрать будет нельзя.
   */
  async updateService(
    ctx: RequestContext,
    serviceId: string,
    input: UpdateRoundServiceRequest,
  ): Promise<RoundService> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE billing.round_services
            SET name           = COALESCE($2, name),
                description    = CASE WHEN $3::boolean THEN $4 ELSE description END,
                is_implemented = COALESCE($5, is_implemented),
                updated_at     = now()
          WHERE id = $1
          RETURNING id`,
        [
          serviceId,
          input.name ?? null,
          input.description !== undefined,
          input.description ?? null,
          input.isImplemented ?? null,
        ],
      );
      if (!rows[0]) throw errors.notFound({ subject: 'round_service' });
      await this.audit.emit(tx, {
        verb: 'billing.round_service.updated',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'round_service',
        subjectId: serviceId,
        context: { isImplemented: input.isImplemented ?? null, reason: input.reason },
        traceId: ctx.traceId,
      });
      return this.readService(tx, serviceId);
    });
  }

  // ------------------------------------------------------------------ пакеты

  async listPackages(ctx: RequestContext): Promise<RoundPackage[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<PackageRow>(`${PACKAGE_SELECT} ORDER BY p.country_code,
         p.min_target, p.version DESC`);
      return rows.map(mapPackage);
    });
  }

  async publishPackage(
    ctx: RequestContext,
    input: PublishRoundPackageRequest,
  ): Promise<RoundPackage> {
    return this.db.transaction(ctx, async (tx) => {
      await this.assertCurrencyAllowed(tx, input.countryCode, input.currency);

      const validFrom = input.validFrom ? new Date(input.validFrom) : new Date();
      if (validFrom.getTime() < Date.now() - 60_000) {
        throw errors.validation([
          { path: 'validFrom', message: 'версия не публикуется задним числом' },
        ]);
      }

      const services = await this.resolveServices(tx, input.serviceCodes);

      const { rows: next } = await tx.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
           FROM billing.round_packages WHERE code = $1`,
        [input.code],
      );
      const version = Number(next[0]?.next_version ?? 1);

      // Прежняя действующая версия того же кода закрывается ровно тем
      // моментом, с которого начинает действовать новая: в сетке не должно
      // быть ни дыры, ни двух цен одновременно.
      await tx.query(
        `UPDATE billing.round_packages
            SET valid_to = $2
          WHERE code = $1 AND valid_to IS NULL AND valid_from < $2`,
        [input.code, validFrom.toISOString()],
      );

      // Пересечение диапазонов — ошибка настройки, а не сбой: сообщаем, с чем
      // именно спорит новая версия. Триггер БД остаётся последней защитой.
      const { rows: clash } = await tx.query<{
        code: string;
        min_target: string;
        max_target: string | null;
      }>(
        `SELECT code, min_target::text AS min_target, max_target::text AS max_target
           FROM billing.round_packages
          WHERE country_code = $1
            AND code <> $2
            AND tstzrange(valid_from, valid_to, '[)') && tstzrange($3::timestamptz, NULL, '[)')
            AND numrange(min_target, max_target, '[)')
                && numrange($4::numeric, $5::numeric, '[)')
          LIMIT 1`,
        [
          input.countryCode,
          input.code,
          validFrom.toISOString(),
          input.minTarget,
          input.maxTarget ?? null,
        ],
      );
      if (clash[0]) {
        throw errors.validation([
          {
            path: 'minTarget',
            message:
              `диапазон пересекается с пакетом «${clash[0].code}» ` +
              `(${clash[0].min_target} — ${clash[0].max_target ?? 'и выше'})`,
          },
        ]);
      }

      const id = uuidv7();
      await tx.query(
        `INSERT INTO billing.round_packages
           (id, code, version, country_code, name, description, price, currency,
            min_target, max_target, valid_from, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9::numeric, $10::numeric, $11, $12, $13)`,
        [
          id,
          input.code,
          version,
          input.countryCode,
          input.name,
          input.description ?? null,
          input.price,
          input.currency,
          input.minTarget,
          input.maxTarget ?? null,
          validFrom.toISOString(),
          input.reason,
          ctx.userId,
        ],
      );
      for (const service of services) {
        await tx.query(
          `INSERT INTO billing.round_package_services (package_id, service_id) VALUES ($1, $2)`,
          [id, service.id],
        );
      }

      await this.audit.emit(tx, {
        verb: 'billing.round_package.published',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'round_package',
        subjectId: id,
        context: {
          code: input.code,
          version,
          country: input.countryCode,
          price: input.price,
          currency: input.currency,
          minTarget: input.minTarget,
          maxTarget: input.maxTarget ?? null,
          services: services.map((s) => s.code),
          reason: input.reason,
        },
        traceId: ctx.traceId,
      });

      return this.readPackage(tx, id);
    });
  }

  /** Снятие версии с продажи. Совершённые покупки не затрагиваются. */
  async closePackage(
    ctx: RequestContext,
    packageId: string,
    input: CloseRoundPackageRequest,
  ): Promise<RoundPackage> {
    return this.db.transaction(ctx, async (tx) => {
      const validTo = input.validTo ? new Date(input.validTo) : new Date();
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE billing.round_packages
            SET valid_to = $2
          WHERE id = $1 AND (valid_to IS NULL OR valid_to > $2)
          RETURNING id`,
        [packageId, validTo.toISOString()],
      );
      if (!rows[0]) throw errors.notFound({ subject: 'round_package' });
      await this.audit.emit(tx, {
        verb: 'billing.round_package.closed',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'round_package',
        subjectId: packageId,
        context: { validTo: validTo.toISOString(), reason: input.reason },
        traceId: ctx.traceId,
      });
      return this.readPackage(tx, packageId);
    });
  }

  /**
   * Назначить пакету допустимую альтернативу.
   *
   * Список задаёт администратор ЯВНО: ни цена, ни совпадение состава заменой
   * не делают (решение владельца 2026-09-19). Несовпадение состава не
   * запрещается — оно возвращается предупреждением, потому что решение о
   * замене принимает человек, а не арифметика.
   */
  async addAlternative(
    ctx: RequestContext,
    input: SetPackageAlternativeRequest,
  ): Promise<{ packages: RoundPackage[]; warning: string | null }> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows: missing } = await tx.query<{ name: string }>(
        `SELECT s.name
           FROM billing.round_package_services ps
           JOIN billing.round_services s ON s.id = ps.service_id
          WHERE ps.package_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM billing.round_package_services alt
               WHERE alt.package_id = $2 AND alt.service_id = ps.service_id)
          ORDER BY s.name`,
        [input.packageId, input.alternativeId],
      );

      await tx.query(
        `INSERT INTO billing.round_package_alternatives
           (package_id, alternative_id, reason, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (package_id, alternative_id) DO NOTHING`,
        [input.packageId, input.alternativeId, input.reason, ctx.userId],
      );

      await this.audit.emit(tx, {
        verb: 'billing.package_alternative.added',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'round_package',
        subjectId: input.packageId,
        context: {
          alternativeId: input.alternativeId,
          reason: input.reason,
          missingServices: missing.map((m) => m.name),
        },
        traceId: ctx.traceId,
      });

      return {
        packages: await this.listIn(tx),
        warning:
          missing.length === 0
            ? null
            : `Состав альтернативы не покрывает требуемый пакет: ${missing
                .map((m) => m.name)
                .join(', ')}. Замена назначена — решение за вами.`,
      };
    });
  }

  async removeAlternative(
    ctx: RequestContext,
    input: SetPackageAlternativeRequest,
  ): Promise<RoundPackage[]> {
    return this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `DELETE FROM billing.round_package_alternatives
          WHERE package_id = $1 AND alternative_id = $2`,
        [input.packageId, input.alternativeId],
      );
      if (rowCount === 0) throw errors.notFound({ subject: 'round_package_alternative' });
      await this.audit.emit(tx, {
        verb: 'billing.package_alternative.removed',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'round_package',
        subjectId: input.packageId,
        context: { alternativeId: input.alternativeId, reason: input.reason },
        traceId: ctx.traceId,
      });
      return this.listIn(tx);
    });
  }

  private async listIn(tx: Tx): Promise<RoundPackage[]> {
    const { rows } = await tx.query<PackageRow>(
      `${PACKAGE_SELECT} ORDER BY p.country_code, p.min_target, p.version DESC`,
    );
    return rows.map(mapPackage);
  }

  // ------------------------------------------------------- цены докупки

  async listServiceOffers(ctx: RequestContext): Promise<RoundServiceOffer[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<OfferRow>(`${OFFER_SELECT} ORDER BY s.code, o.version DESC`);
      return rows.map(mapOffer);
    });
  }

  async publishServiceOffer(
    ctx: RequestContext,
    input: PublishRoundServiceOfferRequest,
  ): Promise<RoundServiceOffer> {
    return this.db.transaction(ctx, async (tx) => {
      await this.assertCurrencyAllowed(tx, input.countryCode, input.currency);
      const [service] = await this.resolveServices(tx, [input.serviceCode]);
      const validFrom = input.validFrom ? new Date(input.validFrom) : new Date();

      const { rows: next } = await tx.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
           FROM billing.round_service_offers WHERE service_id = $1 AND country_code = $2`,
        [service!.id, input.countryCode],
      );
      const version = Number(next[0]?.next_version ?? 1);

      await tx.query(
        `UPDATE billing.round_service_offers
            SET valid_to = $3
          WHERE service_id = $1 AND country_code = $2 AND valid_to IS NULL AND valid_from < $3`,
        [service!.id, input.countryCode, validFrom.toISOString()],
      );

      const id = uuidv7();
      await tx.query(
        `INSERT INTO billing.round_service_offers
           (id, service_id, country_code, version, price, currency, valid_from, reason, created_by)
         VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9)`,
        [
          id,
          service!.id,
          input.countryCode,
          version,
          input.price,
          input.currency,
          validFrom.toISOString(),
          input.reason,
          ctx.userId,
        ],
      );

      await this.audit.emit(tx, {
        verb: 'billing.round_service_offer.published',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'round_service',
        subjectId: service!.id,
        context: {
          country: input.countryCode,
          version,
          price: input.price,
          currency: input.currency,
          reason: input.reason,
        },
        traceId: ctx.traceId,
      });

      const { rows } = await tx.query<OfferRow>(`${OFFER_SELECT} WHERE o.id = $1`, [id]);
      return mapOffer(rows[0]!);
    });
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Валюта обязана быть среди разрешённых условиями страны: иначе покупку
   * нельзя было бы ни выставить, ни сверить с политикой.
   */
  private async assertCurrencyAllowed(
    tx: Tx,
    countryCode: string,
    currency: string,
  ): Promise<void> {
    const { rows } = await tx.query<{ allowed: string[] | null }>(
      `SELECT ARRAY(SELECT jsonb_array_elements_text(config_jsonb->'allowedRoundCurrencies'))
                AS allowed
         FROM billing.service_country_policies
        WHERE country_code = $1 AND is_active
        LIMIT 1`,
      [countryCode],
    );
    const allowed = rows[0]?.allowed;
    if (!allowed) {
      throw errors.validation([
        { path: 'countryCode', message: 'у страны нет действующих условий обслуживания' },
      ]);
    }
    if (!allowed.includes(currency)) {
      throw errors.validation([
        {
          path: 'currency',
          message: `валюта не разрешена условиями страны (${allowed.join(', ')})`,
        },
      ]);
    }
  }

  private async resolveServices(tx: Tx, codes: string[]): Promise<{ id: string; code: string }[]> {
    if (codes.length === 0) return [];
    const { rows } = await tx.query<{ id: string; code: string; is_implemented: boolean }>(
      `SELECT id, code, is_implemented FROM billing.round_services WHERE code = ANY($1::text[])`,
      [codes],
    );
    const missing = codes.filter((code) => !rows.some((r) => r.code === code));
    if (missing.length > 0) {
      throw errors.validation([
        { path: 'serviceCodes', message: `услуги не найдены: ${missing.join(', ')}` },
      ]);
    }
    const planned = rows.filter((r) => !r.is_implemented).map((r) => r.code);
    if (planned.length > 0) {
      throw errors.validation([
        {
          path: 'serviceCodes',
          message: `услуги не помечены реализованными: ${planned.join(', ')}`,
        },
      ]);
    }
    return rows.map((r) => ({ id: r.id, code: r.code }));
  }

  private async readService(tx: Tx, id: string): Promise<RoundService> {
    const { rows } = await tx.query<ServiceRow>(
      `SELECT id, code, name, description, is_implemented, created_at
         FROM billing.round_services WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw errors.notFound({ subject: 'round_service' });
    return mapService(rows[0]);
  }

  private async readPackage(tx: Tx, id: string): Promise<RoundPackage> {
    const { rows } = await tx.query<PackageRow>(`${PACKAGE_SELECT} WHERE p.id = $1`, [id]);
    if (!rows[0]) throw errors.notFound({ subject: 'round_package' });
    return mapPackage(rows[0]);
  }
}

const PACKAGE_SELECT = `
  SELECT p.id, p.code, p.version, p.country_code, p.name, p.description,
         p.price::text AS price, p.currency,
         p.min_target::text AS min_target, p.max_target::text AS max_target,
         p.valid_from, p.valid_to, p.reason, p.validity_days,
         COALESCE(
           (SELECT jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name) ORDER BY s.code)
              FROM billing.round_package_services ps
              JOIN billing.round_services s ON s.id = ps.service_id
             WHERE ps.package_id = p.id),
           '[]'::jsonb) AS services,
         COALESCE(
           (SELECT jsonb_agg(jsonb_build_object(
                     'code', alt.code,
                     'name', alt.name,
                     'coversComposition', NOT EXISTS (
                        SELECT 1 FROM billing.round_package_services ps
                         WHERE ps.package_id = p.id
                           AND NOT EXISTS (
                             SELECT 1 FROM billing.round_package_services a2
                              WHERE a2.package_id = alt.id AND a2.service_id = ps.service_id)))
                   ORDER BY alt.code)
              FROM billing.round_package_alternatives a
              JOIN billing.round_packages alt ON alt.id = a.alternative_id
             WHERE a.package_id = p.id),
           '[]'::jsonb) AS alternatives
    FROM billing.round_packages p
`;

const OFFER_SELECT = `
  SELECT o.id, s.code AS service_code, s.name AS service_name, o.country_code, o.version,
         o.price::text AS price, o.currency, o.valid_from, o.valid_to, o.reason
    FROM billing.round_service_offers o
    JOIN billing.round_services s ON s.id = o.service_id
`;

interface ServiceRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_implemented: boolean;
  created_at: Date;
}

interface PackageRow {
  id: string;
  code: string;
  version: number;
  country_code: string;
  name: string;
  description: string | null;
  price: string;
  currency: string;
  min_target: string;
  max_target: string | null;
  valid_from: Date;
  valid_to: Date | null;
  reason: string;
  validity_days: number;
  services: { code: string; name: string }[];
  alternatives: { code: string; name: string; coversComposition: boolean }[];
}

interface OfferRow {
  id: string;
  service_code: string;
  service_name: string;
  country_code: string;
  version: number;
  price: string;
  currency: string;
  valid_from: Date;
  valid_to: Date | null;
  reason: string;
}

function mapService(row: ServiceRow): RoundService {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isImplemented: row.is_implemented,
    createdAt: row.created_at.toISOString(),
  };
}

function mapPackage(row: PackageRow): RoundPackage {
  const now = Date.now();
  const from = row.valid_from.getTime();
  const to = row.valid_to?.getTime() ?? null;
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    countryCode: row.country_code,
    name: row.name,
    description: row.description,
    price: row.price,
    currency: row.currency,
    minTarget: row.min_target,
    maxTarget: row.max_target,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to?.toISOString() ?? null,
    services: row.services,
    alternatives: row.alternatives,
    validityDays: row.validity_days,
    isLocked: from <= now,
    isActive: from <= now && (to === null || to > now),
    reason: row.reason,
  };
}

function mapOffer(row: OfferRow): RoundServiceOffer {
  const now = Date.now();
  const from = row.valid_from.getTime();
  const to = row.valid_to?.getTime() ?? null;
  return {
    id: row.id,
    serviceCode: row.service_code,
    serviceName: row.service_name,
    countryCode: row.country_code,
    version: row.version,
    price: row.price,
    currency: row.currency,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to?.toISOString() ?? null,
    isActive: from <= now && (to === null || to > now),
    reason: row.reason,
  };
}
