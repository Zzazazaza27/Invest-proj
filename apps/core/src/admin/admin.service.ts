import { Injectable } from '@nestjs/common';
import { type FeatureFlag, type SkinId, type UiSkin, UI_SKIN_FLAG } from '@unicorn/contracts';
import { errors } from '../common/errors';
import { mapDbErrors } from '../common/db-errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext } from '../db/unit-of-work';

/**
 * Административное управление платформой: флаги функций и скин.
 *
 * Тарифы, подписки и настройки ИИ удалены вместе с инвестиционным процессом и
 * анализом ИИ (2.1-W05).
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  // --------------------------------------------------------- фичефлаги

  async listFeatureFlags(ctx: RequestContext): Promise<FeatureFlag[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<FlagRow>(
        'SELECT key, enabled, rules_jsonb, updated_at FROM audit.feature_flags ORDER BY key',
      );
      return rows.map((r) => ({
        key: r.key,
        enabled: r.enabled,
        rules: r.rules_jsonb,
        updatedAt: r.updated_at.toISOString(),
      }));
    });
  }

  /**
   * Применить скин для всей платформы (M145).
   *
   * Тот же флаг платформы, что и остальные: запись администратором с
   * причиной, `updated_by`/`updated_at` и событие `admin.feature_flag.changed`
   * — в контексте ключ, новое и прежнее значение. Допустимость значения
   * проверена схемой запроса (`SKIN_IDS`).
   */
  async setUiSkin(ctx: RequestContext, skin: SkinId, reason: string): Promise<UiSkin> {
    return mapDbErrors(async () =>
      this.db.transaction(ctx, async (tx) => {
        const before = await tx.query<{ value: string | null }>(
          `SELECT rules_jsonb->>'value' AS value FROM audit.feature_flags
            WHERE key = $1 FOR UPDATE`,
          [UI_SKIN_FLAG],
        );
        if (!before.rows[0]) throw errors.notFound({ subject: 'feature_flag', key: UI_SKIN_FLAG });
        const previous = before.rows[0].value;

        const { rows } = await tx.query<{ updated_at: Date }>(
          `UPDATE audit.feature_flags
              SET rules_jsonb = rules_jsonb || jsonb_build_object('value', $2::text),
                  updated_by = $3, updated_at = now()
            WHERE key = $1
            RETURNING updated_at`,
          [UI_SKIN_FLAG, skin, ctx.userId],
        );

        await this.audit.emit(tx, {
          verb: 'admin.feature_flag.changed',
          actorId: ctx.userId,
          actorRole: 'admin',
          subjectType: 'feature_flag',
          subjectId: null,
          context: { key: UI_SKIN_FLAG, value: skin, previous, reason },
          traceId: ctx.traceId,
        });

        return { skin, updatedAt: rows[0]!.updated_at.toISOString() };
      }),
    );
  }

  async setFeatureFlag(
    ctx: RequestContext,
    key: string,
    enabled: boolean,
    reason: string,
  ): Promise<FeatureFlag> {
    // Скин — значение, а не включатель: «выключить» его нечем, и переключатель
    // флагов записал бы бессмысленное `enabled`. Меняется только через
    // setUiSkin — там проверяется допустимое значение.
    if (key === UI_SKIN_FLAG) {
      throw errors.conflict('Скин меняется в «Элементах интерфейса», не переключателем флагов', {
        key,
      });
    }
    return mapDbErrors(async () =>
      this.db.transaction(ctx, async (tx) => {
        const { rows } = await tx.query<FlagRow>(
          `UPDATE audit.feature_flags
              SET enabled = $2, updated_by = $3, updated_at = now()
            WHERE key = $1
            RETURNING key, enabled, rules_jsonb, updated_at`,
          [key, enabled, ctx.userId],
        );
        const row = rows[0];
        if (!row) throw errors.notFound({ subject: 'feature_flag' });

        await this.audit.emit(tx, {
          verb: 'admin.feature_flag.changed',
          actorId: ctx.userId,
          actorRole: 'admin',
          subjectType: 'feature_flag',
          subjectId: null,
          context: { key, enabled, reason },
          traceId: ctx.traceId,
        });

        return {
          key: row.key,
          enabled: row.enabled,
          rules: row.rules_jsonb,
          updatedAt: row.updated_at.toISOString(),
        };
      }),
    );
  }
}

interface FlagRow {
  key: string;
  enabled: boolean;
  rules_jsonb: Record<string, unknown>;
  updated_at: Date;
}
