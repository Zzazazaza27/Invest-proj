import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getEnv } from '../config/env';
import { Database } from '../db/unit-of-work';

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

  constructor(private readonly db: Database) {}

  async onModuleInit(): Promise<void> {
    const env = getEnv();
    // Первый прогон — сразу: экземпляр, поднявшийся после долгого простоя,
    // не должен ждать полного интервала.
    await this.runOnce();

    this.timer = setInterval(() => {
      void this.runOnce();
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
}
