import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isForbiddenAddress } from './webhooks.service';

/**
 * HTTPS-запрос по ЗАРАНЕЕ ПРОВЕРЕННОМУ адресу.
 *
 * Зачем не `fetch`: проверка адреса и сам запрос разрешали имя РАЗДЕЛЬНО.
 * Между ними остаётся окно, в которое DNS отвечает другим адресом — приём
 * называется DNS rebinding: имя при проверке указывает наружу, а при доставке
 * уже на 127.0.0.1, во внутренний сервис или на адрес метаданных облака.
 * Никакая проверка «перед запросом» этого не закрывает, потому что запрос
 * спрашивает имя заново.
 *
 * Здесь соединение прибивается к адресу, который прошёл проверку: собственный
 * `lookup` возвращает именно его, и второго разрешения имени не происходит.
 * Имя при этом сохраняется в SNI и в заголовке Host — сертификат проверяется
 * по домену, а не по адресу, иначе TLS ломался бы на каждом получателе.
 *
 * Дополнительно адрес соединения перепроверяется после установления связи:
 * если он всё-таки оказался внутренним, ответ не читается вовсе.
 *
 * Перенаправления НЕ выполняются: `Location` на внутренний адрес — тот же обход
 * другим способом. 3xx возвращается вызывающему как обычный ответ.
 *
 * Время и объём ограничены ЖЁСТКО, а не «в среднем»:
 *
 * - `req.setTimeout` — таймаут БЕЗДЕЙСТВИЯ. Получатель, отдающий по байту чуть
 *   чаще, чем раз в `timeoutMs`, не срабатывает по нему никогда и держит поток
 *   доставки сколько захочет. Поэтому сверху стоит абсолютный дедлайн.
 * - Чтение сверх предела не просто выбрасывалось — соединение продолжало
 *   принимать данные, и получатель мог лить в нас сколько угодно. Теперь после
 *   превышения ответ обрывается.
 */
export interface PinnedResponse {
  status: number;
  body: string;
}

export async function postPinned(
  rawUrl: string,
  options: {
    /** Адреса, прошедшие проверку (assertPublicDestination). */
    allowedAddresses: readonly string[];
    headers: Record<string, string>;
    body: string;
    /** Таймаут бездействия: сколько ждём следующего байта. */
    timeoutMs: number;
    /** Абсолютный предел на всю доставку. По умолчанию — кратный таймауту. */
    deadlineMs?: number;
  },
): Promise<PinnedResponse> {
  const url = new URL(rawUrl);
  const pinned = options.allowedAddresses.find((address) => !isForbiddenAddress(address));
  if (!pinned) throw new Error('нет проверенного адреса для доставки');

  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    /** Дедлайн и таймер снимаются ровно один раз, чем бы ни кончился запрос. */
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };

    const req = httpsRequest(
      {
        protocol: 'https:',
        // Имя остаётся именем: по нему проверяется сертификат и его же видит
        // получатель в Host.
        host: url.hostname,
        servername: url.hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...options.headers, 'Content-Length': Buffer.byteLength(options.body) },
        // Ключевая часть: адрес не спрашивается у DNS повторно.
        lookup: (_hostname, opts, callback) => {
          const family = isIP(pinned);
          if (opts.all === true) {
            callback(null, [{ address: pinned, family }]);
            return;
          }
          callback(null, pinned, family);
        },
      },
      (res) => {
        // Проверка по факту соединения: даже при ошибке в собственном lookup
        // внутренний адрес не должен обрабатываться. Форма записи значения не
        // имеет — классификатор сводит `::ffff:7f00:1` и `127.0.0.1` к одному.
        const remote = res.socket.remoteAddress ?? '';
        if (remote && isForbiddenAddress(remote)) {
          res.destroy();
          finish(() => reject(new Error(`соединение установлено с внутренним адресом ${remote}`)));
          return;
        }
        void readCapped(res, () => req.destroy()).then((body) => {
          finish(() => resolve({ status: res.statusCode ?? 0, body }));
        });
      },
    );

    // Абсолютный предел на всю доставку. Он и есть настоящая гарантия: таймаут
    // бездействия ниже лишь обрывает молчащего получателя быстрее.
    const deadline = setTimeout(() => {
      req.destroy();
      finish(() => reject(new Error('превышен предельный срок доставки')));
    }, absoluteDeadlineMs(options));

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error('таймаут доставки'));
    });
    req.on('error', (error) => finish(() => reject(error)));
    req.write(options.body);
    req.end();
  });
}

/**
 * Прочитать ответ, оборвав его при превышении предела.
 *
 * Вынесено отдельной функцией не ради красоты: доставка по построению
 * отказывается соединяться с локальным адресом, поэтому предел тела нельзя
 * проверить живым прогоном на одной машине, не ослабив сам классификатор
 * адресов. Здесь логика принимает любой поток и потому проверяется напрямую —
 * ровно та, которую вызывает `postPinned`.
 *
 * `onOverflow` обрывает соединение. Без него предел ограничивал бы только то,
 * что мы ХРАНИМ, но не то, что нам успевают прислать.
 */
export function readCapped(
  stream: NodeJS.ReadableStream,
  onOverflow: () => void,
  limit: number = MAX_RESPONSE_BYTES,
): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;
    const settle = (): void => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8').slice(0, limit));
    };
    stream.on('data', (chunk: Buffer) => {
      if (done) return;
      received += chunk.length;
      if (received <= limit) {
        chunks.push(chunk);
        return;
      }
      onOverflow();
      settle();
    });
    stream.on('end', settle);
    // Оборванный поток тоже завершает чтение: иначе обещание висит вечно.
    stream.on('close', settle);
    stream.on('error', settle);
  });
}

const MAX_RESPONSE_BYTES = 8 * 1024;

/**
 * Во сколько раз абсолютный дедлайн больше таймаута бездействия.
 *
 * Ответ, приходящий частями, законно длиннее одной паузы — но не втрое. Так
 * медленный получатель ещё успевает, а «струя по байту» уже нет.
 */
const ABSOLUTE_DEADLINE_FACTOR = 3;

/** Предельный срок всей доставки: явный, либо кратный таймауту бездействия. */
export function absoluteDeadlineMs(options: { timeoutMs: number; deadlineMs?: number }): number {
  return options.deadlineMs ?? options.timeoutMs * ABSOLUTE_DEADLINE_FACTOR;
}
