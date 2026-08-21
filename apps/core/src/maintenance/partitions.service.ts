import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getEnv } from '../config/env';
import { Database } from '../db/unit-of-work';
import { TokenRevocationService } from '../auth/token-revocation.service';
import { StorageJanitorService } from './storage-janitor.service';

/**
 * Плановое обслуживание партиций журнала.
 *
 * Закрывает долг предыдущей фазы: партиции `audit.events` создавались разовым
 * вызовом из миграции, и первого числа месяца, на который партиции не хватило,
 * запись события — а значит и любая доменная мутация — упала бы целиком.
 * Журнал пишется в той же транзакции, что и факт, поэтому «журнал не пишется»
 * означает «платформа не работает».
 *
 * Прогон идёт при старте и далее по интервалу. Функция БД идемпотентна:
 * одновременный запуск на нескольких экземплярах core безопасен — существующая
 * партиция не создаётся повторно, а конфликт диапазона обрабатывается внутри.
 */
@Injectable()
export class PartitionMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PartitionMaintenanceService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly revocations: TokenRevocationService,
    private readonly storageJanitor: StorageJanitorService,
  ) {}

  async onModuleInit(): Promise<void> {
    const env = getEnv();
    // Первый прогон — сразу: экземпляр, поднявшийся после долгого простоя,
    // не должен ждать полного интервала.
    await this.runOnce();
    await this.purgeRevocations();
    await this.purgeAbandonedUploads();
    await this.purgeVerificationTokens();

    this.timer = setInterval(() => {
      void this.runOnce();
      void this.purgeRevocations();
      void this.purgeAbandonedUploads();
      void this.purgeVerificationTokens();
    }, env.PARTITION_MAINTENANCE_INTERVAL_HOURS * 3_600_000);
    // Таймер не должен удерживать процесс при штатном завершении.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Возвращает число созданных партиций. Ошибка логируется, но не роняет процесс. */
  async runOnce(): Promise<number> {
    const env = getEnv();
    try {
      return await this.db.transaction(
        { userId: null, roles: ['system'], traceId: `partitions-${randomUUID()}` },
        async (tx) => {
          const { rows } = await tx.query<{ created: number }>(
            'SELECT audit.ensure_event_partitions($1) AS created',
            [env.PARTITION_MONTHS_AHEAD],
          );
          const created = rows[0]?.created ?? 0;
          if (created > 0) {
            this.logger.log(`созданы партиции журнала: ${created}`);
          }
          return created;
        },
      );
    } catch (error) {
      // Недоступная БД на старте — не повод не запускаться: health-проверка
      // покажет деградацию, а следующий тик попробует снова.
      this.logger.error({
        msg: 'обслуживание партиций не выполнено',
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Уборка реестра отозванных токенов (M038).
   *
   * Запись о токене, который и так истёк, ни на что не влияет: срок проверяется
   * раньше. Реестр обязан оставаться маленьким — на этом построена дешевизна
   * проверки отзыва снимком, а не запросом на каждый вызов API.
   */
  async purgeRevocations(): Promise<number> {
    try {
      const removed = await this.revocations.purgeExpired();
      if (removed > 0) this.logger.log(`убрано записей об истёкших токенах: ${removed}`);
      return removed;
    } catch (error) {
      this.logger.error({
        msg: 'уборка реестра отозванных токенов не выполнена',
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Уборка отработавших токенов подтверждения (M060).
   *
   * Убираются ТОЛЬКО просроченные и уже использованные — это же условие стоит
   * в политике роли обслуживания. Живой токен уборщик не трогает: удалить его
   * значило бы молча сломать восстановление доступа тому, кто как раз идёт по
   * ссылке.
   *
   * Роль `app_maintenance`, а не `app_backend`: у уборки нет пользовательского
   * контекста, и выдавать право удаления роли, обслуживающей запросы людей,
   * незачем (M039).
   */
  async purgeVerificationTokens(): Promise<number> {
    try {
      const removed = await this.db.asServiceRole(
        'app_maintenance',
        { traceId: `verification-purge-${randomUUID()}` },
        async (tx) => {
          const { rowCount } = await tx.query(
            `DELETE FROM identity.verification_tokens
              WHERE expires_at < now() - interval '7 days' OR used_at < now() - interval '7 days'`,
          );
          return rowCount ?? 0;
        },
      );
      if (removed > 0) this.logger.log(`убрано отработавших ссылок подтверждения: ${removed}`);
      return removed;
    } catch (error) {
      this.logger.error({
        msg: 'уборка ссылок подтверждения не выполнена',
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Уборка брошенных билетов на загрузку (остаток SEC-14).
   *
   * Ошибка уборки не роняет процесс: обслуживание — фоновая работа, и
   * недоступное хранилище не повод не обслуживать запросы. Но и молчать о ней
   * нельзя: мусор копится незаметно.
   */
  async purgeAbandonedUploads(): Promise<number> {
    try {
      return await this.storageJanitor.purgeAbandonedUploads();
    } catch (error) {
      this.logger.error({
        msg: 'уборка брошенных загрузок не выполнена',
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}
