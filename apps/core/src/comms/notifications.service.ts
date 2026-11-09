import { Injectable, Logger } from '@nestjs/common';
import {
  uuidv7,
  type Notification,
  type NotificationPreference,
  type UserDevice,
} from '@fifth/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { actingSelf } from '../audit/actor-context';
import { errors } from '../common/errors';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Уведомления.
 *
 * Ядро только СТАВИТ уведомление в очередь — в той же транзакции, что и
 * доменный факт. Отправкой занимается отдельный контур под ролью
 * `app_notifications`: у него есть право читать чужие предпочтения и токены
 * устройств, а у роли, обслуживающей пользовательские запросы, — нет.
 *
 * Отсюда следует важное для понимания кода: фильтрация по предпочтениям
 * пользователя здесь НЕ делается. Она невозможна честным путём (чужие
 * предпочтения роли приложения не видны) и не нужна: статус
 * `skipped_by_preference` проставляет доставка, и это единственное место, где
 * решение о «не слать» остаётся наблюдаемым, а не растворяется в тишине.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  // ------------------------------------------------------------- устройства

  /**
   * Регистрация устройства для push.
   *
   * Повторный вызов с тем же токеном — обычное поведение мобильного клиента
   * при каждом запуске, поэтому он идемпотентен и обновляет «последний раз
   * виден». Токен, уже занятый ДРУГИМ пользователем, не переназначается и не
   * подтверждается: ответ одинаков и для «занят другим», и для отказа
   * политики — иначе регистрация превращается в оракул чужих устройств.
   */
  async registerDevice(
    ctx: RequestContext,
    input: {
      platform: 'ios' | 'android' | 'web_pwa';
      pushProvider: 'fcm' | 'apns' | 'web_push';
      pushToken: string;
      deviceName?: string;
      appVersion?: string;
    },
  ): Promise<UserDevice> {
    return this.db.transaction(ctx, async (tx) => {
      try {
        const { rows } = await tx.query<DeviceRow>(
          `INSERT INTO comms.user_devices
             (id, user_id, platform, push_provider, push_token, device_name, app_version, locale)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'ru-RU')
           ON CONFLICT (push_provider, push_token) WHERE revoked_at IS NULL
           DO UPDATE SET last_seen_at = now(),
                         device_name  = EXCLUDED.device_name,
                         app_version  = EXCLUDED.app_version,
                         platform     = EXCLUDED.platform
           RETURNING id, platform, push_provider, device_name, app_version,
                     last_seen_at, created_at`,
          [
            uuidv7(),
            ctx.userId,
            input.platform,
            input.pushProvider,
            input.pushToken,
            input.deviceName ?? null,
            input.appVersion ?? null,
          ],
        );
        return mapDevice(rows[0]!);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === '23505' || code === '42501') {
          throw errors.conflict('Это устройство уже зарегистрировано');
        }
        throw error;
      }
    });
  }

  async listDevices(ctx: RequestContext): Promise<UserDevice[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<DeviceRow>(
        `SELECT id, platform, push_provider, device_name, app_version, last_seen_at, created_at
           FROM comms.user_devices
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY last_seen_at DESC
          LIMIT 100`,
        [ctx.userId],
      );
      return rows.map(mapDevice);
    });
  }

  /** Отзыв устройства. Строка не удаляется: история регистраций — часть аудита. */
  async revokeDevice(ctx: RequestContext, deviceId: string): Promise<void> {
    await this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE comms.user_devices SET revoked_at = now()
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [deviceId, ctx.userId],
      );
      // RLS уже ограничивает выборку своими устройствами; условие по user_id —
      // второй барьер на случай ошибки в политике, а не замена ей.
      if (rowCount === 0) {
        // Целевое состояние (2.6, пакет 8): СВОЁ устройство уже отозвано — успех. Чужое или
        // несуществующее — по-прежнему «нет такого».
        const { rows } = await tx.query(
          `SELECT 1 FROM comms.user_devices WHERE id = $1 AND user_id = $2`,
          [deviceId, ctx.userId],
        );
        if (rows.length === 0) throw errors.notFound({ subject: 'device' });
        return;
      }
      // Учёт удалений (2.1.5): после восстановления старой копии устройство не оживает.
      // Своё устройство отзывает сам человек: основание «сам», роль журнала `user`
      // (блок 10). Прежде событие пропускалось, если подходящей роли не находилось.
      {
        await this.audit.emit(tx, {
          verb: 'comms.device.revoked',
          actorId: ctx.userId,
          actorRole: actingSelf(ctx),
          subjectType: 'device',
          subjectId: deviceId,
          context: {},
          traceId: ctx.traceId,
        });
      }
    });
  }

  // ----------------------------------------------------------- предпочтения

  async getPreferences(ctx: RequestContext): Promise<NotificationPreference[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<PreferenceRow>(
        `SELECT channel, topic, enabled, quiet_hours_tz, quiet_from, quiet_to
           FROM comms.notification_preferences
          WHERE user_id = $1
          ORDER BY channel, topic`,
        [ctx.userId],
      );
      return rows.map(mapPreference);
    });
  }

  /**
   * Обновление предпочтений.
   *
   * Темы `security` и `billing` отключить нельзя — это проверяется схемой
   * запроса, а CHECK в БД остаётся последним рубежом: попытка обойти проверку
   * приложения упирается в ограничение таблицы, а не в его отсутствие.
   */
  async updatePreferences(
    ctx: RequestContext,
    items: NotificationPreference[],
  ): Promise<NotificationPreference[]> {
    return this.db.transaction(ctx, async (tx) => {
      try {
        for (const item of items) {
          await tx.query(
            `INSERT INTO comms.notification_preferences
               (user_id, channel, topic, enabled, quiet_hours_tz, quiet_from, quiet_to, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::time, $7::time, now())
             ON CONFLICT (user_id, channel, topic) DO UPDATE
               SET enabled = EXCLUDED.enabled,
                   quiet_hours_tz = EXCLUDED.quiet_hours_tz,
                   quiet_from = EXCLUDED.quiet_from,
                   quiet_to = EXCLUDED.quiet_to,
                   updated_at = now()`,
            [
              ctx.userId,
              item.channel,
              item.topic,
              item.enabled,
              item.quietHoursTz ?? null,
              item.quietFrom ?? null,
              item.quietTo ?? null,
            ],
          );
        }
      } catch (error) {
        if ((error as { code?: string }).code === '23514') {
          throw errors.validation([
            { path: 'items', message: 'уведомления о безопасности и платежах отключить нельзя' },
          ]);
        }
        throw error;
      }

      const { rows } = await tx.query<PreferenceRow>(
        `SELECT channel, topic, enabled, quiet_hours_tz, quiet_from, quiet_to
           FROM comms.notification_preferences
          WHERE user_id = $1
          ORDER BY channel, topic`,
        [ctx.userId],
      );
      return rows.map(mapPreference);
    });
  }

  // ------------------------------------------------------------ собственная лента

  async list(ctx: RequestContext, limit: number): Promise<Notification[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<NotificationRow>(
        `SELECT id, channel, template_code, payload_jsonb, status, created_at, sent_at
           FROM comms.notifications
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [ctx.userId, limit],
      );
      return rows.map(mapNotification);
    });
  }

  // ------------------------------------------------------------- постановка

  /**
   * Поставить уведомление в очередь. Вызывается ИЗ ТРАНЗАКЦИИ доменной
   * операции: уведомление о событии, которого не произошло, — такой же дефект,
   * как событие без уведомления.
   *
   * @returns число фактически поставленных строк (0 — шаблон не найден или
   *          повтор по ключу дедупликации).
   */
  async enqueue(
    tx: Tx,
    input: {
      userId: string;
      code: string;
      payload: Record<string, unknown>;
      /** Ключ дедупликации в пределах пользователя. Повтор не создаёт второй строки. */
      dedupKey?: string;
    },
  ): Promise<number> {
    assertSafePayload(input.payload);

    const channels = await this.primaryChannels(tx, input.code);
    if (channels.length === 0) {
      // Молча пропустить — значит потерять уведомление без следа. Шаблон
      // отсутствует по вине конфигурации, и это должно быть видно в логе.
      this.logger.warn({ msg: 'нет активного шаблона уведомления', code: input.code });
      return 0;
    }

    let queued = 0;
    for (const channel of channels) {
      // Дедупликация держится уникальным индексом, а повтор ловится как ошибка
      // и гасится откатом до точки сохранения.
      //
      // Здесь нельзя написать `ON CONFLICT DO NOTHING`: при включённом RLS
      // PostgreSQL требует, чтобы новая строка проходила ещё и SELECT-политику
      // (иначе по факту конфликта можно было бы узнать о невидимых строках), а
      // уведомление ставится ЧУЖОМУ пользователю — своих строк он не видит.
      // Проверено прогоном: тот же INSERT без ON CONFLICT проходит, с ним —
      // падает 42501. Ослаблять политику ради синтаксиса нельзя: чтение чужой
      // ленты уведомлений роли приложения не положено.
      await tx.query('SAVEPOINT notification_enqueue');
      try {
        const { rowCount } = await tx.query(
          `INSERT INTO comms.notifications
             (id, user_id, channel, template_code, payload_jsonb, dedup_key)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            uuidv7(),
            input.userId,
            channel,
            input.code,
            JSON.stringify(input.payload),
            input.dedupKey ? `${input.dedupKey}:${channel}` : null,
          ],
        );
        queued += rowCount ?? 0;
        await tx.query('RELEASE SAVEPOINT notification_enqueue');
      } catch (error) {
        // Любая другая ошибка обрывает доменную операцию целиком: точку
        // сохранения снимать нечем — транзакция всё равно откатывается.
        if ((error as { code?: string }).code !== '23505') throw error;
        // Повтор по ключу дедупликации — штатный исход ретрая, а не сбой.
        await tx.query('ROLLBACK TO SAVEPOINT notification_enqueue');
        await tx.query('RELEASE SAVEPOINT notification_enqueue');
      }
    }
    return queued;
  }

  /**
   * Каналы первичной доставки для кода.
   *
   * Первичный канал — тот, которого нет ни в одной цепочке отката того же кода.
   * Иначе email, указанный запасным для push, получил бы вторую строку в
   * очереди и пользователь — два одинаковых уведомления вместо одного с
   * откатом.
   */
  private async primaryChannels(tx: Tx, code: string): Promise<string[]> {
    const { rows } = await tx.query<{ channel: string; fallback_chain: string[] }>(
      `SELECT channel, fallback_chain FROM comms.notification_templates
        WHERE code = $1 AND is_active AND locale = 'ru-RU'`,
      [code],
    );
    return selectPrimaryChannels(rows);
  }
}

