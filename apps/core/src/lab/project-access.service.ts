import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type ExcludeAccessRequest,
  type GrantAccessRequest,
  type GrantPermission,
  type ProjectAccessEntry,
  type ProjectAccessList,
  type ProjectVisibility,
} from '@fifth/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { CryptoService } from '../crypto/crypto.service';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Выдача и отзыв разрешений выбранным получателям (5.8, план `заявка-04`
 * §3.2). Модель доступа уже есть с 5.7 — здесь только действия владельца над
 * ней.
 *
 * Что важно:
 *
 *  * разрешение — НАБОР частей (`profile`, `round`, `materials`, `passport`,
 *    `extended`), не уровень. Тизер отдельно не выдаётся: он есть у всякого,
 *    у кого есть хоть одно действующее разрешение (предикат, п. 8);
 *  * получатель называется точным адресом почты. Поиска по людям у владельца
 *    нет: справочник платформы — не функция кабинета проекта. Адрес
 *    превращается в идентификатор функцией `lab.resolve_grantee` (M091),
 *    которая по слепому индексу отдаёт только идентификатор и имя;
 *  * отзыв — `revoked_at`, а не удаление: кто и что открывал, остаётся
 *    видно и после закрытия доступа;
 *  * у получателя одна действующая запись на проект: повторная выдача
 *    ЗАМЕНЯЕТ набор (частичный уникальный индекс, M091). Иначе «отозвать»
 *    перестало бы означать «доступ закрыт» — рядом осталась бы вторая
 *    строка;
 *  * исключение перекрывает и режим, и любое разрешение; в режиме `public`
 *    оно надёжно только против входа под учётной записью, и интерфейс
 *    говорит это прямо.
 *
 * Права проверяет RLS: строку проекта читает только команда и админ
 * (`projects_select`, M090), поэтому посторонний получает 404 на самом
 * первом шаге, а не отказ на записи.
 */
