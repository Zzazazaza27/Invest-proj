import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from '@fifth/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { MailThrottleService } from '../auth/mail-throttle.service';
import { SessionEpochService } from '../auth/session-epoch.service';
import { MailTransport } from '../comms/mail.transport';
import { errors } from '../common/errors';
import { getEnv } from '../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { Database, type RequestContext } from '../db/unit-of-work';
import { ARGON2_OPTIONS } from './identity.service';

/**
 * Восстановление пароля и подтверждение адреса почты.
 *
 * Обоих сценариев в платформе не было: забывший пароль не мог войти никогда, а
 * адрес почты никто не подтверждал. Оба анонимны по построению — у человека
 * нет сессии, он именно поэтому и пришёл, — и это определяет всю конструкцию.
 *
 * ЧТО ЗДЕСЬ ВАЖНО, кроме того, что «работает»:
 *
 *  1. **Ответ не выдаёт, есть ли такой пользователь.** `202 Accepted` уходит
 *     одинаково и на зарегистрированный адрес, и на чужой. Иначе форма «забыли
 *     пароль» становится готовым инструментом перечисления пользователей — она
 *     для этого удобнее формы входа, потому что не требует пароля.
 *  2. **Токен существует только в письме.** В базе — SHA-256 (M060). Чтение
 *     таблицы не даёт войти ни в один аккаунт, и по этой же причине токен не
 *     кладётся в очередь уведомлений: её содержимое читает и сам пользователь,
 *     и роль доставки.
 *  3. **Однократность обеспечивает БД.** Пометка использования и полезное
 *     действие — один UPDATE с условием `used_at IS NULL`. Проверка отдельным
 *     запросом оставляла бы окно, в котором по одной ссылке проходят двое.
 *  4. **Смена пароля гасит все сессии.** Восстановление доступа, после
 *     которого чужая открытая сессия продолжает работать, доступ не
 *     восстанавливает.
 *  5. **Ссылка собирается из конфигурации**, а не из заголовка `Host`:
 *     подменённый заголовок увёл бы ссылку на чужой домен, а письмо выглядело
 *     бы нашим.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly audit: AuditRepository,
    private readonly mail: MailTransport,
    private readonly throttle: MailThrottleService,
    private readonly epochs: SessionEpochService,
  ) {}

  /**
   * «Забыли пароль» — анонимный запрос ссылки.
   *
   * Возвращает `void` намеренно: у вызывающего не должно быть ЧЕГО показать
   * по-разному. Все ветки — нет пользователя, превышен счётчик писем, письмо
   * отправлено — заканчиваются одинаково.
   */
  async requestPasswordReset(ctx: RequestContext, email: string): Promise<void> {
    this.assertMailAvailable();
    const index = this.crypto.blindIndex(email, 'email');
    const indexHex = index.toString('hex');

    // Счётчик крутится ДО поиска пользователя — в том числе для несуществующих
    // адресов. Иначе «есть счётчик / нет счётчика» различало бы адреса.
    const allowed = await this.throttle.allow(indexHex);

    const token = this.newToken();
    const userId = await this.db.asServiceRole('app_auth', ctx, async (tx) => {
      const { rows } = await tx.query<{ user_id: string | null }>(
        'SELECT identity.issue_verification_token($1, $2, $3, $4, $5, $6) AS user_id',
        [
          uuidv7(),
          'password_reset',
          index,
          token.sha256,
          getEnv().PASSWORD_RESET_TTL_SEC,
          this.crypto.contextHash(ctx.traceId),
        ],
      );
      return rows[0]?.user_id ?? null;
    });

    if (!userId || !allowed) {
      // Ни письма, ни ошибки. Причина остаётся во внутреннем логе — снаружи
      // обе ветки неотличимы от успешной.
      this.logger.log({
        msg: 'ссылка на смену пароля не отправлена',
        reason: userId ? 'throttled' : 'no-user',
        traceId: ctx.traceId,
      });
      return;
    }

    await this.mail.send({
      to: email,
      subject: 'Смена пароля — «Пятый элемент»',
      text: this.letter(
        'Вы (или кто-то другой) запросили смену пароля.',
        `${getEnv().PUBLIC_BASE_URL}/login/#reset=${token.value}`,
        getEnv().PASSWORD_RESET_TTL_SEC,
        'Если это были не вы — просто не переходите по ссылке. Пароль не изменится.',
      ),
    });

    await this.record(ctx, userId, 'identity.password.reset_requested');
  }

  /**
   * Смена пароля по ссылке.
   *
   * Хеш пароля считается ДО обращения к базе: argon2 стоит десятки
   * миллисекунд, и держать транзакцию открытой на это время незачем.
   */
  async resetPassword(ctx: RequestContext, token: string, password: string): Promise<void> {
    this.assertMailAvailable();
    const hash = await argon2.hash(password, ARGON2_OPTIONS);
    const sha256 = sha256Of(token);

    const userId = await this.db.asServiceRole('app_auth', ctx, async (tx) => {
      const { rows } = await tx.query<{ user_id: string | null }>(
        'SELECT identity.reset_password_with_token($1, $2) AS user_id',
        [sha256, hash],
      );
      return rows[0]?.user_id ?? null;
    });

    // Просроченная, использованная и несуществующая ссылка отвечают одинаково:
    // различие подсказывало бы подбирающему, что он близко.
    if (!userId) throw errors.validation([{ path: 'token', message: 'ссылка недействительна' }]);

    // Рубеж сессий сдвинут внутри функции БД, но в процессе он ещё закеширован:
    // без сброса кеша старая сессия проживёт до конца окна кеша.
    this.epochs.forget(userId);
    await this.record(ctx, userId, 'identity.password.reset_completed');
  }

  /**
   * Запрос подтверждения адреса — путь с открытой сессией.
   *
   * Адрес берётся из профиля, а не из тела запроса: иначе подтверждённым
   * оказался бы адрес, который человек ввёл в форму, а не тот, что записан у
   * него в аккаунте.
   */
  async requestEmailVerification(ctx: RequestContext): Promise<{ expiresAt: string }> {
    this.assertMailAvailable();
    const email = await this.ownEmail(ctx);
    const allowed = await this.throttle.allow(
      this.crypto.blindIndex(email, 'email').toString('hex'),
    );
    if (!allowed) {
      // Здесь человек аутентифицирован и просит письмо себе: отказ ничего не
      // выдаёт и честнее молчания, потому что письма он ждёт.
      throw errors.limitExceeded('Слишком много писем подтверждения. Попробуйте позже');
    }

    const token = this.newToken();
    const ttl = getEnv().EMAIL_VERIFY_TTL_SEC;
    await this.db.transaction(ctx, async (tx) => {
      await tx.query('SELECT identity.issue_email_verification_token($1, $2, $3, $4)', [
        uuidv7(),
        token.sha256,
        ttl,
        this.crypto.contextHash(ctx.traceId),
      ]);
      await this.audit.emit(tx, {
        verb: 'identity.email.verification_sent',
        actorId: ctx.userId,
        actorRole: 'system',
        subjectType: 'user',
        subjectId: ctx.userId,
        context: { ttlSeconds: ttl },
        traceId: ctx.traceId,
      });
    });

    await this.mail.send({
      to: email,
      subject: 'Подтверждение адреса — «Пятый элемент»',
      text: this.letter(
        'Подтвердите адрес почты, указанный в вашем аккаунте.',
        `${getEnv().PUBLIC_BASE_URL}/login/#verify=${token.value}`,
        ttl,
        'Пока адрес не подтверждён, часть уведомлений платформа отправлять не будет.',
      ),
    });

    return { expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  /** Переход по ссылке подтверждения. Сессия не нужна: письмо могли открыть в другом браузере. */
  async confirmEmail(ctx: RequestContext, token: string): Promise<void> {
    const sha256 = sha256Of(token);
    const userId = await this.db.asServiceRole('app_auth', ctx, async (tx) => {
      const { rows } = await tx.query<{ user_id: string | null }>(
        'SELECT identity.confirm_email_with_token($1, $2) AS user_id',
        [sha256, uuidv7()],
      );
      return rows[0]?.user_id ?? null;
    });
    if (!userId) throw errors.validation([{ path: 'token', message: 'ссылка недействительна' }]);
    await this.record(ctx, userId, 'identity.email.verified');
  }

  /** Состояние подтверждения для интерфейса: подтверждён ли адрес и есть ли живая ссылка. */
  async emailStatus(
    ctx: RequestContext,
  ): Promise<{ verified: boolean; pendingUntil: string | null; mailAvailable: boolean }> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows: identities } = await tx.query<{ verified_at: Date | null }>(
        `SELECT verified_at FROM identity.auth_identities
          WHERE user_id = $1 AND provider = 'email'
          ORDER BY verified_at DESC NULLS LAST LIMIT 1`,
        [ctx.userId],
      );
      const { rows: pending } = await tx.query<{ expires_at: Date }>(
        `SELECT expires_at FROM identity.verification_tokens
          WHERE user_id = $1 AND purpose = 'email_verify'
            AND used_at IS NULL AND expires_at > now()
          ORDER BY expires_at DESC LIMIT 1`,
        [ctx.userId],
      );
      return {
        verified: Boolean(identities[0]?.verified_at),
        pendingUntil: pending[0] ? pending[0].expires_at.toISOString() : null,
        mailAvailable: this.mail.available,
      };
    });
  }

  // ------------------------------------------------------------------ детали

  private assertMailAvailable(): void {
    // Обещать письмо, которого не будет, хуже, чем сказать, что канал не
    // подключён. Проверка стоит ДО работы с базой: без транспорта весь
    // сценарий бессмыслен, и незачем оставлять в базе живой токен.
    if (!this.mail.available) throw errors.featureDisabled('mail');
  }

  /**
   * Токен: 32 случайных байта в base64url и его SHA-256.
   *
   * Соль не нужна — это не пароль: 256 бит случайности не перебираются, а
   * словаря, по которому строится радужная таблица, здесь не существует.
   */
  private newToken(): { value: string; sha256: Buffer } {
    const value = randomBytes(32).toString('base64url');
    return { value, sha256: sha256Of(value) };
  }

  private async ownEmail(ctx: RequestContext): Promise<string> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{
        email_ciphertext: Buffer | null;
        contact_wrapped_dek: Buffer | null;
      }>(
        `SELECT email_ciphertext, contact_wrapped_dek
           FROM identity.users WHERE id = $1 AND deleted_at IS NULL`,
        [ctx.userId],
      );
      const user = rows[0];
      if (!user?.email_ciphertext || !user.contact_wrapped_dek) {
        throw errors.validation([{ path: 'email', message: 'в аккаунте не указан адрес почты' }]);
      }
      return this.crypto
        .openField('passport_sensitive', user.contact_wrapped_dek, user.email_ciphertext, 'email')
        .toString('utf8');
    });
  }

  private letter(reason: string, link: string, ttlSeconds: number, footer: string): string {
    const minutes = Math.round(ttlSeconds / 60);
    const validity = minutes >= 60 ? `${Math.round(minutes / 60)} ч` : `${minutes} мин`;
    return [
      reason,
      '',
      link,
      '',
      `Ссылка действует ${validity} и срабатывает один раз.`,
      footer,
    ].join('\n');
  }

  /**
   * Событие в журнал.
   *
   * Актор — сам пользователь, роль актора — `system`: действие инициировал он,
   * но подтверждения личности у нас на этот момент нет, ссылку мог открыть
   * кто угодно. Та же форма, что у `identity.login.failed` (M055).
   *
   * Неудача записи не отменяет уже совершённое действие: пароль сменён, и
   * ронять ответ из-за журнала значило бы оставить человека в неведении о том,
   * что его пароль всё-таки изменился.
   */
  private async record(ctx: RequestContext, userId: string, verb: string): Promise<void> {
    try {
      await this.db.transaction({ ...ctx, userId: null, roles: [] }, async (tx) => {
        await this.audit.emit(tx, {
          verb,
          actorId: userId,
          actorRole: 'system',
          subjectType: 'user',
          subjectId: userId,
          context: {},
          traceId: ctx.traceId,
        });
      });
    } catch (error) {
      this.logger.warn({
        msg: 'не удалось записать событие подтверждения',
        verb,
        error,
      });
    }
  }
}

function sha256Of(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
