import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { errors } from '../common/errors';
import { getEnv } from '../config/env';
import { SmtpError, assertUsable, smtpDeliver, type SmtpTarget } from './smtp.client';

/**
 * Порт отправки почты.
 *
 * Три реализации: `none` (канала нет — маршруты отвечают 503), `file` (письмо
 * кладётся файлом; стенд и прогоны) и `smtp` (настоящая доставка через
 * smarthost). Вызывающий код о выборе не знает.
 *
 * Токен НИКОГДА не попадает в очередь уведомлений `comms.notifications`.
 * Соблазн велик — очередь уже есть, — но её содержимое читает и сам
 * пользователь (`GET /v1/notifications`), и роль доставки, и админ базы. Ссылка
 * на смену пароля, положенная в такую таблицу, превращает любое чтение в
 * захват аккаунта. Поэтому секрет живёт ровно в одном месте: в письме.
 */
export interface MailMessage {
  to: string;
  subject: string;
  /** Только текст. HTML-письмо — это ещё и XSS-поверхность в почтовом клиенте. */
  text: string;
}

export abstract class MailTransport {
  /** Отправить письмо. Бросает, если канал не настроен. */
  abstract send(message: MailMessage): Promise<void>;
  /** Настроен ли канал. Маршруты отвечают 503, когда нет. */
  abstract get available(): boolean;
}

/**
 * Транспорта нет.
 *
 * Не «тихо ничего не делает»: попытка отправить письмо — ошибка конфигурации,
 * и маршрут обязан ответить отказом, а не изобразить успех. Молчаливая
 * заглушка означала бы, что человек ждёт письма, которого никто не отправлял.
 */
@Injectable()
export class NullMailTransport extends MailTransport {
  get available(): boolean {
    return false;
  }

  send(): Promise<void> {
    throw errors.featureDisabled('mail');
  }
}

/**
 * Письмо кладётся файлом.
 *
 * Это НЕ доставка, а способ пройти сценарий целиком там, где почтового сервера
 * нет: на стенде и в прогонах. В production запрещено конфигурацией
 * (`MAIL_TRANSPORT=file` не проходит валидацию) — ссылка на смену пароля,
 * записанная на диск сервера, это утечка, а не письмо.
 *
 * Имя файла содержит момент и адрес получателя в безопасной для файловой
 * системы форме: прогону нужно найти СВОЁ письмо среди чужих.
 */
@Injectable()
export class FileMailTransport extends MailTransport {
  private readonly logger = new Logger(FileMailTransport.name);

  get available(): boolean {
    return true;
  }

  async send(message: MailMessage): Promise<void> {
    const env = getEnv();
    const dir = isAbsolute(env.MAIL_OUTBOX_DIR)
      ? env.MAIL_OUTBOX_DIR
      : join(process.cwd(), env.MAIL_OUTBOX_DIR);
    mkdirSync(dir, { recursive: true });

    // Имя файла собирается ТОЛЬКО из разрешённых символов. Адрес получателя
    // приходит из запроса, и подстановка его в путь как есть — это обход
    // каталога: `../../.env` вместо адреса переписал бы файл конфигурации.
    const safeTo = message.to.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 64);
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeTo}.eml`;

    const body = [
      `From: ${env.MAIL_FROM}`,
      `To: ${message.to}`,
      `Subject: ${env.MAIL_SUBJECT_PREFIX}${message.subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      message.text,
      '',
    ].join('\n');

    writeFileSync(join(dir, name), body, { encoding: 'utf8', mode: 0o600 });
    // В лог — ФАКТ отправки и получатель в маскированном виде, но не тело:
    // тело содержит токен, а логи читает больше людей, чем почтовый ящик.
    this.logger.log({ msg: 'письмо записано файлом', file: name });
  }
}

/**
 * Настоящая отправка через SMTP-релей.
 *
 * Своего почтового сервера у платформы нет и на текущем ВПС быть не может:
 * исходящие 25, 465 и 587 закрыты провайдером ко всем проверенным MX (проверено
 * с сервера 2026-08-24 с позитивным контролем на `github.com:443`). Открыт
 * только 2525 — порт, который держат почтовые провайдеры именно для такого
 * случая. Поэтому единственная работающая схема здесь — smarthost: письмо
 * отдаётся провайдеру с аутентификацией, а он доставляет его дальше от своего
 * имени и со своей репутацией.
 *
 * Тело письма — только текст, в base64. Base64 выбран не ради экономии: он
 * снимает сразу три класса ошибок кодирования — обрыв кириллицы на границе
 * строки, превышение предела длины строки RFC 5322 и любые совпадения с
 * терминатором DATA.
 */
