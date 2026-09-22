import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { connect, headers as natsHeaders, type JetStreamClient, type NatsConnection } from 'nats';
import { EVENT_STREAM } from '@unicorn/contracts';
import { getEnv } from '../config/env';

/**
 * Подключение к NATS JetStream.
 *
 * JetStream, а не обычный NATS, выбран не за буквы в названии: обычная
 * публикация — это «отправил и забыл», и потерянное событие о вступившем в силу
 * договоре никто не заметит. JetStream подтверждает запись в стрим, и только
 * подтверждённая публикация даёт право пометить событие опубликованным в
 * outbox.
 *
 * Подключение ленивое: без `NATS_URL` контур публикации выключен, события
 * копятся в outbox — это штатное промежуточное состояние, а не сбой.
 */
@Injectable()
export class NatsClient implements OnModuleDestroy {
  private readonly logger = new Logger(NatsClient.name);
  private connection: NatsConnection | null = null;
  private jetstream: JetStreamClient | null = null;
  private connecting: Promise<void> | null = null;

  get enabled(): boolean {
    return getEnv().NATS_URL.length > 0;
  }

  /** Публикация с подтверждением. Возвращает порядковый номер в стриме. */
  async publish(
    subject: string,
    payload: Record<string, unknown>,
    options: { messageId: string; messageKey: string },
  ): Promise<number> {
    const js = await this.ensureJetStream();
    const hdrs = natsHeaders();
    // Ключ агрегата в заголовке: потребитель по нему восстанавливает порядок,
    // не разбирая полезную нагрузку.
    hdrs.append('Unicorn-Aggregate-Key', options.messageKey);

    const ack = await js.publish(subject, Buffer.from(JSON.stringify(payload), 'utf8'), {
      // Дедупликация на стороне стрима: повторная публикация того же события
      // при ретрае не создаёт второго сообщения у потребителя.
      msgID: options.messageId,
      headers: hdrs,
      timeout: 5_000,
    });
    return Number(ack.seq);
  }

  private async ensureJetStream(): Promise<JetStreamClient> {
    if (this.jetstream) return this.jetstream;
    // Параллельные вызовы не должны открывать несколько соединений.
    this.connecting ??= this.openConnection();
    await this.connecting;
    if (!this.jetstream) throw new Error('JetStream недоступен');
    return this.jetstream;
  }

  private async openConnection(): Promise<void> {
    const env = getEnv();
    if (!env.NATS_URL) throw new Error('NATS_URL не задан: публикация событий выключена');

    try {
      this.connection = await connect({
        servers: env.NATS_URL,
        name: 'unicorn-launch-core',
        // Пароль передаётся параметром, а не частью адреса: в URL он утёк бы
        // в логи подключения и в текст ошибок.
        ...(env.NATS_USER ? { user: env.NATS_USER, pass: env.NATS_PASSWORD } : {}),
        // Без таймаута старт приложения зависал бы при недоступном брокере.
        timeout: 5_000,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2_000,
      });
      this.jetstream = this.connection.jetstream();
      this.logger.log({ msg: 'подключение к NATS установлено', stream: EVENT_STREAM });

      void this.watchStatus(this.connection);
    } catch (error) {
      // Сбрасываем обещание: следующая попытка публикации переподключится, а не
      // будет вечно ждать результата первой неудачи.
      this.connecting = null;
      throw error;
    }
  }

  /**
   * Проверка того, что стрим существует и принимает наши предметы.
   *
   * Создавать стрим ядро НЕ вправе: право на управление стримом — это и право
   * его удалить вместе со всей историей событий, и такое право у приложения,
   * которое только публикует, не нужно. Но и молчать нельзя: пока стрима не
   * было, публикация копилась в outbox с ошибкой 503, и обнаружилось это лишь
   * в сквозном прогоне — 189 неопубликованных событий.
   *
   * Поэтому проверка на чтение: стрим есть — записываем в лог его состояние,
   * стрима нет — громкое предупреждение с именем команды, которая его создаёт.
   * Возвращает `null`, если контур публикации выключен или брокер недоступен.
   */
  async streamStatus(): Promise<{ stream: string; messages: number; subjects: string[] } | null> {
    if (!this.enabled) return null;
    try {
      const js = await this.ensureJetStream();
      const info = await js.jetstreamManager().then((jsm) => jsm.streams.info(EVENT_STREAM));
      return {
        stream: info.config.name,
        messages: Number(info.state.messages),
        subjects: info.config.subjects ?? [],
      };
    } catch (error) {
      this.logger.error({
        msg:
          `стрим ${EVENT_STREAM} недоступен: события будут копиться в outbox. ` +
          'Создать стрим: node scripts/nats-init-stream.mjs',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async watchStatus(connection: NatsConnection): Promise<void> {
    // Наблюдение за состоянием — бесконечный цикл по потоку событий
    // подключения. Когда брокер уходит (перезапуск, гибернация машины),
    // поток обрывается ошибкой; без перехвата это необработанное отклонение,
    // то есть падение всего ядра из-за наблюдателя за логом.
    try {
      for await (const status of connection.status()) {
        this.logger.warn({ msg: 'состояние подключения NATS', type: status.type });
      }
    } catch (error) {
      this.logger.warn({
        msg: 'наблюдение за состоянием NATS прервано',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connection) {
      // drain дожидается отправки того, что уже принято в работу.
      await this.connection.drain().catch(() => undefined);
      this.connection = null;
      this.jetstream = null;
      this.connecting = null;
    }
  }
}
