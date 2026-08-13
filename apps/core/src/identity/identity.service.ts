import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import {
  REQUIRED_CONSENT_KINDS,
  uuidv7,
  type AuthSession,
  type CurrentUser,
  type RegisterRequest,
  type Role,
} from '@unicorn/contracts';
import { randomBytes } from 'node:crypto';
import { errors } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext } from '../db/unit-of-work';
import { getEnv } from '../config/env';
import { issueCsrfToken } from '../auth/csrf';
import { TokenRevocationService } from '../auth/token-revocation.service';
import { LoginThrottleService } from '../auth/login-throttle.service';

/**
 * Роли, от имени которых разрешено писать глагол `identity.token.revoked`
 * (перечень задан в M038). Список нужен здесь, чтобы не отправлять в журнал
 * роль, которую реестр глаголов отвергнет ошибкой прав уже внутри транзакции.
 */
const AUDITABLE_ACTOR_ROLES = new Set(['founder', 'investor', 'expert', 'organizer', 'admin']);

/**
 * Регистрация, вход и согласия.
 *
 * Ключевой инвариант фазы: аккаунт становится активным ТОЛЬКО при наличии
 * акцептов актуальных версий четырёх документов, включая тарифы и условия
 * вознаграждения оператора (Architect_Launch §4.1, §5.4). Проверка выполняется
 * в одной транзакции и продублирована триггером БД — сервисный слой не
 * является единственной защитой.
 */

/**
 * Параметры Argon2id. OWASP-минимум: 19 МБ памяти, 2 итерации, параллелизм 1.
 * Память здесь важнее итераций: она делает атаку на GPU дорогой.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * Фиктивный хеш для выравнивания времени ответа при несуществующем аккаунте.
 * Без него разница во времени между «нет пользователя» и «неверный пароль»
 * превращает форму входа в перечислитель адресов.
 *
 * Считается один раз на старте от случайного значения: литерал в исходниках
 * и выглядит как утёкший секрет, и делает поведение предсказуемым.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash(randomBytes(32).toString('hex'), ARGON2_OPTIONS);
  return dummyHashPromise;
}

/**
 * Нарушение уникальности ИМЕННО по контакту.
 *
 * Проверяется имя ограничения, а не только код `23505`: под тот же код
 * попадают и другие уникальные индексы, и превращать их все в «контакт занят»
 * значило бы прятать чужие дефекты за понятным текстом.
 */
