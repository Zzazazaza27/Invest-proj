import { Injectable, Logger } from '@nestjs/common';
import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { uuidv7, type WebhookCreated, type WebhookEndpoint } from '@unicorn/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { errors } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { getEnv } from '../config/env';
import { Database, type Tx } from '../db/unit-of-work';
import type { IntegrationContext } from '../integration/service-auth';

/**
 * Вебхуки: подписка внешней системы на события по HTTPS.
 *
 * Самое опасное место всей интеграции — здесь. Адрес доставки задаёт ЧУЖАЯ
 * система, а запрос по нему выполняет наш сервер: это ровно определение SSRF.
 * Поэтому адрес проходит три независимых барьера, и ни один из них не заменяет
 * остальные:
 *
 *  1. схема запроса — только https;
 *  2. CHECK в БД — отвергает localhost, приватные диапазоны и адреса метаданных
 *     облака ещё на записи;
 *  3. проверка РЕЗОЛВА перед каждой доставкой — имя, которое сегодня указывает
 *     наружу, завтра может указывать на `169.254.169.254`. Проверка на этапе
 *     регистрации от этого не защищает вовсе (DNS rebinding).
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * Регистрация подписки.
   *
   * Секрет подписи возвращается ровно один раз: в БД он лежит зашифрованным, а
   * отпечаток нужен для аудита и поиска — по нему видно, что секрет тот самый,
   * не раскрывая его.
   */
  async register(
    ctx: IntegrationContext,
    input: { url: string; subscribedVerbs: string[] },
  ): Promise<WebhookCreated> {
    await assertPublicDestination(input.url);
    await this.assertKnownVerbs(ctx, input.subscribedVerbs);

    const secret = randomBytes(32).toString('base64url');
    const ciphertext = this.crypto.sealDirect('webhook_secrets', secret, WEBHOOK_SECRET_AAD);
    // Отпечаток — для аудита и поиска: по нему видно, что секрет тот самый, и
    // при этом сам секрет не раскрывается.
    // Правило SAST срабатывает на ИМЯ переменной. Значение здесь — свежие 32
    // байта из `randomBytes` строкой выше, а не литерал в исходниках.
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
    const fingerprint = createHash('sha256').update(secret, 'utf8').digest();
    const id = uuidv7();

    return this.db.asServiceRole('app_integration', { traceId: ctx.traceId }, async (tx) => {
      let row: EndpointRow;
      try {
        const { rows } = await tx.query<EndpointRow>(
          `INSERT INTO integration.webhook_endpoints
             (id, service_account_id, url, subscribed_verbs, secret_ciphertext,
              secret_kms_key_id, secret_fingerprint)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, url, subscribed_verbs, status, created_at`,
          [
            id,
            ctx.serviceAccountId,
            input.url,
            input.subscribedVerbs,
            ciphertext,
            'local/webhook_secrets/v1',
            fingerprint,
          ],
        );
        row = rows[0]!;
      } catch (error) {
        // CHECK адреса в БД — последний барьер: если он сработал, значит
        // прикладная проверка что-то пропустила, и это ошибка ввода, а не сбой.
        if ((error as { code?: string }).code === '23514') {
          throw errors.validation([
            { path: 'url', message: 'адрес недопустим: только внешний https' },
          ]);
        }
        throw error;
      }

      await this.audit.emit(tx, {
        verb: 'integration.webhook.registered',
        actorId: null,
        actorRole: 'system',
        subjectType: 'webhook_endpoint',
        subjectId: id,
        // Ни секрета, ни его отпечатка в журнале: событие фиксирует подписку.
        context: { clientId: ctx.clientId, verbs: input.subscribedVerbs, url: input.url },
        traceId: ctx.traceId,
      });

      return { ...mapEndpoint(row), signingSecret: secret };
    });
  }

  async list(ctx: IntegrationContext): Promise<WebhookEndpoint[]> {
    return this.db.asServiceRole('app_integration', { traceId: ctx.traceId }, async (tx) => {
      const { rows } = await tx.query<EndpointRow>(
        `SELECT id, url, subscribed_verbs, status, created_at
           FROM integration.webhook_endpoints
          WHERE service_account_id = $1
          ORDER BY created_at DESC
          LIMIT 100`,
        [ctx.serviceAccountId],
      );
      return rows.map(mapEndpoint);
    });
  }

  /** Отключение подписки. Строка остаётся: история подписок — часть аудита. */
  async disable(ctx: IntegrationContext, endpointId: string): Promise<void> {
    await this.db.asServiceRole('app_integration', { traceId: ctx.traceId }, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE integration.webhook_endpoints SET status = 'disabled'
          WHERE id = $1 AND service_account_id = $2 AND status <> 'disabled'`,
        [endpointId, ctx.serviceAccountId],
      );
      // Условие по владельцу — второй барьер поверх политики: чужую подписку
      // не отключить, и ответ не отличает «чужая» от «не существует».
      if (rowCount === 0) throw errors.notFound({ subject: 'webhook' });
    });
  }

  /** Verb должен быть зарегистрирован: подписка на опечатку молча не работает. */
  private async assertKnownVerbs(ctx: IntegrationContext, verbs: string[]): Promise<void> {
    const unknown = await this.db.asServiceRole(
      'app_integration',
      { traceId: ctx.traceId },
      async (tx) => {
        const { rows } = await tx.query<{ verb: string }>(
          `SELECT v AS verb FROM unnest($1::text[]) AS v
            WHERE NOT EXISTS (SELECT 1 FROM audit.event_type_registry r WHERE r.verb = v)`,
          [verbs],
        );
        return rows.map((row) => row.verb);
      },
    );
    if (unknown.length > 0) {
      throw errors.validation([
        { path: 'subscribedVerbs', message: `неизвестные события: ${unknown.join(', ')}` },
      ]);
    }
  }
}

/**
 * Подпись доставки.
 *
 * Формат `t=<unixtime>,v1=<hex>`: timestamp входит в подписываемую строку,
 * поэтому перехваченную доставку нельзя переиграть позже — получатель обязан
 * отвергать старые метки. Подпись считается от полного тела, а не от его части.
 */
export function signDelivery(secret: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

/** Окно, за пределами которого получатель обязан считать доставку устаревшей. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Диапазоны, в которые доставка не пойдёт никогда.
 *
 * Список намеренно шире «локалхоста»: адрес метаданных облака выдаёт временные
 * учётные данные роли инстанса — это самый дорогой из возможных исходов SSRF.
 */
export function isForbiddenAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local и метаданные облака
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA
    if (normalized.startsWith('fe80')) return true; // link-local
    // IPv4-mapped: ::ffff:127.0.0.1 обходит проверку четвёрки, если её не снять.
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isForbiddenAddress(mapped[1]);
    return false;
  }
  return true;
}

/**
 * Проверка адреса доставки ПЕРЕД запросом.
 *
 * Резолв выполняется здесь же, и результат возвращается вызывающему: иначе
 * между проверкой и запросом остаётся окно, в которое DNS успевает ответить
 * другим адресом (TOCTOU).
 */
export async function assertPublicDestination(rawUrl: string): Promise<string[]> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw errors.validation([{ path: 'url', message: 'некорректный адрес' }]);
  }
  if (url.protocol !== 'https:') {
    throw errors.validation([{ path: 'url', message: 'только https' }]);
  }
  if (url.username || url.password) {
    throw errors.validation([{ path: 'url', message: 'учётные данные в адресе недопустимы' }]);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isForbiddenAddress(host)) {
    throw errors.validation([{ path: 'url', message: 'адрес во внутренней сети недопустим' }]);
  }

  let addresses: string[];
  try {
    const resolved = await lookup(host, { all: true });
    addresses = resolved.map((entry) => entry.address);
  } catch {
    throw errors.validation([{ path: 'url', message: 'имя не разрешается' }]);
  }
  if (addresses.length === 0 || addresses.some(isForbiddenAddress)) {
    // Достаточно ОДНОГО запрещённого адреса: балансировщик может вернуть
    // именно его, и «в среднем внешнее» имя тут не аргумент.
    throw errors.validation([{ path: 'url', message: 'имя разрешается во внутреннюю сеть' }]);
  }
  return addresses;
}

/** Идентификатор трассировки доставки — попадает в заголовок получателю. */
export function newDeliveryTraceId(): string {
  return randomUUID();
}

/** Таймаут доставки: внешний вызов без предела висел бы вечно (RULES §3.1). */
export function deliveryTimeoutMs(): number {
  return getEnv().WEBHOOK_TIMEOUT_MS;
}

interface EndpointRow {
  id: string;
  url: string;
  subscribed_verbs: string[];
  status: WebhookEndpoint['status'];
  created_at: Date;
}

function mapEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    subscribedVerbs: row.subscribed_verbs,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Экспортируется для доставщика: он читает секрет тем же доменом ключей.
 *
 * Это метка связанных данных (AAD) шифрования, а не секрет: она обязана быть
 * одинаковой у того, кто шифрует, и у того, кто расшифровывает, и её раскрытие
 * ничего не даёт.
 */
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
export const WEBHOOK_SECRET_AAD = 'webhook:signing';

export type { Tx };
