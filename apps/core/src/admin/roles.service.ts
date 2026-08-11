import { Injectable } from '@nestjs/common';
import { type Role } from '@unicorn/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { errors } from '../common/errors';
import { Database, type RequestContext } from '../db/unit-of-work';

/**
 * Управление ролями пользователей.
 *
 * Закрывает долг предыдущих фаз: роли `admin`, `organizer` и `expert`
 * присваивались оператором прямо в БД, а операция такого веса обязана быть
 * наблюдаемой — кто выдал, кому, когда и на каком основании.
 *
 * Четыре правила, которые и составляют весь смысл модуля:
 *
 *  1. **Только `admin`.** Выдача роли — это раздача прав, а не редактирование
 *     профиля.
 *  2. **Не себе.** Ни выдать, ни снять роль самому себе нельзя: администратор,
 *     повышающий сам себя, не оставляет второй стороны в решении, а снимающий
 *     с себя последнюю админскую роль запирает платформу.
 *  3. **Последний администратор не снимается.** Иначе управление правами
 *     теряется безвозвратно и восстанавливается только доступом к БД.
 *  4. **Всё в журнал.** Событие пишется той же транзакцией, что и сама выдача.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  async list(ctx: RequestContext, userId: string): Promise<GrantedRole[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<RoleRow>(
        `SELECT role, granted_at, revoked_at FROM identity.user_roles
          WHERE user_id = $1
          ORDER BY granted_at DESC`,
        [userId],
      );
      // Пустой результат для несуществующего пользователя и для существующего
      // без ролей выглядит одинаково — и это верно: перечень ролей не должен
      // отвечать на вопрос «есть ли такой аккаунт».
      return rows.map(mapRole);
    });
  }

  async grant(ctx: RequestContext, userId: string, role: Role): Promise<GrantedRole[]> {
    if (userId === ctx.userId) {
      throw errors.forbidden({ stage: 'self-role-grant' });
    }

    return this.db.transaction(ctx, async (tx) => {
      await assertUserExists(tx, userId);
      try {
        await tx.query(
          `INSERT INTO identity.user_roles (user_id, role, granted_by) VALUES ($1, $2, $3)`,
          [userId, role, ctx.userId],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw errors.conflict('Эта роль у пользователя уже есть');
        }
        if ((error as { code?: string }).code === '23514') {
          throw errors.validation([{ path: 'role', message: 'роль вне допустимого списка' }]);
        }
        throw error;
      }

      await this.audit.record(tx, {
        verb: 'identity.role.granted',
        actorId: ctx.userId,
        actorRole: 'admin',
        aggregateType: 'user',
        aggregateId: userId,
        aggregateVersion: await nextRoleVersion(tx, userId),
        payload: { role },
        traceId: ctx.traceId,
      });

      return this.readRoles(tx, userId);
    });
  }

  async revoke(ctx: RequestContext, userId: string, role: Role): Promise<GrantedRole[]> {
    if (userId === ctx.userId) {
      throw errors.forbidden({ stage: 'self-role-revoke' });
    }

    return this.db.transaction(ctx, async (tx) => {
      if (role === 'admin') {
        // Блокировка берётся ДО подсчёта: две одновременные операции иначе
        // увидели бы по два администратора и сняли обоих.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          'identity.admin_roles',
        ]);
        const { rows } = await tx.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM identity.user_roles
            WHERE role = 'admin' AND revoked_at IS NULL`,
        );
        if (Number(rows[0]!.count) <= 1) {
          throw errors.conflict(
            'Нельзя снять роль администратора у последнего администратора платформы',
          );
        }
      }

      const { rowCount } = await tx.query(
        `UPDATE identity.user_roles SET revoked_at = now()
          WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL`,
        [userId, role],
      );
      if (rowCount === 0) throw errors.notFound({ subject: 'role' });

      await this.audit.record(tx, {
        verb: 'identity.role.revoked',
        actorId: ctx.userId,
        actorRole: 'admin',
        aggregateType: 'user',
        aggregateId: userId,
        aggregateVersion: await nextRoleVersion(tx, userId),
        payload: { role },
        traceId: ctx.traceId,
      });

      return this.readRoles(tx, userId);
    });
  }

  private async readRoles(tx: Tx, userId: string): Promise<GrantedRole[]> {
    const { rows } = await tx.query<RoleRow>(
      `SELECT role, granted_at, revoked_at FROM identity.user_roles
        WHERE user_id = $1 ORDER BY granted_at DESC`,
      [userId],
    );
    return rows.map(mapRole);
  }
}

type Tx = Parameters<Parameters<Database['transaction']>[1]>[0];

/**
 * Пользователь должен существовать: выдача роли несуществующему аккаунту
 * упала бы внешним ключом с невнятной ошибкой драйвера.
 */
async function assertUserExists(tx: Tx, userId: string): Promise<void> {
  const { rows } = await tx.query(
    'SELECT 1 FROM identity.users WHERE id = $1 AND deleted_at IS NULL',
    [userId],
  );
  if (rows.length === 0) throw errors.notFound({ subject: 'user' });
}

/** Версия агрегата ролей — по числу уже записанных изменений. */
async function nextRoleVersion(tx: Tx, userId: string): Promise<number> {
  const { rows } = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit.outbox_events
      WHERE aggregate_type = 'user' AND aggregate_id = $1
        AND event_type IN ('identity.role.granted', 'identity.role.revoked')`,
    [userId],
  );
  return Number(rows[0]!.count) + 1;
}

export interface GrantedRole {
  role: string;
  grantedAt: string;
  revokedAt: string | null;
}

interface RoleRow {
  role: string;
  granted_at: Date;
  revoked_at: Date | null;
}

function mapRole(row: RoleRow): GrantedRole {
  return {
    role: row.role,
    grantedAt: row.granted_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}
