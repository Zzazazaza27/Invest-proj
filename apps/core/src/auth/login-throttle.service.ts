import { Injectable, Logger } from '@nestjs/common';
import { getCounters, type Counters } from '../cache/counters';
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
 * Ключ — только хеш индекса, значение контакта в счётчик не попадает. Сам факт
 * «есть счётчик для этого хеша» не выдаёт существование аккаунта: счётчик
 * заводится и для несуществующих контактов (иначе таймингом отличили бы
 * «залочен» от «нет такого»), поэтому anti-enumeration не ломается.
 *
 * Fail-closed при СБОЕ настроенного счётчика (как ip-ceiling и rate-limit);
 * если счётчик не настроен вовсе (dev), троттлинг выключен — классовые лимиты
 * остаются. Счёт и окно — общий модуль `cache/counters` (4.8).
 */
@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);
  private readonly counters: Counters | null;

  constructor() {
    this.counters = getCounters();
  }

  private key(indexHex: string): string {
    return `login-fail:${indexHex}`;
  }

  /** Отклонить вход до проверки пароля, если аккаунт превысил порог неудач. */
  async assertNotLocked(indexHex: string): Promise<void> {
    if (!this.counters) return;
    let used: number;
    try {
      used = await this.counters.read(this.key(indexHex));
    } catch (error) {
      this.logger.error({
        msg: 'счётчик неудачных входов недоступен',
        error,
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
    if (!this.counters) return;
    try {
      await this.counters.hit(this.key(indexHex), getEnv().LOGIN_THROTTLE_WINDOW_SEC * 1_000);
    } catch (error) {
      // Вход и так уже отклонён — ответ пользователю не меняем. Но пропуск
      // учёта не молчаливый: попытка не засчитана, и это видно в журнале.
      this.logger.warn({
        msg: 'пропущенный учёт неудачного входа',
        key: this.key(indexHex),
        error,
      });
    }
  }

  /** Сбросить счётчик после успешного входа. */
  async reset(indexHex: string): Promise<void> {
    if (!this.counters) return;
    try {
      await this.counters.reset(this.key(indexHex));
    } catch (error) {
      // Несброшенный счётчик истечёт сам по окну — вход не отменяем.
      this.logger.warn({
        msg: 'счётчик неудачных входов не сброшен',
        key: this.key(indexHex),
        error,
      });
    }
  }
}
