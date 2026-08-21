import { Injectable, Logger } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { errors } from '../common/errors';
import { getEnv } from '../config/env';

/**
 * Порт отправки почты.
 *
 * Почтового сервера у платформы ещё нет — и это ровно тот случай, когда порт
 * нужен раньше реализации. Сценарии восстановления пароля и подтверждения
 * адреса написаны целиком и проверены целиком; когда появится SMTP или
 * провайдер, добавится одна реализация этого интерфейса, а вызывающий код не
 * изменится.
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
      `Subject: ${message.subject}`,
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

/** Реализация по значению `MAIL_TRANSPORT`. */
export function createMailTransport(): MailTransport {
  return getEnv().MAIL_TRANSPORT === 'file' ? new FileMailTransport() : new NullMailTransport();
}