@Injectable()
export class ProjectAccessService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly crypto: CryptoService,
  ) {}

  async list(ctx: RequestContext, projectId: string): Promise<ProjectAccessList> {
    return this.db.readOnly(ctx, async (tx) => {
      const visibility = await this.projectVisibility(tx, projectId);
      const { rows } = await tx.query<EntryRow>(
        // Только действующие: карточка отвечает на вопрос «кому доступ открыт
        // СЕЙЧАС». Отозванные записи остаются в БД и в журнале как история,
        // но в списке рядом с действующими читались бы как открытый доступ.
        `SELECT kind, entry_id, subject_kind, subject_id, subject_name, permissions,
                created_at, reason, revoked_at
           FROM lab.project_access_entries($1)
          WHERE revoked_at IS NULL`,
        [projectId],
      );
      const entries = rows.map(mapEntry);
      return {
        visibility,
        grants: entries.filter((e) => e.kind === 'grant'),
        exclusions: entries.filter((e) => e.kind === 'exclusion'),
      };
    });
  }

  /** Выдать набор разрешений получателю, названному адресом почты. */
  async grant(
    ctx: RequestContext,
    projectId: string,
    input: GrantAccessRequest,
  ): Promise<ProjectAccessEntry> {
    const index = await this.crypto.blindIndex(input.email, 'email');
    return this.db.transaction(ctx, async (tx) => {
      await this.projectVisibility(tx, projectId);
      const grantee = await this.resolveGrantee(tx, index);
      await this.assertNotTeam(tx, projectId, grantee.userId);

      // Набор нормализуется: порядок и повторы в наборе ничего не значат, а
      // различать `{profile,round}` и `{round,profile}` в истории — шум.
      const permissions = [...new Set(input.permissions)].sort();
      const { rows } = await tx.query<GrantRow>(
        `INSERT INTO lab.project_access_grants
             (id, project_id, grantee_user_id, permissions, granted_by, reason)
         VALUES ($1, $2, $3, $4::text[], $5, $6)
         ON CONFLICT (project_id, grantee_user_id) WHERE revoked_at IS NULL AND grantee_user_id IS NOT NULL
         DO UPDATE SET permissions = EXCLUDED.permissions,
                       reason      = EXCLUDED.reason,
                       granted_by  = EXCLUDED.granted_by,
                       granted_at  = now()
         RETURNING id, permissions, granted_at, reason, revoked_at`,
        [uuidv7(), projectId, grantee.userId, permissions, ctx.userId, input.reason ?? null],
      );
      const row = rows[0]!;

      // В журнал идёт идентификатор, не адрес: адрес — персональные данные,
      // а для разбора «кому открывали» хватает идентификатора.
      await this.audit.emit(tx, {
        verb: 'lab.project_access.granted',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'project',
        subjectId: projectId,
        context: { granteeUserId: grantee.userId, permissions },
        traceId: ctx.traceId,
      });

      return {
        id: row.id,
        kind: 'grant',
        subjectKind: 'user',
        subjectId: grantee.userId,
        subjectName: grantee.displayName,
        permissions: row.permissions as GrantPermission[],
        createdAt: row.granted_at.toISOString(),
        reason: row.reason,
        revokedAt: null,
      };
    });
  }

  /** Закрыть выданный доступ. Повторный отзыв — не ошибка. */
  async revokeGrant(ctx: RequestContext, projectId: string, grantId: string): Promise<void> {
    await this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{ grantee_user_id: string | null }>(
        `UPDATE lab.project_access_grants
            SET revoked_at = now()
          WHERE id = $2 AND project_id = $1 AND revoked_at IS NULL
          RETURNING grantee_user_id`,
        [projectId, grantId],
      );
      const row = rows[0];
      if (!row) {
        // Ничего не обновилось: либо записи нет (404), либо доступ уже закрыт
        // — повторный отзыв не ошибка и второго события не пишет.
        await this.assertEntryExists(tx, 'lab.project_access_grants', projectId, grantId, 'grant');
        return;
      }

      await this.audit.emit(tx, {
        verb: 'lab.project_access.revoked',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'project',
        subjectId: projectId,
        context: { grantId, granteeUserId: row.grantee_user_id },
        traceId: ctx.traceId,
      });
    });
  }

  /** Исключить человека: доступ закрыт при любом режиме и любом разрешении. */
  async exclude(
    ctx: RequestContext,
    projectId: string,
    input: ExcludeAccessRequest,
  ): Promise<ProjectAccessEntry> {
    const index = await this.crypto.blindIndex(input.email, 'email');
    return this.db.transaction(ctx, async (tx) => {
      await this.projectVisibility(tx, projectId);
      const subject = await this.resolveGrantee(tx, index);
      await this.assertNotTeam(tx, projectId, subject.userId);

      const { rows } = await tx.query<ExclusionRow>(
        `INSERT INTO lab.project_access_exclusions
             (id, project_id, excluded_user_id, created_by, reason)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, excluded_user_id) WHERE revoked_at IS NULL AND excluded_user_id IS NOT NULL
         DO UPDATE SET reason = EXCLUDED.reason, created_by = EXCLUDED.created_by
         RETURNING id, created_at, reason`,
        [uuidv7(), projectId, subject.userId, ctx.userId, input.reason ?? null],
      );
      const row = rows[0]!;

      await this.audit.emit(tx, {
        verb: 'lab.project_access.excluded',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'project',
        subjectId: projectId,
        context: { excludedUserId: subject.userId },
        traceId: ctx.traceId,
      });

      return {
        id: row.id,
        kind: 'exclusion',
        subjectKind: 'user',
        subjectId: subject.userId,
        subjectName: subject.displayName,
        permissions: [],
        createdAt: row.created_at.toISOString(),
        reason: row.reason,
        revokedAt: null,
      };
    });
  }

  /** Снять исключение. Разрешения оно не возвращает: они живут отдельно. */
  async revokeExclusion(
    ctx: RequestContext,
    projectId: string,
    exclusionId: string,
  ): Promise<void> {
    await this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{ excluded_user_id: string | null }>(
        `UPDATE lab.project_access_exclusions
            SET revoked_at = now()
          WHERE id = $2 AND project_id = $1 AND revoked_at IS NULL
          RETURNING excluded_user_id`,
        [projectId, exclusionId],
      );
      const row = rows[0];
      if (!row) {
        await this.assertEntryExists(
          tx,
          'lab.project_access_exclusions',
          projectId,
          exclusionId,
          'exclusion',
        );
        return;
      }

      await this.audit.emit(tx, {
        verb: 'lab.project_access.exclusion_revoked',
        actorId: ctx.userId,
        actorRole: actorRole(ctx),
        subjectType: 'project',
        subjectId: projectId,
        context: { exclusionId, excludedUserId: row.excluded_user_id },
        traceId: ctx.traceId,
      });
    });
  }

  /** Запись есть, но уже отозвана? Тогда повтор — успех, иначе 404. */
  private async assertEntryExists(
    tx: Tx,
    table: 'lab.project_access_grants' | 'lab.project_access_exclusions',
    projectId: string,
    entryId: string,
    subject: string,
  ): Promise<void> {
    const { rows } = await tx.query(`SELECT 1 FROM ${table} WHERE id = $2 AND project_id = $1`, [
      projectId,
      entryId,
    ]);
    if (rows.length === 0) throw errors.notFound({ subject });
  }

  /**
   * Проект виден вызывающему? Читает строку проекта: по RLS её отдают только
   * команде и админу, поэтому посторонний получает 404 и не узнаёт даже о
   * существовании проекта. Заодно возвращает режим — интерфейсу нужно
   * сказать, действуют ли выданные разрешения.
   */
  private async projectVisibility(tx: Tx, projectId: string): Promise<ProjectVisibility> {
    const { rows } = await tx.query<{ visibility: ProjectVisibility }>(
      'SELECT visibility FROM lab.projects WHERE id = $1 AND deleted_at IS NULL',
      [projectId],
    );
    const row = rows[0];
    if (!row) throw errors.notFound({ subject: 'project' });
    return row.visibility;
  }

  /**
   * Адрес → получатель. Отсутствие учётной записи и неактивная запись
   * отвечают одинаково: ответ не должен различать «нет такого адреса» и
   * «адрес есть, но запись неактивна».
   */
  private async resolveGrantee(
    tx: Tx,
    index: Buffer,
  ): Promise<{ userId: string; displayName: string }> {
    const { rows } = await tx.query<{ user_id: string; display_name: string }>(
      'SELECT user_id, display_name FROM lab.resolve_grantee($1)',
      [index],
    );
    const row = rows[0];
    if (!row) {
      // Ошибка у поля, а не 404 на весь запрос: владелец ошибся в адресе, и
      // сказать об этом надо там, где он его вводил.
      throw errors.validation([
        { path: 'email', message: 'Пользователь с таким адресом не найден' },
      ]);
    }
    return { userId: row.user_id, displayName: row.display_name };
  }

  /**
   * Команде проекта разрешение не выдаётся и исключение не ставится: она
   * видит проект целиком по другому правилу предиката, и запись создавала бы
   * ложное впечатление управления её доступом.
   */
  private async assertNotTeam(tx: Tx, projectId: string, userId: string): Promise<void> {
    const { rows } = await tx.query<{ member: boolean }>(
      'SELECT lab.is_project_member($1, $2) AS member',
      [projectId, userId],
    );
    if (rows[0]?.member) {
      throw errors.conflict('Участник команды проекта видит проект и без разрешения', {
        reason: 'grantee-is-team',
      });
    }
  }
}

function actorRole(ctx: RequestContext): string {
  return ctx.roles.includes('admin') ? 'admin' : 'founder';
}

interface EntryRow {
  kind: 'grant' | 'exclusion';
  entry_id: string;
  subject_kind: 'user' | 'entity';
  subject_id: string;
  subject_name: string;
  permissions: string[] | null;
  created_at: Date;
  reason: string | null;
  revoked_at: Date | null;
}

interface GrantRow {
  id: string;
  permissions: string[];
  granted_at: Date;
  reason: string | null;
  revoked_at: Date | null;
}

interface ExclusionRow {
  id: string;
  created_at: Date;
  reason: string | null;
}

function mapEntry(row: EntryRow): ProjectAccessEntry {
  return {
    id: row.entry_id,
    kind: row.kind,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    permissions: (row.permissions ?? []) as GrantPermission[],
    createdAt: row.created_at.toISOString(),
    reason: row.reason,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}
