#!/usr/bin/env node
/**
 * Живой прогон SMTP-транспорта почты.
 *
 * До этой фазы всё, что касалось писем, проверялось файловым транспортом:
 * сценарий проходил целиком, но ни одного SMTP-диалога не было. Здесь письмо
 * действительно уходит по протоколу — в локальный приёмник mailpit — и потом
 * читается из него обратно. Читать обратно обязательно: 250 на DATA означает
 * «релей принял», а не «письмо собрано верно»; кодировка темы, границы строк и
 * точечная вставка проверяются только по тому, что доехало.
 *
 * Что проверяется:
 *   1. письмо доставлено и найдено в ящике;
 *   2. кириллическая тема приезжает целой (RFC 2047), а не мохнатой;
 *   3. тело в UTF-8 совпадает с отправленным байт в байт;
 *   4. строка «.» в теле не обрывает письмо (точечная вставка);
 *   5. одиночный LF и последовательность CRLF.CRLF внутри тела не разрезают
 *      письмо на два (контрабанда SMTP);
 *   6. перевод строки в адресе получателя отвергается до соединения;
 *   7. перевод строки в теме отвергается до соединения;
 *   8. незашифрованный канал к НЕлокальному адресу отвергается;
 *   9. пароль по незашифрованному каналу отвергается;
 *  10. релей без STARTTLS не обслуживается молча открытым текстом;
 *  11. дописанные в открытый канал команды после «220 готов к TLS» рвут
 *      соединение (инъекция в STARTTLS);
 *  12. недоступный релей даёт отказ, а не тихий успех;
 *  13. пароль не попадает ни в текст ошибки, ни в её стек.
 *
 *  14. ядро принимает регистрацию;
 *  15. уведомление о новой регистрации доехало на служебный ящик;
 *  16. в этом уведомлении нет ни адреса, ни имени человека.
 *
 * Запуск:
 *   npm run infra:mail-up
 *   npm run build -w apps/core
 *   MAIL_TRANSPORT=smtp MAIL_SMTP_HOST=127.0.0.1 MAIL_SMTP_PORT=1025 \
 *     MAIL_SMTP_SECURITY=plain NOTIFY_INBOX_ON_REGISTRATION=true \
 *     node scripts/dev-core.mjs --detached
 *   node scripts/smoke-mail-smtp.mjs
 */
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_PATH = join(ROOT, 'apps/core/dist/comms/smtp.client.js');
const MAILPIT_SMTP_PORT = Number(process.env.SMTP_PORT ?? 1025);
const MAILPIT_API = `http://127.0.0.1:${process.env.SMTP_UI_PORT ?? 8025}`;

/**
 * Потолок на каждый вызов наружу.
 *
 * Прогон без таймаутов не падает, а висит — и в CI это выглядит как
 * бесконечная сборка, а не как отказ (RULES.md §3.1).
 */
const TIMEOUT = () => AbortSignal.timeout(10_000);

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  OK    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Ожидаемый отказ. Успех здесь — это провал проверки. */
async function expectReject(name, run, expectation) {
  try {
    await run();
    check(name, false, 'отказа не было');
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, expectation(message, error), message);
    return error;
  }
}

if (!existsSync(CLIENT_PATH)) {
  console.error(`Не найден ${CLIENT_PATH}. Сначала: npm run build -w apps/core`);
  process.exit(2);
}
const { smtpDeliver, assertUsable } = await import(pathToFileURL(CLIENT_PATH).href);

const local = (over = {}) => ({
  host: '127.0.0.1',
  port: MAILPIT_SMTP_PORT,
  security: 'plain',
  user: '',
  password: '',
  ehloName: 'smoke.local',
  timeoutMs: 5_000,
  ...over,
});

// --- 1–5. Настоящая доставка и целостность письма -------------------------

const marker = randomUUID();
const subject = `Проверка транспорта: обращение №${marker.slice(0, 8)} — ёжик, «кавычки»`;
// Тело собрано из ровно тех последовательностей, на которых ломаются наивные
// реализации: строка из одной точки, точка в начале строки, одиночный LF и
// готовый терминатор DATA посреди текста.
const body = [
  'Первая строка.',
  '.',
  '.скрытая точка в начале',
  'обычная строка\nс одиночным переводом',
  'CRLF-терминатор посреди тела: \r\n.\r\n и текст после него',
  `маркер:${marker}`,
].join('\n');

