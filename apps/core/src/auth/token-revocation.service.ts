import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Database, type Tx } from '../db/unit-of-work';

/**
 * Реестр отозванных токенов (M038).
 *
 * Рубеж сессий (`session-epoch.service.ts`) обесценивает ВСЕ токены
 * пользователя разом — это верный ответ на «права изменились», но не на «выйти
 * на этом устройстве». До появления реестра выход удалял только cookie: сам
 * токен оставался действительным до `exp`, и скопированное значение работало
 * час.
 *
 * Здесь хранится обратное — идентификаторы отозванных токенов. Реестра
 * ВЫДАННЫХ токенов нет намеренно: он потребовал бы записи в БД на каждый вход,
 * то есть на горячем пути, ради данных, нужных в доле процента случаев.
 *
 * Проверка идёт по снимку, а не запросом на каждый входящий запрос. Причина
 * арифметическая: отозванных токенов всегда мало (запись живёт до истечения
 * самого токена, то есть максимум час), поэтому один запрос раз в
 * `SNAPSHOT_TTL_MS` дешевле, чем обращение к БД на каждый вызов API. Плата
 * названа числом: отзыв вступает в силу на других экземплярах не позже
 * `SNAPSHOT_TTL_MS`, на своём — немедленно.
 */
@Injectable()
export class TokenRevocationService {
  private readonly logger = new Logger(TokenRevocationService.name);
  /** Снимок отозванных идентификаторов; `null` — ещё не читали. */
  private snapshot: Set<string> | null = null;
  private snapshotReadAt = 0;
  /**
   * Снимок неполон: отозванных больше, чем помещается в предел. Тогда проверка
   * идёт прямым запросом — медленнее, но без ложного «токен действителен».
   */
  private snapshotTruncated = false;
  /** Один общий запрос на обновление: параллельные вызовы не множат нагрузку. */
  private refreshing: Promise<void> | null = null;

  constructor(private readonly db: Database) {}

  /**
   * Отозван ли токен.
   *
   * Токен без идентификатора считается НЕ отозванным: отзывать нечего. Это не
   * дыра — такой токен всё равно проходит проверку рубежа сессий, которая
   * работает по времени выпуска, а не по идентификатору.
   */
  async isRevoked(tokenId: string | null): Promise<boolean> {
    if (!tokenId) return false;

    await this.ensureSnapshot();
    if (this.snapshot?.has(tokenId)) return true;
    // Неполный снимок не даёт права на вывод «не отозван»: спрашиваем БД.
    if (this.snapshotTruncated) return this.lookup(tokenId);
    return false;
  }

