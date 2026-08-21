import { Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { createRateLimitRedis } from '../cache/redis.client';
import { getEnv } from '../config/env';
import { errors } from '../common/errors';

/**
 * Ограничение числа писем подтверждения НА КОНТАКТ.
 *
 * Отдельно от троттлинга входа (`LoginThrottleService`), потому что защищает
 * от другого: тот считает неудачные попытки угадать пароль, этот — количество
 * писем, отправленных на один адрес. Классовый rate-limit не закрывает ни то,
 * ни другое: он считает по адресу запрашивающего, а «залить чужой ящик
 * письмами со сброса пароля» делается с тысячи адресов по одному запросу.
 *
 * Ключ — хеш blind-индекса контакта, значение адреса в Redis не попадает.
 * Счётчик заводится и для НЕСУЩЕСТВУЮЩИХ контактов: иначе разница «счётчик
 * есть / счётчика нет» отличала бы зарегистрированный адрес от чужого, а весь
 * смысл ответа 202 в том, что отличить нельзя.
 *
 * Превышение — тоже 202. Отказ 429 сообщал бы отправителю, что по этому адресу
 * что-то происходит; здесь письмо просто не отправляется.
 */
@Injectable()
export class MailThrottleService {
  private readonly logger = new Logger(MailThrottleService.name);
  private readonly redis: Redis | null;

  // INCR и срок жизни — одной атомарной операцией. Два обращения оставляют
  // ключ без срока при обрыве между ними, и адрес блокируется навсегда (та же
  // грабля, что закрыта в ip-ceiling, SEC-11).
  private static readonly INCR_SCRIPT = `
local used = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return used
`;

  constructor() {
    this.redis = createRateLimitRedis();
  }

  /**
   * Учесть запрос письма и сказать, можно ли его отправлять.
   *
   * Счётчик не настроен (dev без Redis) — отправляем: классовый лимит остаётся,
   * и превращать отсутствие необязательной инфраструктуры в неработающее
   * восстановление пароля незачем. Настроенный, но упавший Redis — отказ:
   * fail-closed, как у остальных счётчиков.
   */
  async allow(indexHex: string): Promise<boolean> {
    if (!this.redis) return true;
    let used: number;
    try {
      used = (await this.redis.eval(
        MailThrottleService.INCR_SCRIPT,
        1,
        `verify-mail:${indexHex}`,
        String(getEnv().VERIFY_MAIL_WINDOW_SEC),
      )) as number;
    } catch (error) {
      this.logger.error({
        msg: 'счётчик писем подтверждения недоступен',
        error: error instanceof Error ? error.message : 'unknown',
      });
      throw errors.upstreamUnavailable('mail_throttle');
    }
    return used <= getEnv().RATE_LIMIT_VERIFY_MAIL_PER_CONTACT;
  }
}
