import { Injectable } from '@nestjs/common';
import type {
  AdminUserCard,
  AdminUserContacts,
  AdminUserKycStatus,
  AdminUserListQuery,
  AdminUserPage,
  AdminUserRow,
} from '@unicorn/contracts';
import { AdminUserListQuerySchema } from '@unicorn/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { CryptoService } from '../crypto/crypto.service';
import { errors } from '../common/errors';
import { Database, type RequestContext } from '../db/unit-of-work';
import { maskEmail, maskPhone } from '../identity/identity.service';

/**
 * Раздел «Пользователи» административного кабинета: чтение.
 *
 * Отделён от `DirectoryService` намеренно, хотя оба ходят в одну таблицу.
 * Справочник отвечает на вопрос «подскажи идентификатор, я выдаю роль» и
 * живёт внутри экрана «Доступ»; здесь — рабочий список и карточка человека, у
 * которых другой состав полей, другие права и другая цена ошибки.
 *
 * Три правила, которые в этом файле важнее удобства:
 *
 *  1. **Контакт по умолчанию — маска.** Расшифровка стоит обращения к KEK и
 *     кладёт персональные данные в ответ; для списка это не нужно никогда, а
 *     для карточки — только по явному действию под полномочием.
 *  2. **Фильтры и сортировка — в SQL.** Отбор на стороне клиента означал бы,
 *     что «не найдено» показывается там, где найденное просто не попало на
 *     загруженную страницу.
 *  3. **Порядок сортировки — белый список.** Столбец приходит перечислением
 *     контракта и подставляется по таблице соответствий, а не строкой из
 *     запроса: подстановка имени столбца в SQL — это инъекция, даже если
 *     сегодня её прикрывает валидация на входе.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly audit: AuditRepository,
  ) {}

  async list(ctx: RequestContext, rawQuery: AdminUserListQuery): Promise<AdminUserPage> {
    const query = AdminUserListQuerySchema.parse(rawQuery);
    const search = this.searchCondition(query.field, query.q);
    // Поиск по несуществующему идентификатору — пустая страница, а не ошибка:
    // человек ищет, а не утверждает, что такой аккаунт есть.
    if (search === null) {
      return { items: [], total: 0, page: query.page, perPage: query.perPage };
    }

    const order = ORDER_BY[query.sort];
    const direction = query.dir === 'asc' ? 'ASC' : 'DESC';
    const offset = (query.page - 1) * query.perPage;

    return this.db.readOnly(ctx, async (tx) => {
      // Маски контактов — тоже персональные данные, пусть и урезанные.
      // Показываем их тому же, кому разрешено раскрытие: администратору
      // (полномочие пропускает его по правилу M097) и тому, кому полномочие
      // выдано. Организатор без полномочия видит список без контактов —
      // ровно столько, сколько он видел до появления этого экрана.
      const { rows: allowed } = await tx.query<{ allowed: boolean }>(
        `SELECT app.has_capability($1) AS allowed`,
        [CONTACTS_CAPABILITY],
      );
      const withContacts = allowed[0]?.allowed === true;

      const { rows } = await tx.query<ListRow>(
        `SELECT u.id, u.display_name, u.status, u.created_at,
                u.email_ciphertext, u.phone_ciphertext, u.contact_wrapped_dek,
                (SELECT array_agg(r.role ORDER BY r.role)
                   FROM identity.user_roles r
                  WHERE r.user_id = u.id AND r.revoked_at IS NULL) AS roles,
                (SELECT v.status FROM kyc.kyc_verifications v
                  WHERE v.user_id = u.id AND v.kind = 'identity'
                  ORDER BY v.created_at DESC LIMIT 1) AS kyc_status,
                count(*) OVER () AS total
           FROM identity.users u
          WHERE u.deleted_at IS NULL
            AND ${search.sql}
            AND ($2::text IS NULL OR EXISTS (
                  SELECT 1 FROM identity.user_roles r2
                   WHERE r2.user_id = u.id AND r2.role = $2 AND r2.revoked_at IS NULL))
            AND ($3::text IS NULL OR u.status = $3)
            AND ($4::text IS NULL OR coalesce((
                  SELECT v2.status FROM kyc.kyc_verifications v2
                   WHERE v2.user_id = u.id AND v2.kind = 'identity'
                   ORDER BY v2.created_at DESC LIMIT 1), 'none') = $4)
          ORDER BY ${order} ${direction}, u.id ${direction}
          LIMIT $5 OFFSET $6`,
        [
          search.param,
          query.role ?? null,
          query.status ?? null,
          query.kyc ?? null,
          query.perPage,
          offset,
        ],
      );

      return {
        items: rows.map((row) => this.toRow(row, withContacts)),
        total: rows.length > 0 ? Number(rows[0]!.total) : 0,
        page: query.page,
        perPage: query.perPage,
      };
    });
  }

  async card(ctx: RequestContext, userId: string): Promise<AdminUserCard> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<CardRow>(
        `SELECT id, display_name, primary_role, status, locale, service_country,
                currency_pref, home_contour, mfa_enabled, created_at, updated_at,
                sessions_valid_from, email_ciphertext, phone_ciphertext, contact_wrapped_dek
           FROM identity.users
          WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      const user = rows[0];
      if (!user) throw errors.notFound({ subject: 'user' });

      const roles = await tx.query<{ role: string; granted_at: Date; revoked_at: Date | null }>(
        `SELECT role, granted_at, revoked_at FROM identity.user_roles
          WHERE user_id = $1 ORDER BY granted_at DESC`,
        [userId],
      );

      const kyc = await tx.query<{
        id: string;
        kind: string;
        status: string;
        provider: string | null;
        rejection_reason: string | null;
        decided_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id, kind, status, provider, rejection_reason, decided_at, created_at
           FROM kyc.kyc_verifications
          WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [userId],
      );

      const projects = await tx.query<{
        id: string;
        title: string;
        role: string;
        listing_status: string;
      }>(
        `SELECT p.id, p.title, fp.role, p.listing_status
           FROM lab.founders_projects fp
           JOIN lab.projects p ON p.id = fp.project_id AND p.deleted_at IS NULL
          WHERE fp.user_id = $1
          ORDER BY p.created_at DESC LIMIT 50`,
        [userId],
      );

      const entities = await tx.query<{
        id: string;
        legal_name: string;
        jurisdiction: string;
        registry_status: string;
      }>(
        `SELECT id, legal_name, jurisdiction, registry_status
           FROM kyc.business_entities
          WHERE owner_user_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 50`,
        [userId],
      );

      const capabilities = await tx.query<{
        capability: string;
        title: string;
        reason: string;
        granted_at: Date;
      }>(
        `SELECT g.capability, c.title, g.reason, g.granted_at
           FROM identity.staff_capability_grants g
           JOIN identity.staff_capabilities c ON c.code = g.capability
          WHERE g.user_id = $1 AND g.revoked_at IS NULL
          ORDER BY g.granted_at DESC`,
        [userId],
      );

      const assignments = await tx.query<{
        id: string;
        project_id: string;
        project_title: string;
        purpose: string;
        status: string;
        access_revoked_at: Date | null;
      }>(
        `SELECT a.id, a.project_id, p.title AS project_title, a.purpose, a.status,
                a.access_revoked_at
           FROM experts.expert_assignments a
           JOIN lab.projects p ON p.id = a.project_id
          WHERE a.expert_id = $1
          ORDER BY a.created_at DESC LIMIT 50`,
        [userId],
      );

      const tickets = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM comms.support_tickets WHERE user_id = $1`,
        [userId],
      );

      // История: события, где этот человек — предмет действия. Полный
      // `context_jsonb` наружу не отдаётся (см. HISTORY_CONTEXT_VERBS).
      const history = await tx.query<{
        ts: Date;
        verb: string;
        actor_id: string | null;
        actor_name: string | null;
        context_jsonb: Record<string, unknown>;
      }>(
        `SELECT e.ts, e.verb, e.actor_id, a.display_name AS actor_name, e.context_jsonb
           FROM audit.events e
           LEFT JOIN identity.users a ON a.id = e.actor_id
          WHERE e.subject_type = 'user' AND e.subject_id = $1
          ORDER BY e.ts DESC LIMIT 30`,
        [userId],
      );

      const { rows: allowed } = await tx.query<{ allowed: boolean }>(
        `SELECT app.has_capability($1) AS allowed`,
        [CONTACTS_CAPABILITY],
      );

      return {
        id: user.id,
        displayName: user.display_name,
        avatarUrl: null,
        emailMasked: this.mask(user, 'email'),
        phoneMasked: this.mask(user, 'phone'),
        primaryRole: user.primary_role,
        roles: roles.rows.map((row) => ({
          role: row.role,
          grantedAt: row.granted_at.toISOString(),
          revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
        })),
        status: user.status as AdminUserCard['status'],
        locale: user.locale,
        serviceCountry: user.service_country,
        currencyPref: user.currency_pref,
        homeContour: user.home_contour,
        mfaEnabled: user.mfa_enabled,
        createdAt: user.created_at.toISOString(),
        updatedAt: user.updated_at.toISOString(),
        sessionsValidFrom: user.sessions_valid_from.toISOString(),
        kyc: kyc.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          status: row.status,
          provider: row.provider,
          rejectionReason: row.rejection_reason,
          decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
          createdAt: row.created_at.toISOString(),
        })),
        projects: projects.rows.map((row) => ({
          id: row.id,
          title: row.title,
          role: row.role,
          listingStatus: row.listing_status,
        })),
        entities: entities.rows.map((row) => ({
          id: row.id,
          legalName: row.legal_name,
          jurisdiction: row.jurisdiction,
          registryStatus: row.registry_status,
        })),
        capabilities: capabilities.rows.map((row) => ({
          capability: row.capability,
          title: row.title,
          reason: row.reason,
          grantedAt: row.granted_at.toISOString(),
        })),
        assignments: assignments.rows.map((row) => ({
          id: row.id,
          projectId: row.project_id,
          projectTitle: row.project_title,
          purpose: row.purpose,
          status: row.status,
          accessRevokedAt: row.access_revoked_at ? row.access_revoked_at.toISOString() : null,
        })),
        supportTickets: Number(tickets.rows[0]?.count ?? '0'),
        history: history.rows.map((row) => ({
          ts: row.ts.toISOString(),
          verb: row.verb,
          actorId: row.actor_id,
          actorName: row.actor_name,
          context: HISTORY_CONTEXT_VERBS.has(row.verb) ? safeContext(row.context_jsonb) : null,
        })),
        canRevealContacts: allowed[0]?.allowed === true,
      };
    });
  }

  /**
   * Показать контакт целиком.
   *
   * Отдельная операция, а не поле карточки, по двум причинам. Первая —
   * полномочие: карточку видит администратор, контакты — тот, кому раскрытие
   * разрешено. Вторая — журнал: раскрытие персональных данных должно оставлять
   * след, и след этот привязан к действию человека, а не к открытию экрана.
   */
  async revealContacts(ctx: RequestContext, userId: string): Promise<AdminUserContacts> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows: allowed } = await tx.query<{ allowed: boolean }>(
        `SELECT app.has_capability($1) AS allowed`,
        [CONTACTS_CAPABILITY],
      );
      if (allowed[0]?.allowed !== true) {
        throw errors.forbidden({ capability: CONTACTS_CAPABILITY });
      }

      const { rows } = await tx.query<ContactRow>(
        `SELECT email_ciphertext, phone_ciphertext, contact_wrapped_dek
           FROM identity.users WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      const user = rows[0];
      if (!user) throw errors.notFound({ subject: 'user' });

      const email = this.open(user, 'email');
      const phone = this.open(user, 'phone');

      await this.audit.emit(tx, {
        verb: 'identity.user_contacts.revealed',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'user',
        subjectId: userId,
        // В журнал уходит ФАКТ раскрытия и что именно было раскрыто, но не
        // сами значения: журнал не должен становиться вторым хранилищем ПДн.
        context: { email: email !== null, phone: phone !== null },
        traceId: ctx.traceId,
      });

      return { email, phone };
    });
  }

  /** Условие поиска и его параметр. `null` — заведомо пустая выборка. */
  private searchCondition(
    field: AdminUserListQuery['field'],
    rawQuery: string | undefined,
  ): { sql: string; param: string | Buffer | null } | null {
    const q = (rawQuery ?? '').trim();
    if (q === '') return { sql: '($1::text IS NULL OR TRUE)', param: null };

    switch (field) {
      case 'email':
        // Точное совпадение по слепому индексу: адрес зашифрован, и поиска по
        // части значения у этой модели не существует в принципе.
        return { sql: 'u.email_hmac = $1::bytea', param: this.crypto.blindIndex(q, 'email') };
      case 'phone':
        return { sql: 'u.phone_hmac = $1::bytea', param: this.crypto.blindIndex(q, 'phone') };
      case 'id':
        return UUID_RE.test(q) ? { sql: 'u.id = $1::uuid', param: q } : null;
      case 'name':
      default:
        // Экранирование обязательно: иначе `%` из поля ввода означает «все»,
        // а `_` — «любой символ», и человек получает не то, что набрал.
        return { sql: `u.display_name ILIKE $1 ESCAPE '!'`, param: `%${escapeLike(q)}%` };
    }
  }

  private toRow(row: ListRow, withContacts: boolean): AdminUserRow {
    return {
      id: row.id,
      displayName: row.display_name,
      avatarUrl: null,
      emailMasked: withContacts ? this.mask(row, 'email') : null,
      phoneMasked: withContacts ? this.mask(row, 'phone') : null,
      roles: row.roles ?? [],
      status: row.status as AdminUserRow['status'],
      kycStatus: (row.kyc_status ?? 'none') as AdminUserKycStatus,
      createdAt: row.created_at.toISOString(),
    };
  }

  private open(row: ContactRow, field: 'email' | 'phone'): string | null {
    const ciphertext = field === 'email' ? row.email_ciphertext : row.phone_ciphertext;
    if (!row.contact_wrapped_dek || !ciphertext) return null;
    return this.crypto
      .openField('passport_sensitive', row.contact_wrapped_dek, ciphertext, field)
      .toString('utf8');
  }

  /**
   * Маска контакта.
   *
   * Расшифровка обёрнута намеренно: одна испорченная строка (ключ сменился,
   * данные перенесены наполовину) не должна ронять весь список — оператор
   * останется без рабочего экрана из-за одного аккаунта. Отсутствие маски
   * читается как «контакта нет», и это честнее пятисотой ошибки.
   */
  private mask(row: ContactRow, field: 'email' | 'phone'): string | null {
    try {
      const value = this.open(row, field);
      if (value === null) return null;
      return field === 'email' ? maskEmail(value) : maskPhone(value);
    } catch {
      return null;
    }
  }
}

const CONTACTS_CAPABILITY = 'identity.user_contacts.view';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Соответствие «столбец контракта → выражение SQL».
 *
 * Именно таблица, а не подстановка строки: перечисление на входе можно
 * когда-нибудь расширить неосторожно, а список здесь виден целиком.
 */
const ORDER_BY: Record<string, string> = {
  created_at: 'u.created_at',
  display_name: 'lower(u.display_name)',
  status: 'u.status',
};

/**
 * События, у которых состав контекста известен платформе и безопасен для
 * показа: их пишет сама платформа, и в них лежат причина и роль, а не
 * произвольные данные.
 */
const HISTORY_CONTEXT_VERBS = new Set([
  'identity.role.granted',
  'identity.role.revoked',
  'identity.user.suspended',
  'identity.user.restored',
  'identity.user.profile_updated',
  'identity.user_contacts.revealed',
]);

/** Ключи контекста, которые вообще показываются. Остальное отбрасывается. */
const HISTORY_CONTEXT_KEYS = new Set(['role', 'reason', 'field', 'email', 'phone', 'by']);

function safeContext(context: Record<string, unknown>): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context ?? {})) {
    if (HISTORY_CONTEXT_KEYS.has(key)) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** `!` как экранирующий символ: обратный слэш в SQL-строках читается хуже. */
function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (char) => `!${char}`);
}

interface ContactRow {
  email_ciphertext: Buffer | null;
  phone_ciphertext: Buffer | null;
  contact_wrapped_dek: Buffer | null;
}

interface ListRow extends ContactRow {
  id: string;
  display_name: string;
  status: string;
  created_at: Date;
  roles: string[] | null;
  kyc_status: string | null;
  total: string;
}

interface CardRow extends ContactRow {
  id: string;
  display_name: string;
  primary_role: string;
  status: string;
  locale: string;
  service_country: string | null;
  currency_pref: string;
  home_contour: string;
  mfa_enabled: boolean;
  created_at: Date;
  updated_at: Date;
  sessions_valid_from: Date;
}