  /**
   * Отозвать токен. Пишется той же транзакцией, что и остальные действия
   * вызывающего: отзыв, не доехавший вместе с фактом выхода, — это отзыв,
   * которого не было.
   */
  async revoke(
    tx: Tx,
    input: {
      tokenId: string;
      userId: string;
      expiresAt: Date;
      reason: 'logout' | 'admin' | 'compromise';
      revokedBy: string | null;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO identity.revoked_tokens (jti, user_id, expires_at, revoked_by, reason)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (jti) DO NOTHING`,
      [input.tokenId, input.userId, input.expiresAt, input.revokedBy, input.reason],
    );
  }

  /**
   * Отметить отзыв в снимке своего экземпляра.
   *
   * Вызывается ПОСЛЕ фиксации транзакции, а не внутри неё. Внутри было бы
   * неверно: откат оставил бы токен «отозванным» в памяти при пустом реестре, и
   * через `SNAPSHOT_TTL_MS` он бы снова заработал — отзыв, которого не было, с
   * последующим самопроизвольным восстановлением.
   */
  markRevokedLocally(tokenId: string): void {
    this.snapshot?.add(tokenId);
  }

  /**
   * Убрать записи об истёкших токенах.
   *
   * Строка о токене, который и так истёк, ни на что не влияет: проверка срока
   * отклонит его раньше. Реестр обязан оставаться маленьким — на этом построена
   * дешевизна проверки снимком.
   */
  /** @param signal прерывание фона: проверяется после получения соединения, до DELETE. */
  async purgeExpired(signal?: AbortSignal): Promise<number> {
    // Ролью обслуживания, а не ролью приложения. DELETE читает строку, поэтому
    // к нему применяется SELECT-политика: у роли приложения она ограничена
    // своими записями, и уборка без пользовательского контекста удаляла ноль
    // строк — молча, без ошибки (поймано прогоном, см. M038/M039).
    const removed = await this.db.asServiceRole(
      'app_maintenance',
      { traceId: `token-purge-${randomUUID()}` },
      async (tx) => {
        signal?.throwIfAborted();
        const { rowCount } = await tx.query(
          'DELETE FROM identity.revoked_tokens WHERE expires_at < now()',
        );
        return rowCount ?? 0;
      },
    );
    if (removed > 0) this.snapshot = null;
    return removed;
  }

  /** Только для тестов и прогонов: заставить перечитать снимок. */
  resetCache(): void {
    this.snapshot = null;
    this.snapshotReadAt = 0;
    this.snapshotTruncated = false;
  }

  private async ensureSnapshot(): Promise<void> {
    if (this.snapshot && Date.now() - this.snapshotReadAt < SNAPSHOT_TTL_MS) return;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
  }

  private async refresh(): Promise<void> {
    try {
      const rows = await this.db.asServiceRole(
        'app_auth',
        { traceId: `token-revocations-${randomUUID()}` },
        async (tx) => {
          const { rows } = await tx.query<{ jti: string }>(
            `SELECT jti FROM identity.revoked_tokens
              WHERE expires_at > now()
              LIMIT ${SNAPSHOT_MAX_ROWS + 1}`,
          );
          return rows;
        },
      );
      this.snapshotTruncated = rows.length > SNAPSHOT_MAX_ROWS;
      this.snapshot = new Set(rows.slice(0, SNAPSHOT_MAX_ROWS).map((r) => r.jti));
      this.snapshotReadAt = Date.now();
      if (this.snapshotTruncated) {
        this.logger.warn({
          msg: 'реестр отозванных токенов не помещается в снимок, проверка идёт запросом',
          limit: SNAPSHOT_MAX_ROWS,
        });
      }
    } catch (error) {
      // Недоступный реестр НЕ означает «всё разрешено». Снимок не обновляется,
      // а проверка переключается на прямой запрос: если недоступна и БД, запрос
      // упадёт, и вход будет отклонён — fail-closed.
      this.snapshotTruncated = true;
      this.snapshotReadAt = Date.now();
      this.snapshot ??= new Set();
      this.logger.error({
        msg: 'не удалось прочитать реестр отозванных токенов',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async lookup(tokenId: string): Promise<boolean> {
    return this.db.asServiceRole(
      'app_auth',
      { traceId: `token-revocation-${randomUUID()}` },
      async (tx) => {
        const { rows } = await tx.query(
          'SELECT 1 FROM identity.revoked_tokens WHERE jti = $1 AND expires_at > now()',
          [tokenId],
        );
        return rows.length > 0;
      },
    );
  }
}

/**
 * Сколько живёт снимок. Пять секунд — та же величина, что и у рубежа сессий:
 * задержка меньше времени реакции человека и заметно больше длительности
 * запроса, поэтому нагрузки на БД не создаёт.
 */
const SNAPSHOT_TTL_MS = 5000;

/**
 * Предел размера снимка. Десять тысяч записей — это десять тысяч отзывов за
 * время жизни токена; больше означает массовый инцидент, и тогда правильнее
 * платить запросом за проверку, чем держать в памяти неограниченный набор.
 */
const SNAPSHOT_MAX_ROWS = 10_000;
