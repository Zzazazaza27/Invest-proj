import { Injectable, Logger } from '@nestjs/common';
import argon2 from 'argon2';
import sharp from 'sharp';
import {
  AVATAR_LIMITS,
  AVATAR_VARIANTS,
  type AvatarSize,
  type ChangePassword,
  type MediaUploadTicket,
  type MyProfile,
} from '@fifth/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { sha256Hex } from '../audit/deletion-record';
import { SessionEpochService } from '../auth/session-epoch.service';
import { LoginThrottleService } from '../auth/login-throttle.service';
import { errors } from '../common/errors';
import { getEnv } from '../config/env';
import { isKmsUnavailable, CryptoService } from '../crypto/crypto.service';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { S3Service, putObject } from '../storage/s3.service';
import { ARGON2_OPTIONS, maskEmail, maskPhone } from './identity.service';

/**
 * «Мой профиль»: то, чем человек распоряжается сам.
 *
 * До этой фазы изменить о себе было нельзя ничего: имя задавалось при
 * регистрации навсегда, аватара не существовало, пароль менялся только по
 * ссылке из письма «забыли пароль» — то есть человек с живой сессией, знающий
 * свой пароль, поменять его не мог.
 *
 * Границы, которые здесь соблюдаются:
 *
 *  * **Подтверждённое не переписывается обычной формой.** Контакты и данные
 *    личности отсюда только читаются (и то масками): у них свои процессы, и
 *    «редактор любого поля профиля» обесценил бы проверку.
 *  * **Смена пароля прекращает все сессии.** Включая текущую. Это не
 *    небрежность: единственный честный способ ответить на вопрос «а если
 *    пароль меняют, потому что чужой уже вошёл».
 *  * **Изображение не берётся на веру.** Тот же конвейер, что у изображений
 *    проекта: разбор формата, пределы по пикселям и байтам, пересборка
 *    вариантов (и вместе с ней — потеря EXIF, включая координаты съёмки).
 */
