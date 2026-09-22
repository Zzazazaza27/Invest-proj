import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { FileMailTransport, NullMailTransport, buildMessage } from '../src/comms/mail.transport';

/**
 * Восстановление пароля и подтверждение адреса: то, что дымовой прогон
 * показать не может.
 *
 * Живой прогон (`scripts/smoke-auth-recovery.mjs`) проверяет сценарий целиком —
 * здесь проверяются комбинации конфигурации, которые обязаны ронять старт, и
 * поведение файлового транспорта на враждебном вводе.
 */

beforeEach(() => {
  resetEnvCache();
});

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://app:pw@localhost:5433/db',
  AUTH_MODE: 'local',
  LOCAL_AUTH_SIGNING_KEY: 'k'.repeat(64),
  CSRF_SIGNING_KEY: 'c'.repeat(64),
  KMS_MODE: 'local',
  KEK_SEARCH_INDEX: Buffer.alloc(32, 7).toString('base64'),
  KEK_PASSPORT_SENSITIVE: Buffer.alloc(32, 8).toString('base64'),
  KEK_KYB_DOCUMENTS: Buffer.alloc(32, 9).toString('base64'),
  KEK_INVESTMENT_DOCUMENTS: Buffer.alloc(32, 10).toString('base64'),
  KEK_WEBHOOK_SECRETS: Buffer.alloc(32, 11).toString('base64'),
  KEK_AI_PROVIDER_SECRETS: Buffer.alloc(32, 12).toString('base64'),
};

/** Конфигурация production, проходящая остальные проверки: меняем только почту. */
const PROD_ENV: NodeJS.ProcessEnv = {
  ...BASE_ENV,
  NODE_ENV: 'production',
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: 'https://id.unicorn.vc',
  OIDC_AUDIENCE: 'unicorn-launch',
  KMS_MODE: 'kms',
  KMS_KEY_ID: 'arn:aws:kms:ru-central1:1:key/abc',
  CORS_ALLOWED_ORIGINS: 'https://app.unicorn.vc',
  CORE_PUBLIC_URL: 'https://api.unicorn.vc',
  DATABASE_SSL: 'true',
  REDIS_URL: 'rediss://127.0.0.1:6379',
  REDIS_PASSWORD: 'r'.repeat(32),
  // Production-обстановка задаётся ЦЕЛИКОМ и явно.
  //
  // У WEBHOOK_DELIVERY_MODE значение по умолчанию — capture, а в production
  // оно запрещено (M128): подписчики не получают событий, а очередь выглядит
  // обработанной. Правило появилось позже этих проверок, фикстуру не
  // обновили — и три позитивных контроля начали падать на постороннем
  // условии, ничего не говоря о том, что проверяли. Отсюда правило: набор
  // «production» перечисляет всё, от чего зависит, и не опирается ни на
  // умолчания схемы, ни на окружение машины.
  WEBHOOK_DELIVERY_MODE: 'live',
  SESSION_COOKIE_NAME: '__Host-ul_session',
  CSRF_COOKIE_NAME: '__Host-ul_csrf',
  PUBLIC_BASE_URL: 'https://app.unicorn.vc',
};

describe('Почтовый транспорт: fail-closed в production', () => {
  it('file-транспорт не запускается в production', () => {
    // Письмо, записанное в файл на диске сервера, никому не доставлено — а
    // ссылка на смену пароля в нём настоящая. Это утечка, а не почта.
    expect(() => loadEnv({ ...PROD_ENV, MAIL_TRANSPORT: 'file' })).toThrow(/MAIL_TRANSPORT/);
  });

  it('ссылки в письмах обязаны быть https', () => {
    // Проверка безусловна и в том случае, когда почта выключена: привязать её
    // к включённому транспорту значило бы, что она не сработает никогда —
    // единственный существующий транспорт в production и так запрещён.
    expect(() => loadEnv({ ...PROD_ENV, PUBLIC_BASE_URL: 'http://app.unicorn.vc' })).toThrow(
      /PUBLIC_BASE_URL/,
    );
  });

  it('production с отключённой почтой стартует', () => {
    // Позитивный контроль: отказы выше — про КОНКРЕТНЫЕ комбинации, а не про
    // «почта в production запрещена». Отсутствие транспорта — законное
    // состояние: маршруты отвечают 503, пока сервер не подключён.
    const env = loadEnv({ ...PROD_ENV, MAIL_TRANSPORT: 'none' });
    expect(env.MAIL_TRANSPORT).toBe('none');
  });
});

describe('Транспорт «почты нет»', () => {
  it('не изображает отправку, а отказывает', () => {
    const transport = new NullMailTransport();
    expect(transport.available).toBe(false);
    // Молчаливая заглушка означала бы, что человек ждёт письма, которого
    // никто не отправлял.
    expect(() => transport.send()).toThrow();
  });
});

