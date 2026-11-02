import { Injectable, Logger } from '@nestjs/common';
import { getCounters, type Counters } from '../cache/counters';
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
 * Ключ — хеш blind-индекса контакта, значение адреса в счётчик не попадает.
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
  private readonly counters: Counters | null;

  constructor() {
    this.counters = getCounters();
  }

  /**
   * Учесть запрос письма и сказать, можно ли его отправлять.
   *
   * Счётчик не настроен (dev без Valkey) — отправляем: классовый лимит остаётся,
   * и превращать отсутствие необязательной инфраструктуры в неработающее
   * восстановление пароля незачем. Настроенный, но упавший счётчик — отказ:
   * fail-closed, как у остальных счётчиков.
   */
  async allow(indexHex: string): Promise<boolean> {
    if (!this.counters) return true;
    let used: number;
    try {
      ({ used } = await this.counters.hit(
        `verify-mail:${indexHex}`,
        getEnv().VERIFY_MAIL_WINDOW_SEC * 1_000,
      ));
    } catch (error) {
      this.logger.error({
        msg: 'счётчик писем подтверждения недоступен',
        error,
      });
      throw errors.upstreamUnavailable('mail_throttle');
    }
    return used <= getEnv().RATE_LIMIT_VERIFY_MAIL_PER_CONTACT;
  }
}
