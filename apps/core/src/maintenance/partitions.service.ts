import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BackgroundJobsService } from '../background/background-jobs.service';
import { resultOf } from '../background/job';
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
 * Тем не менее задачи обслуживания координируются advisory-блокировкой
 * (блок 1): проход выполняет один экземпляр, остальные его пропускают.
 */
@Injectable()
export class PartitionMaintenanceService implements OnModuleInit {
  private readonly logger = new Logger(PartitionMaintenanceService.name);

  constructor(
    private readonly db: Database,
    private readonly revocations: TokenRevocationService,
    private readonly storageJanitor: StorageJanitorService,
    private readonly jobs: BackgroundJobsService,
  ) {}

  onModuleInit(): void {
    const intervalMs = getEnv().PARTITION_MAINTENANCE_INTERVAL_HOURS * 3_600_000;
    // Первый проход — сразу после запуска фона (`runAtStart`): экземпляр,
    // поднявшийся после долгого простоя, не должен ждать полного интервала.
    // Прежде эти проходы шли прямо здесь, в инициализации модуля, — и
    // выключатель фона их не перекрывал бы.
    const maintenance = (name: string, run: (signal: AbortSignal) => Promise<number>): void =>
      this.jobs.register({
        name,
        intervalMs,
        coordination: 'advisory',
        runAtStart: true,
        run: async ({ signal }) => resultOf(await run(signal)),
      });
    maintenance('maintenance.partitions', (signal) => this.runOnce(signal));
    maintenance('maintenance.revocations', (signal) => this.purgeRevocations(signal));
    maintenance('maintenance.abandoned-uploads', (signal) => this.purgeAbandonedUploads(signal));
    maintenance('maintenance.verification-tokens', (signal) =>
      this.purgeVerificationTokens(signal),
    );
  }

  /**
   * Возвращает число созданных партиций. Ошибка бросается: её записывает
   * оболочка фона.
   *
   * Сигнал во всех задачах обслуживания проверяется ВНУТРИ транзакции, перед
   * изменением: так он охватывает и ожидание соединения из пула. Прерванная
   * транзакция откатывается, оболочка записывает проход как прерванный.
   */
  async runOnce(signal?: AbortSignal): Promise<number> {
    const env = getEnv();
    return await this.db.transaction(
      { userId: null, roles: ['system'], traceId: `partitions-${randomUUID()}` },
      async (tx) => {
        signal?.throwIfAborted();
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
  }

  /**
   * Уборка реестра отозванных токенов (M038).
   *
   * Запись о токене, который и так истёк, ни на что не влияет: срок проверяется
   * раньше. Реестр обязан оставаться маленьким — на этом построена дешевизна
   * проверки отзыва снимком, а не запросом на каждый вызов API.
   */
  async purgeRevocations(signal?: AbortSignal): Promise<number> {
    const removed = await this.revocations.purgeExpired(signal);
    if (removed > 0) this.logger.log(`убрано записей об истёкших токенах: ${removed}`);
    return removed;
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
  async purgeVerificationTokens(signal?: AbortSignal): Promise<number> {
    const removed = await this.db.asServiceRole(
      'app_maintenance',
      { traceId: `verification-purge-${randomUUID()}` },
      async (tx) => {
        signal?.throwIfAborted();
        const { rowCount } = await tx.query(
          `DELETE FROM identity.verification_tokens
            WHERE expires_at < now() - interval '7 days' OR used_at < now() - interval '7 days'`,
        );
        return rowCount ?? 0;
      },
    );
    if (removed > 0) this.logger.log(`убрано отработавших ссылок подтверждения: ${removed}`);
    return removed;
  }

  /**
   * Уборка брошенных билетов на загрузку (остаток SEC-14).
   *
   * Ошибка уборки не роняет процесс: обслуживание — фоновая работа, и
   * недоступное хранилище не повод не обслуживать запросы. Но и молчать о ней
   * нельзя: мусор копится незаметно.
   */
  async purgeAbandonedUploads(signal?: AbortSignal): Promise<number> {
    return await this.storageJanitor.purgeAbandonedUploads(signal);
  }
}
