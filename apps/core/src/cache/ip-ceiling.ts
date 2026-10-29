import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getEnv } from '../config/env';
import type { Counters } from './counters';

/**
 * Потолок частоты по АДРЕСУ поверх классовых вёдер.
 *
 * Зачем нужен отдельно от `@fastify/rate-limit`. Ключ ведра для
 * аутентифицированных классов — пара «адрес + подсказка сессии из cookie», а
 * подсказка читается ДО проверки подписи: клиент волен подставить произвольный
 * `sub` и получить новое ведро на каждый запрос. Полностью это закрыть ключом
 * по адресу нельзя — денежный лимит 10/мин, общий на адрес, наказывал бы
 * нескольких реальных пользователей за одним NAT (проверено живым прогоном).
 * Размен был назван и принят, но остаточный обход оставался: подделкой cookie
 * можно было слать сколько угодно запросов к денежным и админским маршрутам.
 *
 * Потолок закрывает именно остаток. Он считает ВСЕ запросы с адреса в одно
 * ведро, независимо от cookie и класса, и порог у него намеренно высокий: он
 * не заменяет классовые лимиты, а ограничивает суммарный шторм с одного
 * адреса. Подделка cookie перестаёт давать неограниченное число попыток.
 *
 * Почему свой счётчик, а не второй экземпляр плагина: плагин ограничения
 * частоты регистрируется один раз на приложение, и два глобальных набора
 * настроек одновременно он не поддерживает.
 *
 * Fail-closed: недоступный счётчик означает отказ, а не снятие потолка — та же
 * сторона размена, что и у `skipOnError: false` у классовых вёдер.
 */

/*
 * Счёт и срок — одной атомарной операцией общего модуля `cache/counters`.
 * Раньше здесь стояли `INCR` и следом `EXPIRE`: обрыв между ними оставлял ключ
 * БЕЗ СРОКА, и адрес получал 429 бессрочно (SEC-11). Ключ без срока теперь
 * получает срок при следующем увеличении. Остаток срока возвращается тем же
 * вызовом — `retry-after` не требует третьего обращения.
 */

export function registerIpCeiling(app: FastifyInstance, counters: Counters | null): void {
  const env = getEnv();
  if (!counters) return;

  const windowSeconds = 60;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Проверки живости не участвуют: их зовёт оркестратор, а не клиент, и
    // упереться в потолок из-за собственных проб было бы отказом себе же.
    if (request.url === '/v1/health') return;

    const key = `ip-ceiling:${request.ip}`;
    let used: number;
    let ttl: number;
    try {
      const hit = await counters.hit(key, windowSeconds * 1_000);
      used = hit.used;
      ttl = Math.ceil(hit.ttlMs / 1_000);
    } catch (error) {
      request.log.error({
        msg: 'потолок по адресу: счётчик недоступен, запрос отклонён',
        error: error instanceof Error ? error.message : 'unknown',
      });
      // Счётчик недоступен — отказ, а не проход мимо потолка.
      return reply.code(503).send({
        type: 'https://unicorn.vc/problems/dependency_unavailable',
        title: 'Сервис временно недоступен',
        status: 503,
        code: 'dependency_unavailable',
        detail: 'Повторите позже',
      });
    }

    if (used > env.RATE_LIMIT_IP_CEILING_PER_MIN) {
      const retryAfter = ttl > 0 ? ttl : windowSeconds;
      return reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send({
          type: 'https://unicorn.vc/problems/rate_limited',
          title: 'Слишком много запросов',
          status: 429,
          code: 'rate_limited',
          detail: `Повторите через ${retryAfter} с`,
        });
    }
    return undefined;
  });
}