/** Чистая часть выбора каналов — вынесена, чтобы проверяться без БД. */
export function selectPrimaryChannels(
  templates: readonly { channel: string; fallback_chain: readonly string[] }[],
): string[] {
  const fallbacks = new Set(templates.flatMap((t) => t.fallback_chain));
  const primary = templates.filter((t) => !fallbacks.has(t.channel)).map((t) => t.channel);
  // Все каналы объявлены запасными друг для друга — конфигурация циклична.
  // Берём любой детерминированно, но не молча: пустая очередь хуже лишнего.
  return primary.length > 0
    ? primary.sort()
    : templates
        .map((t) => t.channel)
        .sort()
        .slice(0, 1);
}

/**
 * Полезная нагрузка уведомления проходит через сторонних провайдеров push, SMS
 * и e-mail. Персональные данные там оказаться не должны — ни фамилии, ни
 * телефона, ни документа. Проверка грубая по построению: это барьер против
 * невнимательности вызывающего кода, а не классификатор ПДн.
 */
const FORBIDDEN_PAYLOAD_KEYS = [
  'email',
  'phone',
  'passport',
  'inn',
  'ogrn',
  'snils',
  'birth',
  'address',
  'fullname',
  'full_name',
  'lastname',
  'last_name',
  'firstname',
  'first_name',
  'patronymic',
  'card',
  'token',
  'secret',
  'password',
];