@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly audit: AuditRepository,
    private readonly epochs: SessionEpochService,
    private readonly throttle: LoginThrottleService,
    private readonly s3: S3Service,
  ) {
    sharp.concurrency(MAX_CONCURRENCY);
    sharp.cache(false);
  }

  async me(ctx: RequestContext): Promise<MyProfile> {
    return this.db.readOnly(ctx, async (tx) => this.read(tx, ctx.userId!));
  }

  async updateName(ctx: RequestContext, displayName: string): Promise<MyProfile> {
    await this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE identity.users SET display_name = $2, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL AND display_name IS DISTINCT FROM $2`,
        [ctx.userId, displayName],
      );
      if (rowCount === 0) {
        // То же имя — не изменение (2.6, пакет 8): без события. Нет пользователя — отказ.
        const { rows } = await tx.query(
          `SELECT 1 FROM identity.users WHERE id = $1 AND deleted_at IS NULL`,
          [ctx.userId],
        );
        if (rows.length === 0) throw errors.notFound({ subject: 'user' });
        return;
      }

      await this.audit.emit(tx, {
        verb: 'identity.user.profile_updated',
        actorId: ctx.userId,
        actorRole: primaryRoleOf(ctx),
        subjectType: 'user',
        subjectId: ctx.userId,
        // Поле — да, значение — нет: имя тоже персональные данные.
        context: { field: 'displayName' },
        traceId: ctx.traceId,
      });
    });
    return this.me(ctx);
  }

  /**
   * Смена пароля из открытой сессии.
   *
   * Порядок операций здесь — половина защиты:
   *
   *  1. счётчик неудач проверяется ДО argon2, иначе подбор текущего пароля
   *     оплачивается процессором сервера, а не атакующего;
   *  2. проверяется знание ТЕКУЩЕГО пароля — захваченная вкладка не должна
   *     давать возможность запереть владельца снаружи;
   *  3. новый хеш и сдвиг рубежа сессий пишутся ОДНОЙ транзакцией: иначе
   *     между ними существует окно, в котором пароль уже новый, а старые
   *     сессии ещё живы.
   */
  async changePassword(ctx: RequestContext, input: ChangePassword): Promise<void> {
    if (getEnv().AUTH_MODE !== 'local') {
      // Пароля у платформы в этом контуре нет вовсе — им распоряжается
      // внешний поставщик входа (ADR-003). Маршрут отвечает как отсутствующий.
      throw errors.notFound({ subject: 'route', reason: 'oidc-mode' });
    }
    if (input.newPassword === input.currentPassword) {
      throw errors.validation([
        { path: 'newPassword', message: 'новый пароль совпадает с текущим' },
      ]);
    }

    const userId = ctx.userId!;
    // Ключ счётчика — по учётной записи, а не по контакту: здесь мы уже знаем,
    // кто пришёл, и перебор идёт против конкретного аккаунта.
    const throttleKey = `chg:${userId}`;
    await this.throttle.assertNotLocked(throttleKey);

    const hash = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ password_hash: string | null }>(
        `SELECT password_hash FROM identity.users WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      if (rows.length === 0) throw errors.notFound({ subject: 'user' });
      return rows[0]!.password_hash;
    });

    if (!hash) {
      // Вход по внешнему поставщику: менять нечего, и делать вид, что пароль
      // «не подошёл», было бы враньём.
      throw errors.stateTransition('У этой учётной записи нет пароля платформы');
    }

    const ok = await argon2.verify(hash, input.currentPassword);
    if (!ok) {
      await this.throttle.recordFailure(throttleKey);
      throw errors.validation([{ path: 'currentPassword', message: 'текущий пароль неверен' }]);
    }

    const next = await argon2.hash(input.newPassword, ARGON2_OPTIONS);

    await this.db.transaction(ctx, async (tx) => {
      await tx.query(
        `UPDATE identity.users SET password_hash = $2, updated_at = now() WHERE id = $1`,
        [userId, next],
      );
      // Все ранее выданные токены недействительны — в том числе текущий.
      await this.epochs.invalidate(tx, userId);
      await this.audit.emit(tx, {
        verb: 'identity.password.changed',
        actorId: userId,
        actorRole: primaryRoleOf(ctx),
        subjectType: 'user',
        subjectId: userId,
        context: {},
        traceId: ctx.traceId,
      });
    });

    await this.throttle.reset(throttleKey);
  }

  // -------------------------------------------------------------------- аватар

  async requestAvatarUpload(
    ctx: RequestContext,
    input: { contentType: string; sizeBytes: number },
  ): Promise<MediaUploadTicket> {
    if (!this.s3.isConfigured) throw errors.featureDisabled('avatar_upload');
    if (input.sizeBytes > AVATAR_LIMITS.maxBytes) {
      throw errors.validation([
        {
          path: 'sizeBytes',
          message: `Аватар: не больше ${Math.round(AVATAR_LIMITS.maxBytes / (1024 * 1024))} МБ`,
        },
      ]);
    }
    const form = this.s3.presignUpload({
      key: uploadKey(ctx.userId!),
      contentType: input.contentType,
      maxBytes: AVATAR_LIMITS.maxBytes,
    });
    return {
      uploadUrl: form.url,
      method: 'POST',
      formFields: form.fields,
      maxSizeBytes: AVATAR_LIMITS.maxBytes,
      expiresAt: form.expiresAt.toISOString(),
    };
  }

  /**
   * Разобрать загруженное и собрать размеры.
   *
   * Сначала проверка, потом запись: негодный файл удаляется из хранилища, а
   * не остаётся «на всякий случай» — однажды кто-нибудь такой мусор раздаст.
   */
  async finalizeAvatar(ctx: RequestContext): Promise<MyProfile> {
    if (!this.s3.isConfigured) throw errors.featureDisabled('avatar_upload');
    const userId = ctx.userId!;
    const key = uploadKey(userId);
    const object = await this.s3.getObject(key);
    if (!object) {
      throw errors.stateTransition('Файл не загружен: сначала отправьте изображение');
    }
    if (object.body.byteLength > AVATAR_LIMITS.maxBytes) {
      await this.s3.deleteObject(key).catch(() => undefined);
      throw errors.validation([{ path: 'file', message: 'Файл больше допустимого размера' }]);
    }

    let meta: sharp.Metadata;
    let normalized: { data: Buffer; info: sharp.OutputInfo };
    try {
      meta = await sharp(object.body, SHARP_INPUT).metadata();
      // Поворот по EXIF применяется сразу: дальше и проверки, и обрезка идут
      // по тому изображению, которое человек видит.
      normalized = await sharp(object.body, SHARP_INPUT)
        .rotate()
        .toBuffer({ resolveWithObject: true });
    } catch {
      await this.s3.deleteObject(key).catch(() => undefined);
      throw errors.validation([{ path: 'file', message: 'Это не изображение или файл повреждён' }]);
    }

    const mime = MIME_BY_FORMAT[meta.format ?? ''];
    if (!mime) {
      await this.s3.deleteObject(key).catch(() => undefined);
      throw errors.validation([{ path: 'file', message: 'Подходят только JPEG, PNG и WebP' }]);
    }
    const width = normalized.info.width;
    const height = normalized.info.height;
    if (width < AVATAR_LIMITS.minWidth || height < AVATAR_LIMITS.minHeight) {
      await this.s3.deleteObject(key).catch(() => undefined);
      throw errors.validation([
        {
          path: 'file',
          message: `Слишком маленькое изображение: нужно не меньше ${AVATAR_LIMITS.minWidth}×${AVATAR_LIMITS.minHeight} точек`,
        },
      ]);
    }
    if (width > MAX_SIDE || height > MAX_SIDE) {
      await this.s3.deleteObject(key).catch(() => undefined);
      throw errors.validation([
        { path: 'file', message: `Слишком большое изображение: сторона до ${MAX_SIDE} точек` },
      ]);
    }

    const stamp = Date.now().toString(36);
    const variants: Record<string, { key: string; width: number; height: number }> = {};
    // SHA-256 вариантов — для учёта удалений (2.1.5); в строку не пишется.
    const variantSha: Record<string, string> = {};
    for (const [size, box] of Object.entries(AVATAR_VARIANTS) as [
      AvatarSize,
      { width: number; height: number },
    ][]) {
      const buffer = await sharp(normalized.data, SHARP_INPUT)
        // Аватар квадратный, и обрезка идёт по центру: точки фокуса здесь
        // нет намеренно — лишний шаг ради портрета не окупается.
        .resize({ width: box.width, height: box.height, fit: 'cover', position: 'centre' })
        .webp({ quality: 82 })
        .toBuffer();
      const variantKey = variantObjectKey(userId, stamp, size);
      await putObject({ key: variantKey, body: buffer, contentType: 'image/webp' });
      variants[size] = { key: variantKey, width: box.width, height: box.height };
      variantSha[size] = sha256Hex(buffer);
    }

    const masterKey = masterObjectKey(userId, stamp);
    await putObject({ key: masterKey, body: object.body, contentType: mime });

    await this.db.transaction(ctx, async (tx) => {
      // Прежний аватар — для учёта замены (2.1.5).
      const previous = await this.readAvatarRow(tx, userId);
      await tx.query(
        `INSERT INTO identity.user_avatars
           (user_id, master_key, variants, mime, bytes, width, height, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, now())
         ON CONFLICT (user_id) DO UPDATE
           SET master_key = EXCLUDED.master_key,
               variants = EXCLUDED.variants,
               mime = EXCLUDED.mime,
               bytes = EXCLUDED.bytes,
               width = EXCLUDED.width,
               height = EXCLUDED.height,
               updated_at = now()`,
        [userId, masterKey, JSON.stringify(variants), mime, object.body.byteLength, width, height],
      );
      await this.audit.emit(tx, {
        verb: 'identity.avatar.set',
        actorId: userId,
        actorRole: primaryRoleOf(ctx),
        subjectType: 'user',
        subjectId: userId,
        // Учёт удалений (2.1.5): что теперь в профиле и какой файл заменён.
        context: {
          mime,
          width,
          height,
          bytes: object.body.byteLength,
          masterKey,
          masterSha256: sha256Hex(object.body),
          variants: Object.fromEntries(
            Object.entries(variants).map(([size, v]) => [size, { ...v, sha256: variantSha[size] }]),
          ),
          replacedMasterKey: previous?.master_key ?? null,
          basis: 'owner',
        },
        traceId: ctx.traceId,
      });
    });

    // Профиль читается после записи, а исходник удаляется последним: сбой на любом шаге оставляет
    // возможность повторить завершение с тем же файлом.
    const profile = await this.me(ctx);
    await this.s3.deleteObject(key).catch(() => undefined);

    // Прежние объекты НЕ удаляются физически (блок 7, 2.1-W07): файл, уже
    // попавший в комплект резервной копии, должен остаться и в хранилище.
    // Очистка неиспользуемых объектов — отдельной процедурой по 3.3.
    return profile;
  }

  async removeAvatar(ctx: RequestContext): Promise<MyProfile> {
    const userId = ctx.userId!;
    await this.db.transaction(ctx, async (tx) => {
      const existing = await this.readAvatarRow(tx, userId);
      if (!existing) return;
      await tx.query(`DELETE FROM identity.user_avatars WHERE user_id = $1`, [userId]);
      await this.audit.emit(tx, {
        verb: 'identity.avatar.removed',
        actorId: userId,
        actorRole: primaryRoleOf(ctx),
        subjectType: 'user',
        subjectId: userId,
        // Учёт удалений (2.1.5): какой файл убран.
        context: { masterKey: existing.master_key, basis: 'owner' },
        traceId: ctx.traceId,
      });
    });
    return this.me(ctx);
  }

  /**
   * Байты аватара.
   *
   * Маршрут требует аутентификации: аватар видно там, где видно человека, но
   * перебирать картинки по идентификаторам снаружи незачем. Политика чтения в
   * БД проверяет то же самое.
   */
  async avatarBytes(
    ctx: RequestContext,
    userId: string,
    size: AvatarSize,
  ): Promise<{ body: Buffer; contentType: string }> {
    const row = await this.db.readOnly(ctx, async (tx) => this.readAvatarRow(tx, userId));
    const variant = row?.variants?.[size];
    if (!variant) throw errors.notFound({ subject: 'avatar' });
    const object = await this.s3.getObject(variant.key);
    if (!object) {
      this.logger.error({ msg: 'вариант аватара потерян', userId, size });
      throw errors.notFound({ subject: 'avatar' });
    }
    return { body: object.body, contentType: 'image/webp' };
  }

  // ------------------------------------------------------------------ helpers

  private async read(tx: Tx, userId: string): Promise<MyProfile> {
    const { rows } = await tx.query<ProfileRow>(
      `SELECT u.id, u.display_name, u.primary_role, u.status, u.locale, u.service_country,
              u.created_at, u.password_hash IS NOT NULL AS has_password,
              u.email_ciphertext, u.phone_ciphertext, u.contact_wrapped_dek,
              a.updated_at AS avatar_updated_at, a.variants AS avatar_variants
         FROM identity.users u
         LEFT JOIN identity.user_avatars a ON a.user_id = u.id
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId],
    );
    const user = rows[0];
    if (!user) throw errors.notFound({ subject: 'user' });

    const roleRows = await tx.query<{ role: string }>(
      `SELECT role FROM identity.user_roles WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );

    const masks = await this.masks(user);
    return {
      id: user.id,
      displayName: user.display_name,
      // Адреса — маршруты ядра, а не ключи хранилища: бакет приватный, и
      // знание ключа доступа не даёт.
      avatar: user.avatar_updated_at
        ? {
            urls: { sm: avatarUrl(userId, 'sm'), md: avatarUrl(userId, 'md') },
            updatedAt: user.avatar_updated_at.toISOString(),
          }
        : null,
      emailMasked: masks.email,
      phoneMasked: masks.phone,
      contactsAvailable: masks.available,
      roles: roleRows.rows.map((row) => row.role),
      primaryRole: user.primary_role,
      status: user.status as MyProfile['status'],
      locale: user.locale,
      serviceCountry: user.service_country,
      createdAt: user.created_at.toISOString(),
      // Форма смены пароля показывается там, где пароль вообще существует:
      // в контуре с внешним поставщиком входа её быть не должно.
      passwordChangeAvailable: getEnv().AUTH_MODE === 'local' && user.has_password,
    };
  }

  private async readAvatarRow(tx: Tx, userId: string): Promise<AvatarRow | null> {
    const { rows } = await tx.query<AvatarRow>(
      `SELECT user_id, master_key, variants FROM identity.user_avatars WHERE user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /**
   * Маски для собственного профиля. Отказ службы ключей не мешает правке имени и аватара: контакты
   * просто помечаются недоступными, а не показываются отсутствующими.
   */
  private async masks(
    row: ProfileRow,
  ): Promise<{ email: string | null; phone: string | null; available: boolean }> {
    if (!row.contact_wrapped_dek) return { email: null, phone: null, available: true };
    try {
      const opened = await this.crypto.openFields('passport_sensitive', row.contact_wrapped_dek, {
        email: row.email_ciphertext,
        phone: row.phone_ciphertext,
      });
      return {
        email: opened.email ? maskEmail(opened.email.toString('utf8')) : null,
        phone: opened.phone ? maskPhone(opened.phone.toString('utf8')) : null,
        available: true,
      };
    } catch (error) {
      // Порченая строка не ломает кабинет.
      return { email: null, phone: null, available: !isKmsUnavailable(error) };
    }
  }
}

/**
 * Роль актора для журнала.
 *
 * Реестр событий требует допустимую роль, а у человека их может быть
 * несколько. Берём первую из объявленных в реестре — она есть у каждого
 * пользователя платформы.
 */
function primaryRoleOf(ctx: RequestContext): string {
  return ctx.roles?.[0] ?? 'founder';
}

function avatarUrl(userId: string, size: AvatarSize): string {
  return `/v1/users/${userId}/avatar/${size}`;
}

function uploadKey(userId: string): string {
  return `users/${userId}/avatar/upload`;
}
function masterObjectKey(userId: string, stamp: string): string {
  return `users/${userId}/avatar/${stamp}/master`;
}
function variantObjectKey(userId: string, stamp: string, size: AvatarSize): string {
  return `users/${userId}/avatar/${stamp}/${size}.webp`;
}

/** Пределы разбора: вход выбирали не мы. */
const MAX_SIDE = 6000;
const MAX_CONCURRENCY = 2;
const SHARP_INPUT: sharp.SharpOptions = {
  limitInputPixels: 60_000_000,
  animated: false,
  sequentialRead: true,
};

const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

interface ProfileRow {
  id: string;
  display_name: string;
  primary_role: string;
  status: string;
  locale: string;
  service_country: string | null;
  created_at: Date;
  has_password: boolean;
  email_ciphertext: Buffer | null;
  phone_ciphertext: Buffer | null;
  contact_wrapped_dek: Buffer | null;
  avatar_updated_at: Date | null;
  avatar_variants: Record<string, { key: string; width: number; height: number }> | null;
}

interface AvatarRow {
  user_id: string;
  master_key: string;
  variants: Record<string, { key: string; width: number; height: number }> | null;
}
