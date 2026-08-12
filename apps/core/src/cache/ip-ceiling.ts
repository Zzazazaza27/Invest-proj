import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import { getEnv } from '../config/env';

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

/**
 * Счёт и срок жизни ОДНОЙ операцией.
 *
 * Раньше здесь стояли `INCR` и следом `EXPIRE` — два обращения к счётчику.
 * Между ними есть окно: обрыв соединения, перезапуск процесса или падение
 * Redis после первого и до второго оставляют ключ БЕЗ СРОКА. Такой ключ не
 * истекает никогда, счётчик продолжает расти, и адрес получает 429 бессрочно —
 * то есть промах в служебном коде превращается в вечную блокировку живого
 * пользователя (SEC-11).
 *
 * Скрипт выполняется целиком и атомарно. Срок ставится не «первому запросу
 * окна», а любому запросу, увидевшему ключ без срока: это ещё и чинит ключи,
 * уже осиротевшие по прежней схеме, без ручной уборки.
 *
 * Возвращается и остаток срока — иначе `retry-after` требовал бы третьего
 * обращения, которое может увидеть уже другое состояние.
 */
const CEILING_SCRIPT = `
local used = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { used, ttl }
`;

export function registerIpCeiling(app: FastifyInstance, redis: Redis | null): void {
  const env = getEnv();
  if (!redis) return;

  const windowSeconds = 60;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Проверки живости не участвуют: их зовёт оркестратор, а не клиент, и
    // упереться в потолок из-за собственных проб было бы отказом себе же.
    if (request.url === '/v1/health') return;

    const key = `ip-ceiling:${request.ip}`;
    let used: number;
    let ttl: number;
    try {
      const [usedRaw, ttlRaw] = (await redis.eval(
        CEILING_SCRIPT,
        1,
        key,
        String(windowSeconds),
      )) as [number, number];
      used = Number(usedRaw);
      ttl = Number(ttlRaw);
    } catch {
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
