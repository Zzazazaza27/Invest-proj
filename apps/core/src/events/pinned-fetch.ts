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
    timeoutMs: number;
  },
): Promise<PinnedResponse> {
  const url = new URL(rawUrl);
  const pinned = options.allowedAddresses.find((address) => !isForbiddenAddress(address));
  if (!pinned) throw new Error('нет проверенного адреса для доставки');

  return new Promise<PinnedResponse>((resolve, reject) => {
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
        // внутренний адрес не должен обрабатываться.
        const remote = res.socket.remoteAddress ?? '';
        if (remote && isForbiddenAddress(remote.replace(/^::ffff:/, ''))) {
          res.destroy();
          reject(new Error(`соединение установлено с внутренним адресом ${remote}`));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          // Ответ получателя нам нужен только для журнала: читать мегабайты
          // чужого тела незачем, а неограниченное чтение — способ нас нагрузить.
          if (received <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8').slice(0, MAX_RESPONSE_BYTES),
          });
        });
      },
    );

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error('таймаут доставки'));
    });
    req.on('error', reject);
    req.write(options.body);
    req.end();
  });
}

const MAX_RESPONSE_BYTES = 8 * 1024;
