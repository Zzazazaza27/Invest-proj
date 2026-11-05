import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { errors } from '../common/errors';

/**
 * Клиент OpenBao Transit: только шифрование, расшифровка и HMAC.
 *
 * Токен кладёт в файл Agent и сам его продлевает, поэтому файл читается на каждый вызов. Отказ
 * OpenBao становится отказом затронутой операции. Перехода к ключам из окружения здесь нет.
 */
export interface TransitConfig {
  addr: string;
  caFile: string;
  tokenFile: string;
  timeoutMs: number;
}

interface Answer {
  status: number;
  data: Record<string, unknown>;
}

const KMS = 'kms';

export class TransitClient {
  private agent: Promise<Agent> | null = null;

  constructor(private readonly config: TransitConfig) {}

  async encrypt(key: string, plaintext: Buffer, aad: string, keyVersion?: number): Promise<string> {
    const answer = await this.call(`transit/encrypt/${key}`, {
      plaintext: plaintext.toString('base64'),
      associated_data: base64(aad),
      ...(keyVersion === undefined ? {} : { key_version: keyVersion }),
    });
    const text = answer.data['ciphertext'];
    if (typeof text !== 'string') throw errors.upstreamUnavailable(KMS);
    return text;
  }

  async decrypt(key: string, ciphertext: string, aad: string): Promise<Buffer> {
    const answer = await this.call(`transit/decrypt/${key}`, {
      ciphertext,
      associated_data: base64(aad),
    });
    const text = answer.data['plaintext'];
    if (typeof text !== 'string') throw errors.upstreamUnavailable(KMS);
    return Buffer.from(text, 'base64');
  }

  /** Версия задана явно: новая версия ключа не должна молча менять значения поиска. */
  async hmac(key: string, input: string, keyVersion: number): Promise<Buffer> {
    const answer = await this.call(`transit/hmac/${key}/sha2-256`, {
      input: base64(input),
      key_version: keyVersion,
    });
    const text = answer.data['hmac'];
    const match = typeof text === 'string' ? /^vault:v(\d+):(.+)$/.exec(text) : null;
    if (!match || Number(match[1]) !== keyVersion) throw errors.upstreamUnavailable(KMS);
    const digest = Buffer.from(match[2]!, 'base64');
    if (digest.length !== 32) throw errors.upstreamUnavailable(KMS);
    return digest;
  }

  private async call(path: string, body: Record<string, unknown>): Promise<Answer> {
    let answer: Answer;
    try {
      answer = await this.post(path, body, await this.token());
    } catch (cause) {
      throw Object.assign(errors.upstreamUnavailable(KMS), { cause });
    }
    // 400 — это сами данные: чужой AAD, порванный тег, удалённая версия ключа. Остальное — отказ
    // службы: повтор может помочь, а данные при этом целы.
    if (answer.status === 400) throw new Error('повреждённые данные: Transit отказал');
    if (answer.status >= 300) throw errors.upstreamUnavailable(KMS);
    return answer;
  }

  private async token(): Promise<string> {
    return (await readFile(this.config.tokenFile, 'utf8')).trim();
  }

  private tls(): Promise<Agent> {
    this.agent ??= readFile(this.config.caFile).then(
      (ca) => new Agent({ ca, keepAlive: true, servername: 'localhost' }),
    );
    return this.agent;
  }

  private async post(path: string, body: Record<string, unknown>, token: string): Promise<Answer> {
    const url = new URL(`/v1/${path}`, this.config.addr);
    const secure = url.protocol === 'https:';
    const agent = secure ? await this.tls() : undefined;
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const send = secure ? httpsRequest : httpRequest;
      const req = send(
        url,
        {
          method: 'POST',
          ...(agent ? { agent } : {}),
          headers: { 'Content-Type': 'application/json', 'X-Vault-Token': token },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, data: dataOf(text) });
          });
        },
      );
      req.on('error', reject);
      // Внешний вызов без таймаута подвесил бы запрос при недоступном OpenBao.
      req.setTimeout(this.config.timeoutMs, () => req.destroy(new Error('таймаут Transit')));
      req.end(payload);
    });
  }
}

function dataOf(text: string): Record<string, unknown> {
  try {
    return (JSON.parse(text) as { data?: Record<string, unknown> }).data ?? {};
  } catch {
    return {};
  }
}

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}