function isContactUniqueViolation(error: unknown): boolean {
  const pg = error as { code?: string; constraint?: string };
  return (
    pg?.code === '23505' &&
    (pg.constraint === 'users_email_hmac_uq' || pg.constraint === 'users_phone_hmac_uq')
  );
}

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly audit: AuditRepository,
    private readonly revocations: TokenRevocationService,
    private readonly loginThrottle: LoginThrottleService,
  ) {}

  /**
   * Событие неудачного входа в журнал.
   *
   * Пишется отдельной транзакцией и не роняет ответ: отказ входа не должен
   * зависеть от доступности журнала. Контакт не сохраняется — только префикс
   * отпечатка blind-индекса, по которому попытки одного аккаунта связываются
   * между собой без раскрытия самого контакта.
   */
  private async recordLoginFailure(
    ctx: RequestContext,
    userId: string | null,
    indexHex: string,
  ): Promise<void> {
    try {
      await this.db.transaction(ctx, async (tx) => {
        await this.audit.emit(tx, {
          verb: 'identity.login.failed',
          actorId: userId,
          actorRole: 'system',
          subjectType: 'user',
          subjectId: userId,
          context: { contactFingerprint: indexHex.slice(0, 16) },
          traceId: ctx.traceId,
        });
      });
    } catch (error) {
      this.logger.warn({
        msg: 'не удалось записать событие неудачного входа',
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  async register(
    input: RegisterRequest,
    ctx: RequestContext,
  ): Promise<{ userId: string; roles: Role[] }> {
    const env = getEnv();
    const userId = uuidv7();
    const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);

    const emailIndex = input.email ? this.crypto.blindIndex(input.email, 'email') : null;
    const phoneIndex = input.phone ? this.crypto.blindIndex(input.phone, 'phone') : null;
    // Оба контакта шифруются ОДНИМ DEK: в схеме на строку приходится один
    // contact_wrapped_dek. Пустой контакт остаётся NULL — этого требует
    // CHECK ((phone_ciphertext IS NULL) = (phone_hmac IS NULL)).
    const contact = this.crypto.sealMany('passport_sensitive', {
      email: input.email ?? null,
      phone: input.phone ?? null,
    });

    return this.db.transaction(ctx, async (tx) => {
      // Занятость контакта проверяется до вставки, чтобы вернуть внятную
      // ошибку. UNIQUE-индекс по blind index закрывает ГОНКУ — но только от
      // появления дубликата: ответ при этом был 500, пока его не перевели в
      // доменный отказ ниже.
      if (emailIndex) await this.assertContactFree(tx, 'email_hmac', emailIndex);
      if (phoneIndex) await this.assertContactFree(tx, 'phone_hmac', phoneIndex);

      try {
        await tx.query(
          `INSERT INTO identity.users
             (id, email_ciphertext, phone_ciphertext, contact_wrapped_dek, email_hmac, phone_hmac,
              password_hash, display_name, primary_role, status, locale)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_consents', $10)`,
          [
            userId,
            contact.ciphertexts.email,
            contact.ciphertexts.phone,
            contact.wrappedDek,
            emailIndex,
            phoneIndex,
            passwordHash,
            input.displayName,
            input.role,
            input.locale,
          ],
        );
      } catch (error) {
        // Проверка занятости выше и сама вставка — разные моменты времени:
        // между ними другая транзакция успевает зарегистрировать тот же
        // контакт. Дубликата не возникает — его не пускает UNIQUE-индекс, — но
        // до этого исправления наружу уходил 500 «внутренняя ошибка» вместо
        // доменного отказа. Воспроизведено четырьмя одновременными
        // регистрациями с одинаковым адресом.
        //
        // Текст отказа ТОТ ЖЕ, что у предпроверки: две разные формулировки для
        // одного и того же исхода отличали бы гонку от обычной занятости и
        // помогали бы перечислять пользователей.
        if (isContactUniqueViolation(error)) {
          throw errors.conflict('Регистрация с указанными данными невозможна', {
            reason: 'contact-taken-race',
          });
        }
        throw error;
      }
      await tx.query('INSERT INTO identity.user_roles (user_id, role) VALUES ($1, $2)', [
        userId,
        input.role,
      ]);

      // Контекст сессии выставлен на анонима, поэтому политика «акцепт только
      // за себя» не пропустит вставку. Переключаем контекст в рамках той же
      // транзакции на созданного пользователя.
      await tx.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      await tx.query('SELECT set_config($1, $2, true)', ['app.current_roles', input.role]);

      await this.storeConsents(tx, userId, input.consents, ctx);
      await this.activateIfComplete(tx, userId, input.locale);

      await this.audit.emit(tx, {
        verb: 'identity.user.registered',
        actorId: userId,
        actorRole: 'system',
        subjectType: 'user',
        subjectId: userId,
        context: { role: input.role, locale: input.locale },
        traceId: ctx.traceId,
      });

      void env;
      return { userId, roles: [input.role as Role] };
    });
  }

  /**
   * Проверка пароля. Возвращает id пользователя либо бросает
   * `unauthenticated` — одну и ту же ошибку и при отсутствии аккаунта, и при
   * неверном пароле.
   */
  async verifyPassword(
    contact: { email?: string; phone?: string },
    password: string,
    ctx: RequestContext,
  ): Promise<{ userId: string; roles: Role[]; status: string }> {
    const index = contact.email
      ? this.crypto.blindIndex(contact.email, 'email')
      : contact.phone
        ? this.crypto.blindIndex(contact.phone, 'phone')
        : null;
    if (!index) throw errors.unauthenticated({ stage: 'no-contact' });

    // Счётчик неудач ПО АККАУНТУ проверяется до argon2: распределённый перебор
    // не обходится сменой адреса, а отклонённая попытка не стоит нам хеширования
    // (MEDIUM внешнего аудита №2). Ключ — hex blind-индекса: значение контакта
    // в счётчик не попадает.
    const throttleKey = index.toString('hex');
    await this.loginThrottle.assertNotLocked(throttleKey);

    const found = await this.db.readOnly(ctx, async (tx) => {
      // Обычный SELECT здесь не сработает: политика users_select требует
      // сессионного контекста, а при входе пользователь как раз доказывает,
      // кто он. Используется узкая SECURITY DEFINER-функция, возвращающая
      // только id, хеш пароля и статус (миграция M012).
      const { rows } = await tx.query<{
        user_id: string;
        password_hash: string | null;
        status: string;
      }>('SELECT * FROM identity.find_login_candidate($1, $2)', [
        contact.email ? index : null,
        contact.email ? null : index,
      ]);
      return rows[0] ?? null;
    });

    // Хеш проверяется всегда, даже когда пользователя нет: иначе время ответа
    // выдаёт факт существования аккаунта.
    const hash = found?.password_hash ?? (await getDummyHash());
    const ok = await argon2.verify(hash, password).catch(() => false);
    if (!found || !ok) {
      // Счётчик растёт и для НЕсуществующего контакта: иначе разница в
      // поведении («залочен» против «нет такого») стала бы оракулом
      // существования учётки.
      await this.loginThrottle.recordFailure(throttleKey);
      // Неудачный вход попадает в журнал: без этого события ни расследование,
      // ни алерт на перебор невозможны. Контакт не пишется — только отпечаток.
      await this.recordLoginFailure(ctx, found?.user_id ?? null, throttleKey);
      throw errors.unauthenticated({ stage: 'bad-credentials' });
    }
    if (found.status === 'suspended' || found.status === 'deleted') {
      throw errors.forbidden({ stage: 'account-status', status: found.status });
    }
    // Успех обнуляет счётчик: иначе пользователь, вспомнивший пароль с
    // девятой попытки, оставался бы под порогом до конца окна.
    await this.loginThrottle.reset(throttleKey);

    const roles = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ role: Role }>(
        'SELECT role FROM identity.get_active_roles($1)',
        [found.user_id],
      );
      return rows.map((r) => r.role);
    });

    return { userId: found.user_id, roles, status: found.status };
  }

  async getCurrentUser(ctx: RequestContext): Promise<CurrentUser> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        display_name: string;
        primary_role: Role;
        status: string;
        locale: string;
        mfa_enabled: boolean;
        created_at: Date;
        email_ciphertext: Buffer | null;
        phone_ciphertext: Buffer | null;
        contact_wrapped_dek: Buffer | null;
      }>(
        `SELECT id, display_name, primary_role, status, locale, mfa_enabled, created_at,
                email_ciphertext, phone_ciphertext, contact_wrapped_dek
           FROM identity.users WHERE id = $1 AND deleted_at IS NULL`,
        [ctx.userId],
      );
      const user = rows[0];
      if (!user) throw errors.notFound({ subject: 'user' });

      const roleRows = await tx.query<{ role: Role }>(
        'SELECT role FROM identity.user_roles WHERE user_id = $1 AND revoked_at IS NULL',
        [ctx.userId],
      );

      // Наружу уходят только маски: полный контакт не покидает сервер даже
      // владельцу — он его и так знает, а лишняя копия в ответе увеличивает
      // цену утечки логов и кешей.
      let emailMasked: string | null = null;
      let phoneMasked: string | null = null;
      const dek = user.contact_wrapped_dek;
      if (dek && user.email_ciphertext) {
        emailMasked = maskEmail(
          this.crypto
            .openField('passport_sensitive', dek, user.email_ciphertext, 'email')
            .toString('utf8'),
        );
      }
      if (dek && user.phone_ciphertext) {
        phoneMasked = maskPhone(
          this.crypto
            .openField('passport_sensitive', dek, user.phone_ciphertext, 'phone')
            .toString('utf8'),
        );
      }

      return {
        id: user.id,
        displayName: user.display_name,
        primaryRole: user.primary_role,
        roles: roleRows.rows.map((r) => r.role),
        status: user.status as CurrentUser['status'],
        locale: user.locale as CurrentUser['locale'],
        mfaEnabled: user.mfa_enabled,
        emailMasked,
        phoneMasked,
        createdAt: user.created_at.toISOString(),
      };
    });
  }

  /** Акцепт новых версий документов (ре-акцепт при смене условий). */
  async acceptConsents(
    ctx: RequestContext,
    consents: { kind: string; version: string; locale: string }[],
  ): Promise<void> {
    await this.db.transaction(ctx, async (tx) => {
      await this.storeConsents(tx, ctx.userId!, consents, ctx);
      await this.activateIfComplete(tx, ctx.userId!, consents[0]?.locale ?? 'ru-RU');
    });
  }

  /** Список акцептов, которых не хватает до активации. */
  async missingConsents(ctx: RequestContext, locale = 'ru-RU'): Promise<string[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ kind: string }>(
        `SELECT t.kind
           FROM identity.consent_templates t
          WHERE t.superseded_at IS NULL
            AND t.locale = $2
            AND t.kind = ANY($3::text[])
            AND NOT EXISTS (
              SELECT 1 FROM identity.consents c
               WHERE c.user_id = $1 AND c.kind = t.kind
                 AND c.version = t.version AND c.locale = t.locale
                 AND c.revoked_at IS NULL)`,
        [ctx.userId, locale, [...REQUIRED_CONSENT_KINDS]],
      );
      return rows.map((r) => r.kind);
    });
  }

  /**
   * Отозвать ОДИН токен — тот, которым сделан этот запрос.
   *
   * Выход раньше удалял только cookie у клиента; сам токен оставался
   * действительным до `exp`, и скопированное значение продолжало работать. Здесь
   * идентификатор токена попадает в реестр отзыва (M038), и с этого момента он
   * не проходит на входе. Остальные сессии пользователя не затрагиваются — в
   * этом вся разница с рубежом сессий.
   *
   * Возвращает `false`, если отзывать нечего: у токена нет идентификатора
   * (внешний IdP без claim `jti`). Врать про успешный отзыв в этом случае
   * нельзя — вызывающий обязан знать, что сессия закрыта только на клиенте.
   */
  async revokeCurrentToken(
    ctx: RequestContext,
    token: { tokenId: string | null; expiresAt: number },
  ): Promise<boolean> {
    if (!token.tokenId || !ctx.userId) return false;

    await this.db.transaction(ctx, async (tx) => {
      await this.revocations.revoke(tx, {
        tokenId: token.tokenId!,
        userId: ctx.userId!,
        expiresAt: new Date(token.expiresAt),
        reason: 'logout',
        revokedBy: ctx.userId,
      });

      // Журнал ведётся глаголом с явным перечнем ролей актора. Если роли в
      // токене нет ни одной из известных, событие не пишется: фальшивая роль
      // актора в журнале хуже её отсутствия, а сам факт отзыва остаётся в
      // реестре с отметкой времени и инициатором.
      const actorRole = ctx.roles.find((role) => AUDITABLE_ACTOR_ROLES.has(role));
      if (actorRole) {
        await this.audit.emit(tx, {
          verb: 'identity.token.revoked',
          actorId: ctx.userId,
          actorRole,
          subjectType: 'user',
          subjectId: ctx.userId,
          // Идентификатор токена в журнал не пишется: он попадает в выгрузки и
          // связывает записи журнала с конкретной сессией. Реестр отзыва и так
          // хранит его вместе с отметкой времени.
          context: { reason: 'logout' },
          traceId: ctx.traceId,
        });
      }
    });
    // Только после фиксации: на этом экземпляре токен перестаёт действовать
    // немедленно, на остальных — в пределах окна снимка реестра.
    this.revocations.markRevokedLocally(token.tokenId);
    return true;
  }

  buildSession(input: {
    userId: string;
    roles: Role[];
    status: string;
    reacceptRequired: boolean;
    mfaEnabled: boolean;
  }): { session: AuthSession; csrfToken: string } {
    const env = getEnv();
    // Токен связан с владельцем сессии подписью: чужая подставленная cookie
    // больше не образует согласованную пару с заголовком (SEC-12).
    const csrfToken = issueCsrfToken(input.userId);
    return {
      csrfToken,
      session: {
        userId: input.userId,
        roles: input.roles,
        status: input.status as AuthSession['status'],
        csrfToken,
        expiresAt: new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000).toISOString(),
        reacceptRequired: input.reacceptRequired,
        mfaEnabled: input.mfaEnabled,
      },
    };
  }

  // ------------------------------------------------------------------ private

  private async assertContactFree(
    tx: import('../db/unit-of-work').Tx,
    column: 'email_hmac' | 'phone_hmac',
    index: Buffer,
  ): Promise<void> {
    const { rows } = await tx.query(
      `SELECT 1 FROM identity.users WHERE ${column} = $1 AND deleted_at IS NULL LIMIT 1`,
      [index],
    );
    if (rows.length > 0) {
      // Формулировка намеренно нейтральна: подтверждать занятость конкретного
      // адреса — значит помогать перечислять пользователей.
      throw errors.conflict('Регистрация с указанными данными невозможна', {
        reason: 'contact-taken',
      });
    }
  }

  private async storeConsents(
    tx: import('../db/unit-of-work').Tx,
    userId: string,
    consents: { kind: string; version: string; locale: string }[],
    ctx: RequestContext,
  ): Promise<void> {
    // Хеш ИДЕНТИФИКАТОРА ЗАПРОСА, а не адреса. Раньше то же самое значение
    // писалось в колонку `ip_hash`, и запись о согласии выглядела как
    // доказательство канала, которым она не является (SEC-16, M043).
    const traceHash = this.crypto.contextHash(ctx.traceId);
    for (const consent of consents) {
      await tx.query(
        `INSERT INTO identity.consents (id, user_id, kind, version, locale, request_trace_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, kind, version) DO NOTHING`,
        [uuidv7(), userId, consent.kind, consent.version, consent.locale, traceHash],
      );
    }
  }

  /**
   * Перевод в `active` только при полном наборе акцептов.
   * Функция БД — тот же источник правды, что и триггер: расхождения быть не может.
   */
  private async activateIfComplete(
    tx: import('../db/unit-of-work').Tx,
    userId: string,
    locale: string,
  ): Promise<void> {
    const { rows } = await tx.query<{ complete: boolean }>(
      'SELECT identity.has_required_consents($1, $2) AS complete',
      [userId, locale],
    );
    if (!rows[0]?.complete) return;
    await tx.query(
      `UPDATE identity.users SET status = 'active', updated_at = now()
        WHERE id = $1 AND status = 'pending_consents'`,
      [userId],
    );
  }
}

function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${'*'.repeat(Math.max(1, name.length - visible.length))}@${domain}`;
}

function maskPhone(phone: string): string {
  return phone.length <= 4
    ? '*'.repeat(phone.length)
    : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}
