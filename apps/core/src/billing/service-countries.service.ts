import { Injectable } from '@nestjs/common';
import { type ServiceCountry, type UpdateServiceCountryRequest } from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Страны обслуживания (план 0.2 §0г.2 п.7; таблица M081).
 *
 * Страна хранится за аккаунтом и выбирается явно. Список публичен
 * (регистрация), меняет администратор. Условия стран удалены в 2.1-W05
 * вместе с раундами, которые они настраивали.
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

  /** Новая страна — строка, не миграция; создаётся выключенной, включается отдельно. */
  async createCountry(ctx: RequestContext, code: string): Promise<ServiceCountry> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<CountryRow>(
        `INSERT INTO billing.service_countries (code, is_active, sort_order)
         VALUES ($1, false, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM billing.service_countries))
         ON CONFLICT (code) DO NOTHING
         RETURNING code, is_active, sort_order`,
        [code],
      );
      const row = rows[0];
      if (!row) throw errors.conflict(`Страна ${code} уже заведена`);
      await this.audit.emit(tx, {
        verb: 'billing.service_country.updated',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'service_country',
        // subject_id в аудите — UUID; код страны — в контексте.
        subjectId: null,
        context: { code, created: true, isActive: false },
        traceId: ctx.traceId,
      });
      return mapCountry(row);
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
        subjectId: null,
        context: { code, isActive: row.is_active, sortOrder: row.sort_order },
        traceId: ctx.traceId,
      });
      return mapCountry(row);
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
}

interface CountryRow {
  code: string;
  is_active: boolean;
  sort_order: number;
}

function mapCountry(row: CountryRow): ServiceCountry {
  return { code: row.code, isActive: row.is_active, sortOrder: row.sort_order };
}
