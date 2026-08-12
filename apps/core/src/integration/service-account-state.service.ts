import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Database } from '../db/unit-of-work';

/**
 * Действующее состояние сервисных аккаунтов (M042).
 *
 * Зачем. Токен интеграции самодостаточен: подпись и срок в нём самом, к БД он
 * не обращается. Пока это было так, приостановка аккаунта закрывала только
 * ВЫДАЧУ новых токенов — уже выданный работал до `exp`, то есть до часа. На
 * украденный токен администратор фактически не мог отреагировать (SEC-08).
 *
 * Здесь на каждый запрос сверяется рубеж (`token_epoch`) из токена с текущим
 * рубежом аккаунта. Приостановка и ротация секрета рубеж увеличивают.
 *
 * Проверка идёт по снимку, а не запросом на каждый вызов: сервисных аккаунтов
 * десятки, а не миллионы, поэтому весь их список помещается в память целиком и
 * читается раз в `SNAPSHOT_TTL_MS`. Плата названа числом: на своём экземпляре
 * приостановка действует немедленно, на других — не позже пяти секунд.
 *
 * Снимок читается ролью `app_integration`, чья политика чтения аккаунтов
 * ограничена `status = 'active'` (M010). Приостановленный аккаунт из выборки
 * исчезает — и токен отклоняется независимо от рубежа.
 */
@Injectable()
export class ServiceAccountStateService {
  private readonly logger = new Logger(ServiceAccountStateService.name);
  /** Идентификатор аккаунта → его текущий рубеж. `null` — ещё не читали. */
  private snapshot: Map<string, number> | null = null;
  private snapshotReadAt = 0;
  /** Снимок недостоверен: читать его как «аккаунта нет» нельзя. */
  private snapshotStale = false;
  /** Один общий запрос на обновление: параллельные вызовы не множат нагрузку. */
  private refreshing: Promise<void> | null = null;

  constructor(private readonly db: Database) {}

  /**
   * Действует ли токен этого аккаунта с этим рубежом.
   *
   * Токен без рубежа отвергается: он выдан до появления механизма и проверить
   * его нечем. Отсутствие проверяемого признака — это отказ, а не разрешение.
   */
  async isTokenCurrent(accountId: string, epoch: number | undefined): Promise<boolean> {
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) return false;

    await this.ensureSnapshot();
    if (!this.snapshotStale) return this.snapshot?.get(accountId) === epoch;
    // Недостоверный снимок не даёт права на вывод «аккаунт активен»: спрашиваем
    // БД. Недоступна и она — запрос упадёт, и доступ будет закрыт (fail-closed).
    return this.lookup(accountId, epoch);
  }

  /**
   * Отметить новый рубеж на своём экземпляре.
   *
   * Вызывается ПОСЛЕ фиксации транзакции: внутри неё откат оставил бы в памяти
   * рубеж, которого нет в БД, и работающие токены отвергались бы до истечения
   * снимка.
   */
  markEpochLocally(accountId: string, epoch: number): void {
    this.snapshot?.set(accountId, epoch);
  }

  /** Отметить исчезновение аккаунта из активных на своём экземпляре. */
  markSuspendedLocally(accountId: string): void {
    this.snapshot?.delete(accountId);
  }

  /** Только для тестов и прогонов: заставить перечитать снимок. */
  resetCache(): void {
    this.snapshot = null;
    this.snapshotReadAt = 0;
    this.snapshotStale = false;
  }

  private async ensureSnapshot(): Promise<void> {
    if (
      this.snapshot &&
      !this.snapshotStale &&
      Date.now() - this.snapshotReadAt < SNAPSHOT_TTL_MS
    ) {
      return;
    }
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
  }

  private async refresh(): Promise<void> {
    try {
      const rows = await this.db.asServiceRole(
        'app_integration',
        { traceId: `service-accounts-${randomUUID()}` },
        async (tx) => {
          const { rows } = await tx.query<{ id: string; token_epoch: number }>(
            `SELECT id, token_epoch FROM integration.service_accounts
              LIMIT ${SNAPSHOT_MAX_ROWS + 1}`,
          );
          return rows;
        },
      );
      if (rows.length > SNAPSHOT_MAX_ROWS) {
        // Аккаунтов больше, чем предполагает эта схема проверки. Молча взять
        // первые — значит отвергать законные токены остальных; вместо этого
        // проверка переходит на прямой запрос.
        this.snapshotStale = true;
        this.snapshotReadAt = Date.now();
        this.logger.warn({
          msg: 'сервисных аккаунтов больше предела снимка, проверка идёт запросом',
          limit: SNAPSHOT_MAX_ROWS,
        });
        return;
      }
      this.snapshot = new Map(rows.map((row) => [row.id, Number(row.token_epoch)]));
      this.snapshotStale = false;
      this.snapshotReadAt = Date.now();
    } catch (error) {
      this.snapshotStale = true;
      this.snapshotReadAt = Date.now();
      this.logger.error({
        msg: 'не удалось прочитать состояние сервисных аккаунтов',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async lookup(accountId: string, epoch: number): Promise<boolean> {
    return this.db.asServiceRole(
      'app_integration',
      { traceId: `service-account-${randomUUID()}` },
      async (tx) => {
        const { rows } = await tx.query(
          `SELECT 1 FROM integration.service_accounts
            WHERE id = $1 AND token_epoch = $2`,
          [accountId, epoch],
        );
        return rows.length > 0;
      },
    );
  }
}

/** Столько живёт снимок — та же величина, что у рубежа сессий и реестра отзыва. */
const SNAPSHOT_TTL_MS = 5000;

/**
 * Предел размера снимка. Тысяча сервисных аккаунтов — это на два порядка больше
 * любого правдоподобного числа внешних интеграций; выше него схема «весь список
 * в память» перестаёт быть уместной, и это видно из журнала.
 */
const SNAPSHOT_MAX_ROWS = 1000;
