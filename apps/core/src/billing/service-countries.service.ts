import { Injectable } from '@nestjs/common';
import {
  ServiceCountryPolicySchema,
  uuidv7,
  type ActivateServiceCountryPolicyRequest,
  type ServiceCountry,
  type ServiceCountryPolicy,
  type ServiceCountryPolicyVersion,
  type UpdateServiceCountryRequest,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Страны обслуживания и их условия (план 0.2 §0г.2 п.7; таблицы M081).
 *
 * Страна хранится за аккаунтом и выбирается явно; условия — версионируемая
 * политика, коммерческие значения — данные, не код. Список стран публичен
 * (регистрация), условия читает вошедший, меняет администратор. Активация
 * новой версии не переписывает раунды, открытые на прежней: они хранят
 * версию, применённую при открытии.
 */
@Injectable()
export class ServiceCountriesService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  /** Активные страны — публично, для выбора при регистрации. */
  async listPublic(traceId: string): Promise<ServiceCountry[]> {
    return this.db.asPublicRole(traceId, async (tx) => {
      const { rows } = await tx.query<CountryRow>(
        `SELECT code, is_active, sort_order FROM billing.service_countries
          WHERE is_active ORDER BY sort_order, code`,
      );
      return rows.map(mapCountry);
    });
  }

  async listAll(ctx: RequestContext): Promise<ServiceCountry[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<CountryRow>(
        `SELECT code, is_active, sort_order FROM billing.service_countries ORDER BY sort_order, code`,
      );
      return rows.map(mapCountry);
    });
  }

  async updateCountry(
    ctx: RequestContext,
    code: string,
    input: UpdateServiceCountryRequest,
  ): Promise<ServiceCountry> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<CountryRow>(
        `UPDATE billing.service_countries
            SET is_active = COALESCE($2, is_active), sort_order = COALESCE($3, sort_order)
          WHERE code = $1
          RETURNING code, is_active, sort_order`,
        [code, input.isActive ?? null, input.sortOrder ?? null],
      );
      const row = rows[0];
      if (!row) throw errors.notFound({ subject: 'service_country', code });
      await this.audit.emit(tx, {
        verb: 'billing.service_country.updated',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'service_country',
        subjectId: code,
        context: { isActive: row.is_active, sortOrder: row.sort_order },
        traceId: ctx.traceId,
      });
      return mapCountry(row);
    });
  }

  /** Действующие условия страны — основатель видит их до открытия раунда. */
  async currentPolicy(ctx: RequestContext, code: string): Promise<ServiceCountryPolicyVersion> {
    return this.db.readOnly(ctx, async (tx) => {
      const policy = await this.activePolicy(tx, code);
      if (!policy) throw errors.notFound({ subject: 'service_country_policy', code });
      return policy;
    });
  }

  async listPolicies(ctx: RequestContext, code: string): Promise<ServiceCountryPolicyVersion[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<PolicyRow>(
        `SELECT ${POLICY_COLUMNS} FROM billing.service_country_policies
          WHERE country_code = $1 ORDER BY version DESC`,
        [code],
      );
      return rows.map(mapPolicy);
    });
  }

  /** Новая версия активируется сразу; прежняя остаётся в истории. */
  async activatePolicy(
    ctx: RequestContext,
    code: string,
    input: ActivateServiceCountryPolicyRequest,
  ): Promise<ServiceCountryPolicyVersion> {
    return this.db.transaction(ctx, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `service-country-policy:${code}`,
      ]);
      const country = await tx.query(`SELECT 1 FROM billing.service_countries WHERE code = $1`, [
        code,
      ]);
      if (country.rows.length === 0) throw errors.notFound({ subject: 'service_country', code });
      await tx.query(
        `UPDATE billing.service_country_policies SET is_active = false WHERE country_code = $1 AND is_active`,
        [code],
      );
      const { rows } = await tx.query<PolicyRow>(
        `INSERT INTO billing.service_country_policies
           (id, country_code, version, config_jsonb, is_active, created_by, reason)
         VALUES ($1, $2, (SELECT COALESCE(MAX(version), 0) + 1 FROM billing.service_country_policies WHERE country_code = $2),
                 $3::jsonb, true, $4, $5)
         RETURNING ${POLICY_COLUMNS}`,
        [uuidv7(), code, JSON.stringify(input.config), ctx.userId, input.reason],
      );
      const row = rows[0]!;
      await this.audit.emit(tx, {
        verb: 'billing.service_country_policy.activated',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'service_country_policy',
        subjectId: row.id,
        context: {
          countryCode: code,
          version: row.version,
          reason: input.reason,
          config: input.config,
        },
        traceId: ctx.traceId,
      });
      return mapPolicy(row);
    });
  }

  /** Страна аккаунта — явный выбор пользователя (не по IP, не по языку). */
  async setUserCountry(ctx: RequestContext, code: string): Promise<{ serviceCountry: string }> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{ code: string }>(
        `SELECT code FROM billing.service_countries WHERE code = $1 AND is_active`,
        [code],
      );
      if (!rows[0]) {
        throw errors.validation([{ path: 'code', message: 'страна обслуживания недоступна' }]);
      }
      const current = await this.userCountry(tx, ctx.userId);
      if (current && current !== code) {
        // Смена страны с историей — отдельное правило (реестр §0г.7); пока
        // переключения нет: страна выбирается один раз.
        throw errors.stateTransition(
          'Страна обслуживания уже выбрана; её смена — отдельное правило, переключения пока нет',
        );
      }
      await tx.query(`UPDATE identity.users SET service_country = $2 WHERE id = $1`, [
        ctx.userId,
        code,
      ]);
      return { serviceCountry: code };
    });
  }

  // ------------------------------------------------------------ для других сервисов

  async userCountry(tx: Tx, userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const { rows } = await tx.query<{ service_country: string | null }>(
      `SELECT service_country FROM identity.users WHERE id = $1`,
      [userId],
    );
    return rows[0]?.service_country ?? null;
  }

  async activePolicy(tx: Tx, code: string): Promise<ServiceCountryPolicyVersion | null> {
    const { rows } = await tx.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM billing.service_country_policies
        WHERE country_code = $1 AND is_active`,
      [code],
    );
    return rows[0] ? mapPolicy(rows[0]) : null;
  }
}

const POLICY_COLUMNS = `id, country_code, version, config_jsonb, is_active, valid_from, created_by, created_at, reason`;

interface CountryRow {
  code: string;
  is_active: boolean;
  sort_order: number;
}
interface PolicyRow {
  id: string;
  country_code: string;
  version: number;
  config_jsonb: unknown;
  is_active: boolean;
  valid_from: Date;
  created_by: string | null;
  created_at: Date;
  reason: string;
}

function mapCountry(row: CountryRow): ServiceCountry {
  return { code: row.code, isActive: row.is_active, sortOrder: row.sort_order };
}

function mapPolicy(row: PolicyRow): ServiceCountryPolicyVersion {
  const parsed = ServiceCountryPolicySchema.safeParse(row.config_jsonb);
  if (!parsed.success) {
    throw errors.internal({
      reason: 'service country policy is malformed',
      code: row.country_code,
      version: row.version,
    });
  }
  const config: ServiceCountryPolicy = parsed.data;
  return {
    id: row.id,
    countryCode: row.country_code,
    version: row.version,
    config,
    isActive: row.is_active,
    validFrom: row.valid_from.toISOString(),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    reason: row.reason,
  };
}
