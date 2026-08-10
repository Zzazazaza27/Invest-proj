import { Injectable } from '@nestjs/common';
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

@Injectable()
export class IdentityService {
  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly audit: AuditRepository,
  ) {}

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
      // ошибку; гонку закрывает UNIQUE-индекс по blind index.
      if (emailIndex) await this.assertContactFree(tx, 'email_hmac', emailIndex);
      if (phoneIndex) await this.assertContactFree(tx, 'phone_hmac', phoneIndex);

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
    if (!found || !ok) throw errors.unauthenticated({ stage: 'bad-credentials' });
    if (found.status === 'suspended' || found.status === 'deleted') {
      throw errors.forbidden({ stage: 'account-status', status: found.status });
    }

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

  buildSession(input: {
    userId: string;
    roles: Role[];
    status: string;
    reacceptRequired: boolean;
    mfaEnabled: boolean;
  }): { session: AuthSession; csrfToken: string } {
    const env = getEnv();
    const csrfToken = randomBytes(32).toString('base64url');
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
    const ipHash = this.crypto.contextHash(ctx.traceId);
    for (const consent of consents) {
      await tx.query(
        `INSERT INTO identity.consents (id, user_id, kind, version, locale, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, kind, version) DO NOTHING`,
        [uuidv7(), userId, consent.kind, consent.version, consent.locale, ipHash],
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