const data = [
  'From: no-reply@unicorn.local',
  'To: inbox@unicorn.local',
  `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(body, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n'),
].join('\r\n');

// Недоступный приёмник — это КРАСНЫЙ прогон, а не аварийное завершение с
// пустым отчётом: упавший процесс не отличить от упавшего окружения.
let delivery = null;
try {
  await smtpDeliver(local(), { from: 'no-reply@unicorn.local', to: 'inbox@unicorn.local', data });
} catch (error) {
  delivery = error instanceof Error ? error.message : String(error);
}

const list = delivery
  ? { messages: [] }
  : await fetch(`${MAILPIT_API}/api/v1/messages?limit=50`, { signal: TIMEOUT() })
      .then((r) => r.json())
      .catch((error) => {
        delivery = `ящик недоступен: ${error.message}`;
        return { messages: [] };
      });
const summary = list.messages.find((m) => m.Subject === subject);
check(
  '1. письмо доставлено и найдено в ящике',
  Boolean(summary),
  delivery ?? summary?.ID ?? 'не найдено',
);

if (summary) {
  const message = await fetch(`${MAILPIT_API}/api/v1/message/${summary.ID}`, {
    signal: TIMEOUT(),
  }).then((r) => r.json());
  check('2. кириллическая тема приехала целой', message.Subject === subject, message.Subject);
  const received = String(message.Text).replace(/\r\n/g, '\n').trimEnd();
  const expected = body.replace(/\r\n/g, '\n').trimEnd();
  check('3. тело совпадает с отправленным', received === expected);
  check(
    '4. строка «.» не оборвала письмо',
    received.includes('.скрытая точка в начале') && received.includes(`маркер:${marker}`),
  );
  const twins = list.messages.filter((m) => m.Subject === subject);
  check('5. письмо не разрезано на два', twins.length === 1, `писем с этой темой: ${twins.length}`);
}

// --- 6–9. Отказы до соединения --------------------------------------------

await expectReject(
  '6. перевод строки в адресе получателя отвергнут',
  () =>
    smtpDeliver(local(), {
      from: 'no-reply@unicorn.local',
      to: 'inbox@unicorn.local>\r\nRCPT TO:<attacker@example.com',
      data,
    }),
  (m) => m.includes('недопустимый адрес'),
);

await expectReject(
  '7. перевод строки в адресе отправителя отвергнут',
  () =>
    smtpDeliver(local(), {
      from: 'no-reply@unicorn.local\r\nBcc: attacker@example.com',
      to: 'inbox@unicorn.local',
      data,
    }),
  (m) => m.includes('недопустимый адрес'),
);

await expectReject(
  '8. открытый канал к нелокальному адресу отвергнут',
  async () => assertUsable(local({ host: 'smtp.example.com' })),
  (m) => m.includes('только к локальному приёмнику'),
);

await expectReject(
  '9. пароль по открытому каналу отвергнут',
  async () => assertUsable(local({ user: 'sender', password: 'irrelevant-for-this-check' })),
  (m) => m.includes('не отправляются по нешифрованному каналу'),
);

// --- 10–11. Поведение против недобросовестного релея ------------------------

/**
 * Поддельный релей на петле.
 *
 * `script` — что сервер отвечает на очередную команду клиента. Нужен, чтобы
 * проверить именно те ветки, которые нельзя вызвать у честного mailpit.
 */
async function withFakeRelay(handler, run) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    // Соединения рвутся явно и до закрытия слушателя: `server.close()` ждёт
    // живые сокеты, а брошенный в закрытии дескриптор роняет процесс на
    // выходе (проверка libuv в `async.c`) — прогон при этом уже отчитался
    // «всё пройдено», а код возврата приходит ненулевым.
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

await withFakeRelay(
  (socket) => {
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      if (chunk.toString().startsWith('EHLO')) socket.write('250-fake\r\n250 SIZE 1000000\r\n');
    });
  },
  (port) =>
    expectReject(
      '10. релей без STARTTLS не обслуживается открытым текстом',
      () =>
        smtpDeliver(local({ port, security: 'starttls' }), {
          from: 'no-reply@unicorn.local',
          to: 'inbox@unicorn.local',
          data,
        }),
      (m) => m.includes('не предлагает STARTTLS'),
    ),
);

await withFakeRelay(
  (socket) => {
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      const line = chunk.toString();
      if (line.startsWith('EHLO')) socket.write('250-fake\r\n250 STARTTLS\r\n');
      // Ответ на STARTTLS и СРАЗУ дописанная команда в открытый канал: она
      // рассчитывает быть исполненной уже как доверенная, после перехода.
      else if (line.startsWith('STARTTLS')) socket.write('220 go ahead\r\n250 injected\r\n');
    });
  },
  (port) =>
    expectReject(
      '11. дописанные в открытый канал команды рвут STARTTLS',
      () =>
        smtpDeliver(local({ port, security: 'starttls' }), {
          from: 'no-reply@unicorn.local',
          to: 'inbox@unicorn.local',
          data,
        }),
      (m) => m.includes('непрочитанные данные'),
    ),
);

// --- 12–13. Недоступный релей и молчание о пароле --------------------------

const secret = `pw-${randomUUID()}`;
const unreachable = await expectReject(
  '12. недоступный релей даёт отказ, а не тихий успех',
  () =>
    smtpDeliver(local({ port: 9, security: 'tls', user: 'sender', password: secret }), {
      from: 'no-reply@unicorn.local',
      to: 'inbox@unicorn.local',
      data,
    }),
  (m) => m.length > 0,
);

check(
  '13. пароль не попал ни в текст ошибки, ни в стек',
  !`${unreachable?.message ?? ''}${unreachable?.stack ?? ''}`.includes(secret),
);

// --- 14–16. Сквозной путь через живое ядро ---------------------------------
//
// Проверки выше подтверждают клиент. Они НЕ подтверждают, что ядро настроено,
// собирает письмо и вызывает транспорт в нужный момент — а именно это ломается
// при переключении транспорта. Поэтому здесь регистрация идёт настоящим
// запросом к ядру, а письма ищутся в том же приёмнике.

const suffix = randomUUID().slice(0, 8);
const email = `smoke-mail-${suffix}@unicorn.local`;
const registered = await fetch(`${CORE_URL}/v1/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  signal: TIMEOUT(),
  body: JSON.stringify({
    email,
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
    password: `Smoke-mail-${suffix}-passw0rd!`,
    displayName: `Прогон почты ${suffix}`,
    role: 'founder',
    locale: 'ru-RU',
    consents: ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
      kind,
      version: 'v1',
      locale: 'ru-RU',
    })),
  }),
}).catch((error) => ({ status: 0, reason: error.message }));