@Injectable()
export class SmtpMailTransport extends MailTransport {
  private readonly logger = new Logger(SmtpMailTransport.name);

  constructor() {
    super();
    // Неверная настройка обязана падать на старте, а не на первом письме,
    // которое кто-то будет ждать.
    assertUsable(this.target());
  }

  get available(): boolean {
    return true;
  }

  private target(): SmtpTarget {
    const env = getEnv();
    return {
      host: env.MAIL_SMTP_HOST,
      port: env.MAIL_SMTP_PORT,
      security: env.MAIL_SMTP_SECURITY,
      user: env.MAIL_SMTP_USER,
      password: env.MAIL_SMTP_PASSWORD,
      ehloName: env.MAIL_SMTP_EHLO_NAME || domainOf(env.MAIL_FROM),
      timeoutMs: env.MAIL_SMTP_TIMEOUT_MS,
    };
  }

  async send(message: MailMessage): Promise<void> {
    const env = getEnv();
    const target = this.target();
    const data = buildMessage({
      from: env.MAIL_FROM,
      to: message.to,
      subject: `${env.MAIL_SUBJECT_PREFIX}${message.subject}`,
      text: message.text,
    });

    try {
      await smtpDeliver(target, { from: env.MAIL_FROM, to: message.to, data });
    } catch (error) {
      // Наружу — generic-отказ: подробности релея (кто он, что ответил на
      // вход) не дело того, кто нажал «восстановить пароль».
      this.logger.error({
        msg: 'письмо не ушло',
        stage: error instanceof SmtpError ? error.stage : 'unknown',
        code: error instanceof SmtpError ? error.code : null,
        relay: `${target.host}:${target.port}`,
      });
      // Отказ релея — это недоступная зависимость, а не выключенная функция:
      // повтор через минуту имеет смысл, и клиент обязан их различать.
      throw errors.upstreamUnavailable('mail');
    }
    // Ни адреса целиком, ни темы, ни тела: тема письма восстановления пароля
    // сама по себе говорит, что у этого человека сейчас живая ссылка на смену.
    this.logger.log({ msg: 'письмо отправлено', relay: `${target.host}:${target.port}` });
  }
}

/** Домен из адреса — им клиент представляется в EHLO, если имя не задано. */
function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  const domain = at === -1 ? '' : address.slice(at + 1).trim();
  return /^[a-zA-Z0-9.-]+$/.test(domain) && domain.length > 0 ? domain : 'localhost';
}

/**
 * Сборка письма RFC 5322.
 *
 * Заголовки собираются здесь, а не в вызывающем коде, и здесь же проверяются:
 * перевод строки, попавший в тему или в адрес, дописывает СВОЙ заголовок —
 * скрытую копию, другого получателя, собственный `Content-Type`. Тема
 * приходит из кода, адрес — из базы, но транспорт не обязан верить ни тому,
 * ни другому.
 */
export function buildMessage(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
}): string {
  for (const [field, value] of [
    ['from', input.from],
    ['to', input.to],
    ['subject', input.subject],
  ] as const) {
    if (/[\r\n\0]/.test(value)) {
      throw errors.validation([{ path: field, message: 'перевод строки в заголовке письма' }]);
    }
  }

  const body = Buffer.from(input.text, 'utf8').toString('base64');
  const wrapped = body.replace(/(.{76})/g, '$1\r\n');

  return (
    [
      `From: ${input.from}`,
      `To: ${input.to}`,
      `Subject: ${encodeHeader(input.subject)}`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <${randomUUID()}@${domainOf(input.from)}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      'Auto-Submitted: auto-generated',
      '',
      wrapped,
    ].join('\r\n') + '\r\n'
  );
}

/**
 * Заголовок с не-ASCII символами по RFC 2047.
 *
 * Кириллическая тема, отданная как есть, приезжает в почтовый клиент
 * «РћР±СЂР°С‰РµРЅРёРµ» — и это видит человек, а не разработчик. Base64 вместо
 * Q-кодирования: у кириллицы кодируется почти каждый символ, и Q-форма выходит
 * длиннее и хуже читается в отладке.
 */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  // Предел строки заголовка — 78 символов; куски режутся по границе символа,
  // а не байта, иначе многобайтовый символ разъедется по двум словам.
  const chunks: string[] = [];
  let current = '';
  for (const char of value) {
    if (Buffer.byteLength(current + char, 'utf8') > 30) {
      chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) chunks.push(current);
  return chunks
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

/** Реализация по значению `MAIL_TRANSPORT`. */
export function createMailTransport(): MailTransport {
  switch (getEnv().MAIL_TRANSPORT) {
    case 'smtp':
      return new SmtpMailTransport();
    case 'file':
      return new FileMailTransport();
    default:
      return new NullMailTransport();
  }
}
