import type { FastifyRateLimitStore, FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { createRateLimitRedis } from './redis.client';

/**
 * Общие счётчики ограничений (4.8, D-008) — одно соединение с Valkey на процесс
 * и один контракт операций.
 *
 * Прежде потолок по IP, неудачные входы и письма подтверждения держали по
 * своему соединению и своей копии Lua, а `@fastify/rate-limit` вёл ключи своим
 * скриптом. Теперь все они ходят сюда, плагин — через адаптер `RateLimitStore`.
 *
 * Окно ФИКСИРОВАННОЕ: срок ставится первым увеличением и повторными не
 * продлевается — иначе постоянный поток запросов держал бы окно вечно, а
 * счётчик бы не обнулялся. Ключ без срока (например, после обрыва между INCR
 * и PEXPIRE в старых версиях) получает срок при следующем увеличении: без
 * этого он копился бы бесконечно и запирал адрес навсегда.
 *
 * Единица времени — миллисекунды, как у плагина: перевод в секунды делает
 * вызывающий там, где он нужен (Retry-After, настройки в секундах).
 *
 * Отказ. Ошибка соединения или таймаут команды — исключение. Что с ним
 * делать, решает вызывающий; тихо пропускать ограничение запрещено. Результат
 * неизвестен (команда могла выполниться) — повтора нет: клиент настроен без
 * повторной отправки, ожидание ограничено `REDIS_COMMAND_TIMEOUT_MS`.
 */

const HIT_SCRIPT = `
local used = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if used == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {used, ttl}
`;

export interface HitResult {
  /** Значение счётчика после увеличения. */
  used: number;
  /** Сколько осталось до конца окна, мс. */
  ttlMs: number;
}

export class Counters {
  private readonly logger = new Logger('Counters');
  private available = true;

  constructor(private readonly redis: Redis) {
    redis.defineCommand('counterHit', { numberOfKeys: 1, lua: HIT_SCRIPT });
    // Без слушателя `error` клиент печатает «Unhandled error event» на каждую
    // попытку переподключения. В журнал — только смена состояния: потеря и
    // возврат счётчика, а не поток одинаковых строк во время отказа.
    redis.on('error', (error: Error) => {
      if (!this.available) return;
      this.available = false;
      this.logger.error({
        msg: 'счётчики ограничений недоступны',
        // У ошибки подключения (AggregateError) сообщение пустое — берём код.
        error: error.message || (error as Error & { code?: string }).code || error.name,
      });
    });
    redis.on('ready', () => {
      if (this.available) return;
      this.available = true;
      this.logger.log({ msg: 'счётчики ограничений снова доступны' });
    });
  }

  /** Атомарно увеличить счётчик в фиксированном окне. */
  async hit(key: string, windowMs: number): Promise<HitResult> {
    const client = this.redis as Redis & {
      counterHit(key: string, windowMs: string): Promise<[number, number]>;
    };
    const [used, ttl] = await client.counterHit(key, String(Math.trunc(windowMs)));
    return { used: Number(used), ttlMs: Number(ttl) };
  }

  /** Текущее значение; нет ключа — ноль. */
  async read(key: string): Promise<number> {
    const raw = await this.redis.get(key);
    return raw === null ? 0 : Number(raw);
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /** Готовность (служебный порт `/ready`): ответ PING в пределах ожидания. */
  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

let shared: Counters | null | undefined;

/**
 * Счётчики процесса. `null` — счётчик не настроен (локальный контур без
 * Valkey): вызывающие тогда ведут себя как прежде без Redis. В production
 * адрес обязателен — это проверяет конфигурация.
 */
export function getCounters(): Counters | null {
  if (shared === undefined) {
    const redis = createRateLimitRedis();
    shared = redis ? new Counters(redis) : null;
  }
  return shared;
}

/**
 * Хранилище для `@fastify/rate-limit` поверх общего контракта.
 *
 * Плагин передаёт окно в мс и ждёт срок в мс — те же единицы, что у `hit`.
 * Ключи: общий префикс `rl:`; для маршрутов со своим лимитом `child` добавляет
 * метод и путь, как встроенное хранилище, — лимиты разных маршрутов не делят
 * один счётчик. `continueExceeding` и `exponentialBackoff` не поддерживаются:
 * они продлевали бы окно, а окно у нас фиксированное.
 */
export function rateLimitStoreFor(counters: Counters): FastifyRateLimitStoreCtor {
  return class RateLimitStore implements FastifyRateLimitStore {
    private readonly prefix: string;

    constructor(
      options: { continueExceeding?: boolean; exponentialBackoff?: boolean },
      prefix = 'rl:',
    ) {
      if (options.continueExceeding || options.exponentialBackoff) {
        throw new Error('continueExceeding/exponentialBackoff несовместимы с фиксированным окном');
      }
      this.prefix = prefix;
    }

    incr(
      key: string,
      cb: (error: Error | null, result?: { current: number; ttl: number }) => void,
      // Плагин передаёт окно (мс) третьим аргументом; его типы этого не
      // отражают. Без окна считать нельзя — отказ, а не окно по умолчанию.
      timeWindow?: number,
    ): void {
      if (typeof timeWindow !== 'number') {
        cb(new Error('хранилище ограничений: плагин не передал окно'));
        return;
      }
      counters.hit(this.prefix + key, timeWindow).then(
        ({ used, ttlMs }) => cb(null, { current: used, ttl: ttlMs }),
        (error: unknown) => {
          // Отказ счётчика — 503 «зависимость недоступна», а не 500 и не
          // пропуск мимо лимита (`skipOnError: false`).
          const reason = error instanceof Error ? error.message : String(error);
          const failure = new Error(`счётчик ограничений недоступен: ${reason}`) as Error & {
            statusCode: number;
          };
          failure.statusCode = 503;
          cb(failure);
        },
      );
    }

    child(routeOptions: Parameters<FastifyRateLimitStore['child']>[0]): FastifyRateLimitStore {
      // В рантайме плагин передаёт объединённые параметры маршрута с
      // `routeInfo`; в его типах этого поля нет.
      const merged = routeOptions as unknown as {
        continueExceeding?: boolean;
        exponentialBackoff?: boolean;
        routeInfo: { method: string; url: string };
      };
      return new RateLimitStore(
        merged,
        `${this.prefix}${merged.routeInfo.method}${merged.routeInfo.url}:`,
      );
    }
  };
}
