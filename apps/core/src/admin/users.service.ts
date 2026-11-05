import { Injectable } from '@nestjs/common';
import type {
  AdminUserCard,
  AdminUserContacts,
  AdminUserKycStatus,
  AdminUserListQuery,
  AdminUserPage,
  AdminUserRow,
} from '@fifth/contracts';
import { AdminUserListQuerySchema, PROBE_ORIGINS } from '@fifth/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { isKmsUnavailable, CryptoService } from '../crypto/crypto.service';
import { errors } from '../common/errors';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { SessionEpochService } from '../auth/session-epoch.service';
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
    private readonly epochs: SessionEpochService,
  ) {}

  async list(ctx: RequestContext, rawQuery: AdminUserListQuery): Promise<AdminUserPage> {
    const query = AdminUserListQuerySchema.parse(rawQuery);
    const search = await this.searchCondition(query.field, query.q);
    // Поиск по несуществующему идентификатору — пустая страница, а не ошибка:
    // человек ищет, а не утверждает, что такой аккаунт есть.
    if (search === null) {
      return { items: [], total: 0, page: query.page, perPage: query.perPage };
    }

    const order = ORDER_BY[query.sort];
    const direction = query.dir === 'asc' ? 'ASC' : 'DESC';
    const offset = (query.page - 1) * query.perPage;

    const found = await this.db.readOnly(ctx, async (tx) => {
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
                u.origin,
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
            -- Происхождение (M127): по умолчанию следы прогонов скрыты, иначе
            -- список рассказывает не о людях, а о проверках.
            AND ($7::text IS NULL
                 OR ($7 = 'probes' AND u.origin = ANY($8::text[]))
                 OR ($7 = 'real' AND NOT (u.origin = ANY($8::text[]))))
          ORDER BY ${order} ${direction}, u.id ${direction}
          LIMIT $5 OFFSET $6`,
        [
          search.param,
          query.role ?? null,
          query.status ?? null,
          query.kyc ?? null,
          query.perPage,
          offset,
          query.origin === 'all' ? null : query.origin,
          [...PROBE_ORIGINS],
        ],
      );

      return { rows, withContacts };
    });

    // После транзакции: соединение с БД не ждёт службу ключей на каждой строке страницы.
    const { rows, withContacts } = found;
    return {
      items: await Promise.all(rows.map((row) => this.toRow(row, withContacts))),
      total: rows.length > 0 ? Number(rows[0]!.total) : 0,
      page: query.page,
      perPage: query.perPage,
    };
  }

  async card(ctx: RequestContext, userId: string): Promise<AdminUserCard> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<CardRow>(
        `SELECT u.id, u.display_name, u.primary_role, u.status, u.locale, u.service_country,
                u.currency_pref, u.home_contour, u.mfa_enabled, u.created_at, u.updated_at,
                u.sessions_valid_from, u.origin, u.email_ciphertext, u.phone_ciphertext,
                u.contact_wrapped_dek, u.status_reason, u.status_changed_at,
                u.status_changed_by, c.display_name AS status_changed_by_name
           FROM identity.users u
           LEFT JOIN identity.users c ON c.id = u.status_changed_by
          WHERE u.id = $1 AND u.deleted_at IS NULL`,
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

      const masks = await this.masks(user);
      return {
        id: user.id,
        displayName: user.display_name,
        avatarUrl: null,
        emailMasked: masks.email,
        phoneMasked: masks.phone,
        primaryRole: user.primary_role,
        origin: user.origin as AdminUserCard['origin'],
        roles: roles.rows.map((row) => ({
          role: row.role,
          grantedAt: row.granted_at.toISOString(),
          revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
        })),
        status: user.status as AdminUserCard['status'],
        statusReason: user.status_reason,
        statusChangedAt: user.status_changed_at ? user.status_changed_at.toISOString() : null,
        statusChangedBy: user.status_changed_by,
        statusChangedByName: user.status_changed_by_name,
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

      const { email, phone } = await this.open(user);

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

  /**
   * Заблокировать или разблокировать учётную запись.
   *
   * Четыре правила, и каждое стоит на сервере, а не на спрятанной кнопке:
   *
   *  1. **Не себе.** Администратор, запирающий сам себя, теряет доступ к
   *     платформе, и вернуть его можно только из базы.
   *  2. **Не последнему администратору.** Снять роль у последнего нельзя с
   *     M024; блокировка — обходной путь к тому же результату, и он закрыт
   *     тем же способом, включая блокировку от одновременных операций.
   *  3. **Блокировка закрывает уже выданные сессии.** Статус проверяется при
   *     входе, но живой токен о нём не знает: без сдвига рубежа (M035)
   *     заблокированный работал бы до истечения токена.
   *  4. **Возврат — в положенное состояние, а не в `active`.** Без акцептов
   *     актуальных документов человек возвращается в `pending_consents`:
   *     иначе блокировка и разблокировка стали бы способом активировать
   *     аккаунт в обход инварианта.
   */
  async changeStatus(
    ctx: RequestContext,
    userId: string,
    input: { action: 'suspend' | 'restore'; reason: string },
  ): Promise<AdminUserCard> {
    if (userId === ctx.userId && input.action === 'suspend') {
      throw errors.forbidden({ stage: 'self-suspend' });
    }

    await this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{ status: string; locale: string }>(
        `SELECT status, locale FROM identity.users
          WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [userId],
      );
      const user = rows[0];
      if (!user) throw errors.notFound({ subject: 'user' });

      if (input.action === 'suspend') {
        if (user.status === 'suspended') {
          throw errors.conflict('Учётная запись уже заблокирована');
        }
        await assertNotLastAdmin(tx, userId);
        await tx.query(
          `UPDATE identity.users
              SET status = 'suspended', status_reason = $2,
                  status_changed_at = now(), status_changed_by = $3, updated_at = now()
            WHERE id = $1`,
          [userId, input.reason, ctx.userId],
        );
      } else {
        if (user.status !== 'suspended') {
          throw errors.conflict('Учётная запись не заблокирована');
        }
        const { rows: consents } = await tx.query<{ ok: boolean }>(
          `SELECT identity.has_required_consents($1, $2) AS ok`,
          [userId, user.locale],
        );
        const restored = consents[0]?.ok === true ? 'active' : 'pending_consents';
        await tx.query(
          `UPDATE identity.users
              SET status = $2, status_reason = $3,
                  status_changed_at = now(), status_changed_by = $4, updated_at = now()
            WHERE id = $1`,
          [userId, restored, input.reason, ctx.userId],
        );
      }

      // Блокировка обязана закрыть живые сессии. Разблокировка тоже сдвигает
      // рубеж: у заблокированного действующих токенов остаться не должно, а
      // если он их сохранил, пусть входит заново — это дешевле, чем гадать.
      await this.epochs.invalidate(tx, userId);

      await this.audit.record(tx, {
        verb: input.action === 'suspend' ? 'identity.user.suspended' : 'identity.user.restored',
        actorId: ctx.userId,
        actorRole: 'admin',
        aggregateType: 'user',
        aggregateId: userId,
        aggregateVersion: await nextStatusVersion(tx, userId),
        payload: { reason: input.reason },
        traceId: ctx.traceId,
      });
    });

    return this.card(ctx, userId);
  }

  /**
   * Изменить обычное профильное поле.
   *
   * «Обычное» здесь — то, что человек и так о себе сообщил сам:
   * отображаемое имя. Проверенных данных личности, контактов и статусов KYC
   * этот путь не касается — у них свои процессы, и универсального редактора
   * полей пользователя здесь нет намеренно.
   */
  async updateProfile(
    ctx: RequestContext,
    userId: string,
    input: { displayName: string },
  ): Promise<AdminUserCard> {
    await this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE identity.users SET display_name = $2, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [userId, input.displayName],
      );
      if (rowCount === 0) throw errors.notFound({ subject: 'user' });

      await this.audit.emit(tx, {
        verb: 'identity.user.profile_updated',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'user',
        subjectId: userId,
        // Что изменено — да; на что — нет: имя тоже персональные данные, а
        // журнал не должен становиться их вторым хранилищем.
        context: { field: 'displayName' },
        traceId: ctx.traceId,
      });
    });

    return this.card(ctx, userId);
  }

  /** Условие поиска и его параметр. `null` — заведомо пустая выборка. */
  private async searchCondition(
    field: AdminUserListQuery['field'],
    rawQuery: string | undefined,
  ): Promise<{ sql: string; param: string | Buffer | null } | null> {
    const q = (rawQuery ?? '').trim();
    if (q === '') return { sql: '($1::text IS NULL OR TRUE)', param: null };

    switch (field) {
      case 'email':
        // Точное совпадение по слепому индексу: адрес зашифрован, и поиска по
        // части значения у этой модели не существует в принципе.
        return { sql: 'u.email_hmac = $1::bytea', param: await this.crypto.blindIndex(q, 'email') };
      case 'phone':
        return { sql: 'u.phone_hmac = $1::bytea', param: await this.crypto.blindIndex(q, 'phone') };
      case 'id':
        return UUID_RE.test(q) ? { sql: 'u.id = $1::uuid', param: q } : null;
      case 'name':
      default:
        // Экранирование обязательно: иначе `%` из поля ввода означает «все»,
        // а `_` — «любой символ», и человек получает не то, что набрал.
        return { sql: `u.display_name ILIKE $1 ESCAPE '!'`, param: `%${escapeLike(q)}%` };
    }
  }

  private async toRow(row: ListRow, withContacts: boolean): Promise<AdminUserRow> {
    const masks = withContacts ? await this.masks(row) : { email: null, phone: null };
    return {
      id: row.id,
      displayName: row.display_name,
      avatarUrl: null,
      emailMasked: masks.email,
      phoneMasked: masks.phone,
      roles: row.roles ?? [],
      status: row.status as AdminUserRow['status'],
      kycStatus: (row.kyc_status ?? 'none') as AdminUserKycStatus,
      origin: row.origin as AdminUserRow['origin'],
      createdAt: row.created_at.toISOString(),
    };
  }

  private async open(row: ContactRow): Promise<{ email: string | null; phone: string | null }> {
    if (!row.contact_wrapped_dek) return { email: null, phone: null };
    const opened = await this.crypto.openFields('passport_sensitive', row.contact_wrapped_dek, {
      email: row.email_ciphertext,
      phone: row.phone_ciphertext,
    });
    return {
      email: opened.email?.toString('utf8') ?? null,
      phone: opened.phone?.toString('utf8') ?? null,
    };
  }

  /**
   * Маска контакта.
   *
   * Расшифровка обёрнута намеренно: одна испорченная строка (ключ сменился,
   * данные перенесены наполовину) не должна ронять весь список — оператор
   * останется без рабочего экрана из-за одного аккаунта. Отсутствие маски
   * читается как «контакта нет», и это честнее пятисотой ошибки.
   *
   * Отказ службы ключей — другое дело: контакт цел, и показывать его отсутствие
   * было бы неправдой, поэтому такая ошибка проходит наверх.
   */
  private async masks(row: ContactRow): Promise<{ email: string | null; phone: string | null }> {
    try {
      const { email, phone } = await this.open(row);
      return {
        email: email === null ? null : maskEmail(email),
        phone: phone === null ? null : maskPhone(phone),
      };
    } catch (error) {
      if (isKmsUnavailable(error)) throw error;
      return { email: null, phone: null };
    }
  }
}