check(
  '14. ядро приняло регистрацию',
  registered.status === 201,
  registered.status === 0
    ? `ядро недоступно на ${CORE_URL}: ${registered.reason}. Запусти его с MAIL_TRANSPORT=smtp`
    : `статус ${registered.status}`,
);

if (registered.status === 201) {
  // Письма уходят после фиксации транзакции, вне запроса: короткая пауза
  // здесь — не «подождём на всякий случай», а ожидание уже начатой отправки.
  const mailbox = await pollMailbox(
    (messages) =>
      messages.some((m) => m.Subject.startsWith('[registration]')) &&
      messages.some((m) => m.To?.some?.((addr) => addr.Address === email)),
    5_000,
  );

  const registration = mailbox.find((m) => m.Subject.startsWith('[registration]'));
  check('15. уведомление о регистрации ушло на служебный ящик', Boolean(registration));

  // Письмо подтверждения адреса уходит тем же транспортом и тем же вызовом,
  // что и раньше уходило файлом. Проверяется здесь, а не в прогоне
  // восстановления: тот читает письма из файлов и про SMTP ничего не знает.
  check(
    '15a. письмо подтверждения адреса ушло тому, кто зарегистрировался',
    mailbox.some((m) => m.To?.some?.((addr) => addr.Address === email)),
    email,
  );

  if (registration) {
    const letter = await fetch(`${MAILPIT_API}/api/v1/message/${registration.ID}`, {
      signal: TIMEOUT(),
    }).then((r) => r.json());
    // Контакты в служебное уведомление не выносятся — это персональные данные
    // из зашифрованного хранилища, и почтовый ящик им не место.
    check(
      '16. в уведомлении нет ни адреса, ни имени зарегистрировавшегося',
      !letter.Text.includes(email) && !letter.Text.includes(suffix.toUpperCase()),
      letter.Text.split('\n')
        .find((l) => l.startsWith('Роль'))
        ?.trim() ?? '',
    );
  }
}

async function pollMailbox(ready, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = await fetch(`${MAILPIT_API}/api/v1/messages?limit=50`, {
      signal: TIMEOUT(),
    })
      .then((r) => r.json())
      .then((body) => body.messages)
      .catch(() => []);
    if (ready(messages) || Date.now() > deadline) return messages;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

console.warn(`\nИтог: ${passed} пройдено, ${failed} провалено`);
// Код возврата, а не process.exit(): принудительный выход посреди закрытия
// сокетов даёт на Windows аварийное завершение с кодом 127 — прогон выглядел
// бы упавшим при всех пройденных проверках.
process.exitCode = failed === 0 ? 0 : 1;