const MAX_PAYLOAD_VALUE_LENGTH = 500;

export function assertSafePayload(payload: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(payload)) {
    const normalized = key.toLowerCase();
    if (FORBIDDEN_PAYLOAD_KEYS.some((forbidden) => normalized.includes(forbidden))) {
      throw errors.internal({ reason: 'pii-in-notification-payload', key });
    }
    if (value !== null && typeof value === 'object') {
      throw errors.internal({ reason: 'non-scalar-notification-payload', key });
    }
    if (typeof value === 'string' && value.length > MAX_PAYLOAD_VALUE_LENGTH) {
      throw errors.internal({ reason: 'oversized-notification-payload', key });
    }
  }
}

interface DeviceRow {
  id: string;
  platform: UserDevice['platform'];
  push_provider: UserDevice['pushProvider'];
  device_name: string | null;
  app_version: string | null;
  last_seen_at: Date;
  created_at: Date;
}

function mapDevice(row: DeviceRow): UserDevice {
  return {
    id: row.id,
    platform: row.platform,
    pushProvider: row.push_provider,
    deviceName: row.device_name,
    appVersion: row.app_version,
    lastSeenAt: row.last_seen_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

interface PreferenceRow {
  channel: NotificationPreference['channel'];
  topic: NotificationPreference['topic'];
  enabled: boolean;
  quiet_hours_tz: string | null;
  quiet_from: string | null;
  quiet_to: string | null;
}

function mapPreference(row: PreferenceRow): NotificationPreference {
  return {
    channel: row.channel,
    topic: row.topic,
    enabled: row.enabled,
    quietHoursTz: row.quiet_hours_tz,
    // PostgreSQL отдаёт time как HH:MM:SS; наружу контракт объявляет HH:MM.
    quietFrom: row.quiet_from ? row.quiet_from.slice(0, 5) : null,
    quietTo: row.quiet_to ? row.quiet_to.slice(0, 5) : null,
  };
}

interface NotificationRow {
  id: string;
  channel: Notification['channel'];
  template_code: string;
  payload_jsonb: Record<string, unknown>;
  status: Notification['status'];
  created_at: Date;
  sent_at: Date | null;
}

function mapNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    channel: row.channel,
    templateCode: row.template_code,
    payload: row.payload_jsonb,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
  };
}