const CONTACTS_CAPABILITY = 'identity.user_contacts.view';

/**
 * Последний действующий администратор не блокируется.
 *
 * Та же защита, что у снятия роли (M024), и по той же причине: без неё
 * управление правами теряется безвозвратно и возвращается только доступом к
 * базе.
 *
 * Отдельно про то, КОГДА эта проверка вообще срабатывает — иначе она выглядит
 * недостижимой. Поодиночке её закрывает запрет «не себе»: действующий
 * администратор активен, значит вместе с целью их всегда двое. Живой случай
 * ровно один и он гонка: два администратора одновременно блокируют друг
 * друга. Без блокировки оба видят «нас двое», оба проходят — и платформа
 * остаётся без администраторов. Advisory-лок выстраивает их в очередь, и
 * второй получает отказ.
 */
async function assertNotLastAdmin(tx: Tx, userId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['identity.admin_roles']);
  const { rows } = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM identity.user_roles r
       JOIN identity.users u ON u.id = r.user_id
      WHERE r.role = 'admin' AND r.revoked_at IS NULL
        AND u.deleted_at IS NULL AND u.status <> 'suspended'`,
  );
  const { rows: target } = await tx.query<{ is_admin: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM identity.user_roles
        WHERE user_id = $1 AND role = 'admin' AND revoked_at IS NULL) AS is_admin`,
    [userId],
  );
  if (target[0]?.is_admin === true && Number(rows[0]!.count) <= 1) {
    throw errors.conflict('Нельзя заблокировать последнего действующего администратора платформы');
  }
}

/** Версия агрегата состояния — по числу уже записанных изменений. */
async function nextStatusVersion(tx: Tx, userId: string): Promise<number> {
  const { rows } = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit.outbox_events
      WHERE aggregate_type = 'user' AND aggregate_id = $1
        AND event_type IN ('identity.user.suspended', 'identity.user.restored')`,
    [userId],
  );
  return Number(rows[0]!.count) + 1;
}

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
  origin: string;
  total: string;
}

interface CardRow extends ContactRow {
  id: string;
  display_name: string;
  primary_role: string;
  origin: string;
  status: string;
  locale: string;
  service_country: string | null;
  currency_pref: string;
  home_contour: string;
  mfa_enabled: boolean;
  created_at: Date;
  updated_at: Date;
  sessions_valid_from: Date;
  status_reason: string | null;
  status_changed_at: Date | null;
  status_changed_by: string | null;
  status_changed_by_name: string | null;
}
