import { Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { createRateLimitRedis } from '../cache/redis.client';
import { getEnv } from '../config/env';
import { errors } from '../common/errors';

/**
 * Троттлинг перебора пароля НА АККАУНТ.
 *
 * Классовый rate-limit и потолок по адресу считают по IP: распределённый
 * перебор с ботнета (по 30/мин с тысяч адресов) их не задевает, а стоимость
 * argon2 — единственный оставшийся барьер — платит защищающийся, не атакующий
 * (MEDIUM внешнего аудита №2). Здесь счётчик привязан к КОНТАКТУ (по его
 * blind-индексу, не по значению), поэтому смена адреса его не сбрасывает.
 *
 * Порядок в verifyPassword: сначала `assertNotLocked` — при превышении вход
 * отклоняется ДО argon2, что заодно снимает CPU-DoS-усиление. Затем обычная
 * проверка; при неудаче — `recordFailure`, при успехе — `reset`.
 *
 * Ключ — только хеш индекса, значение контакта в Redis не попадает. Сам факт
 * «есть счётчик для этого хеша» не выдаёт существование аккаунта: счётчик
 * заводится и для несуществующих контактов (иначе таймингом отличили бы
 * «залочен» от «нет такого»), поэтому anti-enumeration не ломается.
 *
 * Fail-closed при СБОЕ настроенного Redis (как ip-ceiling и rate-limit); если
 * Redis не настроен вовсе (dev), троттлинг выключен — классовые лимиты
 * остаются.
 */
@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);
  private readonly redis: Redis | null;

  // INCR + установка срока одной атомарной операцией: два обращения оставляли
  // бы ключ без срока при обрыве между ними — вечная блокировка аккаунта
  // (та же грабля, что закрыта в ip-ceiling, SEC-11).
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

  private key(indexHex: string): string {
    return `login-fail:${indexHex}`;
  }

  /** Отклонить вход до проверки пароля, если аккаунт превысил порог неудач. */
  async assertNotLocked(indexHex: string): Promise<void> {
    if (!this.redis) return;
    let used: number;
    try {
      const raw = await this.redis.get(this.key(indexHex));
      used = raw === null ? 0 : Number(raw);
    } catch (error) {
      this.logger.error({
        msg: 'счётчик неудачных входов недоступен',
        error: error instanceof Error ? error.message : 'unknown',
      });
      // Fail-closed: недоступный счётчик — отказ, а не снятие защиты.
      throw errors.upstreamUnavailable('login_throttle');
    }
    if (used >= getEnv().RATE_LIMIT_LOGIN_FAIL_PER_ACCOUNT) {
      // Наружу — тот же generic-отказ, что и «неверные данные»: 429 с
      // указанием аккаунта выдавал бы существование учётки.
      throw errors.unauthenticated({ stage: 'bad-credentials' });
    }
  }

  /** Учесть неудачную попытку входа для контакта. */
  async recordFailure(indexHex: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.eval(
        LoginThrottleService.INCR_SCRIPT,
        1,
        this.key(indexHex),
        String(getEnv().LOGIN_THROTTLE_WINDOW_SEC),
      );
    } catch (error) {
      // Неудача учёта не должна блокировать ответ пользователю: вход и так
      // уже отклонён. Просто фиксируем в лог.
      this.logger.warn({
        msg: 'не удалось учесть неудачный вход',
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  /** Сбросить счётчик после успешного входа. */
  async reset(indexHex: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(this.key(indexHex));
    } catch {
      // Несброшенный счётчик истечёт сам по TTL — не критично.
    }
  }
}