describe('Файловый транспорт', () => {
  it('не выпускает адрес получателя за пределы своей папки', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unicorn-mail-'));
    const saved = { ...process.env };
    try {
      // Транспорт читает конфигурацию через getEnv(), а тот берёт её из
      // process.env: передать объект напрямую нельзя, иначе проверялся бы не
      // тот путь, каким конфигурация приходит в бою.
      Object.assign(process.env, BASE_ENV, { MAIL_TRANSPORT: 'file', MAIL_OUTBOX_DIR: dir });
      resetEnvCache();

      // Адрес приходит из запроса. Подстановка его в путь как есть — обход
      // каталога: файл ушёл бы на два уровня выше папки писем.
      await new FileMailTransport().send({
        to: '../../evil@test.local',
        subject: 'тест',
        text: 'ссылка',
      });

      // Важна не косметика имени, а то, что письмо осталось В СВОЕЙ папке:
      // разделителей пути в имени нет, значит `..` в адресе никуда не ведёт.
      // Точки сами по себе безвредны и нужны — они есть в любом адресе.
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).not.toContain('/');
      // Обратный слэш — тоже разделитель пути (Windows); проверяем по коду
      // символа, чтобы не заводить экранирование в самом тесте.
      expect(files[0]!.includes(String.fromCharCode(92))).toBe(false);
      expect(readFileSync(join(dir, files[0]!), 'utf8')).toContain('ссылка');
    } finally {
      process.env = saved;
      resetEnvCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SMTP-транспорт: конфигурация fail-closed', () => {
  const SMTP_ENV = { ...BASE_ENV, MAIL_TRANSPORT: 'smtp' };

  it('транспорт smtp без релея не запускается', () => {
    expect(() => loadEnv(SMTP_ENV)).toThrow(/MAIL_SMTP_HOST/);
  });

  it('открытый канал разрешён только к петле', () => {
    expect(() =>
      loadEnv({ ...SMTP_ENV, MAIL_SMTP_HOST: 'smtp.example.com', MAIL_SMTP_SECURITY: 'plain' }),
    ).toThrow(/MAIL_SMTP_SECURITY/);
    // Позитивный контроль: к локальному приёмнику прогонов — законно.
    expect(
      loadEnv({ ...SMTP_ENV, MAIL_SMTP_HOST: '127.0.0.1', MAIL_SMTP_SECURITY: 'plain' })
        .MAIL_SMTP_SECURITY,
    ).toBe('plain');
  });

  it('имя без пароля отвергается', () => {
    expect(() =>
      loadEnv({ ...SMTP_ENV, MAIL_SMTP_HOST: 'smtp.example.com', MAIL_SMTP_USER: 'sender' }),
    ).toThrow(/MAIL_SMTP_PASSWORD/);
  });

  it('в production релей обязан быть зашифрован и с аутентификацией', () => {
    const prodSmtp = { ...PROD_ENV, MAIL_TRANSPORT: 'smtp', MAIL_SMTP_HOST: 'smtp.timeweb.ru' };
    // Релей без входа примет письмо от кого угодно от нашего имени.
    expect(() => loadEnv(prodSmtp)).toThrow(/MAIL_SMTP_USER/);
    expect(
      loadEnv({
        ...prodSmtp,
        MAIL_SMTP_USER: 'no-reply@unicorn.vc',
        MAIL_SMTP_PASSWORD: 'p'.repeat(24),
        MAIL_SMTP_PORT: '2525',
      }).MAIL_SMTP_PORT,
    ).toBe(2525);
  });

  it('уведомления о регистрации без служебного ящика не включаются', () => {
    expect(() =>
      loadEnv({ ...BASE_ENV, NOTIFY_INBOX_ON_REGISTRATION: 'true', SUPPORT_INBOX_EMAIL: '' }),
    ).toThrow(/SUPPORT_INBOX_EMAIL/);
  });
});

describe('Сборка письма', () => {
  const LETTER = { from: 'no-reply@unicorn.local', to: 'user@example.com' };

  it('кириллическая тема кодируется по RFC 2047', () => {
    const message = buildMessage({ ...LETTER, subject: 'Подтверждение адреса', text: 'ссылка' });
    // Тема, отданная как есть, приезжает в почтовый клиент нечитаемой.
    expect(message).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(message).not.toContain('Подтверждение');
    expect(message).toContain('Content-Transfer-Encoding: base64');
  });

  it('ASCII-тема не кодируется без нужды', () => {
    expect(buildMessage({ ...LETTER, subject: '[registration] new', text: 'x' })).toContain(
      'Subject: [registration] new',
    );
  });

  it('перевод строки в заголовке отвергается', () => {
    // Иначе в письмо дописывается СВОЙ заголовок: скрытая копия, другой
    // получатель, собственный Content-Type.
    expect(() =>
      buildMessage({ ...LETTER, subject: 'тема\r\nBcc: attacker@example.com', text: 'x' }),
    ).toThrow();
    expect(() =>
      buildMessage({
        ...LETTER,
        to: 'user@example.com\nBcc: attacker@example.com',
        subject: 's',
        text: 'x',
      }),
    ).toThrow();
  });

  it('тело доезжает целым: base64 обратимо', () => {
    const text = 'Первая строка.\n.\nи «кавычки» с ёжиком';
    const message = buildMessage({ ...LETTER, subject: 's', text });
    const body = message.split('\r\n\r\n')[1]!.replace(/\r\n/g, '');
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe(text);
  });
});
