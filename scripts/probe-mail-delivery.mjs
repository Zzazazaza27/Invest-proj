#!/usr/bin/env node
/**
 * Настоящая доставка одного письма через реальный релей.
 *
 * Это последний шаг, который нельзя проверить локальным приёмником: у mailpit
 * нет ни TLS, ни аутентификации, поэтому успешные ветки STARTTLS и AUTH в
 * прогоне `smoke-mail-smtp.mjs` не выполняются ни разу. Здесь они выполняются
 * впервые — против того самого релея, через который пойдут письма платформы.
 *
 * Закрывает пункты 1 и 3 полного теста ТЗ №2: письмо со служебного ящика на
 * внешний адрес и отправка приложением по SMTP. Пункты 4 и 5 (доставка в
 * крупный сервис и папка «Спам») проверяются глазами в ящике получателя —
 * скрипт печатает, что именно там смотреть.
 *
 * Пароль берётся ТОЛЬКО из окружения или `.env` и не печатается никогда — ни
 * в выводе, ни в тексте ошибки. Передавать его аргументом командной строки
 * нельзя: аргументы видны в списке процессов любому пользователю машины и
 * оседают в истории командной оболочки.
 *
 * НЕ ЗАПУСКАЕТСЯ АВТОМАТИЧЕСКИ. Письмо уходит настоящему человеку и не
 * отзывается, поэтому прогон не входит ни в один функциональный блок и
 * требует двух явных вещей: получателя в `--to` и подтверждения
 * `MAIL_PROBE_CONFIRM=1` в окружении. Ни того, ни другого нет ни в `.env`,
 * ни в наборах.
 *
 * Запуск:
 *   MAIL_SMTP_PASSWORD=<пароль> MAIL_PROBE_CONFIRM=1 \
 *     node scripts/probe-mail-delivery.mjs \
 *     --host smtp.timeweb.ru --port 2525 --user info@vgorkakh.ru \
 *     --to <внешний адрес>
 *
 * Значения, не переданные аргументами, берутся из корневого `.env`
 * (MAIL_SMTP_HOST, MAIL_SMTP_PORT, MAIL_SMTP_SECURITY, MAIL_SMTP_USER,
 * MAIL_SMTP_PASSWORD, MAIL_FROM).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'apps/core/dist/comms/smtp.client.js');
const TRANSPORT = join(ROOT, 'apps/core/dist/comms/mail.transport.js');

if (!existsSync(CLIENT)) {
  console.error(`Не найден ${CLIENT}. Сначала: npm run build -w apps/core`);
  process.exit(2);
}

const env = loadDotEnv();
const args = parseArgs(process.argv.slice(2));

const target = {
  host: args.host ?? env.MAIL_SMTP_HOST ?? '',
  port: Number(args.port ?? env.MAIL_SMTP_PORT ?? 2525),
  security: args.security ?? env.MAIL_SMTP_SECURITY ?? 'starttls',
  user: args.user ?? env.MAIL_SMTP_USER ?? '',
  password: env.MAIL_SMTP_PASSWORD ?? '',
  ehloName: args.ehlo ?? env.MAIL_SMTP_EHLO_NAME ?? '',
  timeoutMs: 20_000,
};
const from = args.from ?? env.MAIL_FROM ?? target.user;
const to = args.to ?? null;

if (!target.host || !to) {
  console.error(
    'Нужны релей и получатель:\n' +
      '  MAIL_SMTP_PASSWORD=<пароль> node scripts/probe-mail-delivery.mjs \\\n' +
      '    --host smtp.timeweb.ru --port 2525 --user <ящик> --to <адрес получателя>',
  );
  process.exit(2);
}
/*
 * ВТОРОЙ РУБЕЖ: письмо уходит НАСТОЯЩЕМУ человеку.
 *
 * Адрес релея, ящик и пароль лежат в `.env` — то есть случайный запуск почти
 * собран, не хватает только получателя. Для действия, которое нельзя
 * отменить, это слишком тонкая защита: ушедшее письмо не отзывается.
 *
 * Поэтому подтверждение отдельное и намеренно неудобное — переменная
 * окружения, которой нет ни в `.env`, ни в наборах. Сам прогон не входит ни
 * в один функциональный блок (см. manualByDesign в реестре): запускается
 * только руками и только по прямому решению владельца.
 */
if (process.env.MAIL_PROBE_CONFIRM !== '1') {
  console.error(
    `Отправка настоящего письма на ${to} НЕ выполнена.\n` +
      'Это действие уходит наружу и не отменяется, поэтому нужно явное\n' +
      'подтверждение: MAIL_PROBE_CONFIRM=1 в окружении запуска.',
  );
  process.exit(2);
}

if (target.user && !target.password) {
  console.error(
    'Пароль не задан. Он берётся из переменной MAIL_SMTP_PASSWORD или из .env —\n' +
      'аргументом командной строки его передавать нельзя: аргументы видны в списке\n' +
      'процессов и остаются в истории оболочки.',
  );
  process.exit(2);
}
if (!target.ehloName) target.ehloName = domainOf(from);

const { smtpDeliver } = await import(pathToFileURL(CLIENT).href);
const { buildMessage } = await import(pathToFileURL(TRANSPORT).href);

const marker = randomUUID();
const subject = `Проверка доставки «Пятый элемент» · ${marker.slice(0, 8)}`;
const data = buildMessage({
  from,
  to,
  subject,
  text: [
    'Это техническое письмо: платформа проверяет, что умеет отправлять почту.',
    '',
    `Метка прогона: ${marker}`,
    `Релей: ${target.host}:${target.port} (${target.security})`,
    `Момент: ${new Date().toISOString()}`,
    '',
    'Отвечать на него не нужно.',
    '',
  ].join('\n'),
});

console.warn(`\n=== ДОСТАВКА ЧЕРЕЗ РЕАЛЬНЫЙ РЕЛЕЙ ===\n`);
console.warn(`  релей:      ${target.host}:${target.port} (${target.security})`);
console.warn(`  ящик:       ${target.user || '<без аутентификации>'}`);
console.warn(`  от кого:    ${from}`);
console.warn(`  кому:       ${to}`);
console.warn(`  тема:       ${subject}\n`);

try {
  await smtpDeliver(target, { from, to, data });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const stage = error?.stage ?? 'unknown';
  const code = error?.code ?? null;
  console.error(`  ОТКАЗ на этапе ${stage}${code ? ` (код ${code})` : ''}: ${message}\n`);
  console.error(`  ${explain(stage, code)}`);
  process.exitCode = 1;
  process.exit();
}

console.warn('  ПИСЬМО ПРИНЯТО РЕЛЕЕМ.\n');
console.warn('  Принято релеем — ещё не «доставлено получателю»: дальше письмо идёт');
console.warn('  своим ходом. В ящике получателя проверить глазами:');
console.warn(`    1. пришло ли письмо с темой «${subject}»;`);
console.warn('    2. лежит оно во «Входящих» или сразу в «Спаме» (пункт 5 ТЗ);');
console.warn('    3. в исходном тексте письма — spf=pass, dkim=pass, dmarc=pass (пункт 4 ТЗ).');
console.warn('  Если dkim или dmarc не pass — смотри docs/runbooks/mail.md.\n');

// ---------------------------------------------------------------- служебное

/** Что делать с этим отказом. Без пересказа ответа релея — там бывает ящик. */
function explain(stage, code) {
  if (stage === 'auth') {
    return (
      'Релей отклонил вход. Проверить: адрес ящика целиком (обычно логин — это\n' +
      '  весь адрес, а не часть до собаки), пароль, и не заблокирован ли ящик\n' +
      '  провайдером за неудачные попытки.'
    );
  }
  if (stage === 'connect') {
    return (
      'До релея не дошли. С ВПС это чаще всего закрытый провайдером порт —\n' +
      '  проверить: node scripts/probe-mail-readiness.mjs --outbound (с сервера).'
    );
  }
  if (stage === 'starttls') {
    return 'Шифрование не установилось. Порт 465 — это --security tls, 587 и 2525 — starttls.';
  }
  if (stage === 'mail-from' || stage === 'rcpt-to') {
    return (
      'Релей не принял адрес. Обычно отправитель обязан совпадать с ящиком, от\n' +
      '  имени которого выполнен вход: MAIL_FROM и MAIL_SMTP_USER должны сойтись.'
    );
  }
  if (code === 550 || code === 554) {
    return 'Релей отверг письмо по правилам приёма — читать его ответ целиком в логе.';
  }
  return 'Смотреть этап отказа выше и docs/runbooks/mail.md.';
}

function domainOf(address) {
  const at = String(address).lastIndexOf('@');
  return at === -1 ? 'localhost' : address.slice(at + 1).trim() || 'localhost';
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    parsed[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : argv[++i];
  }
  // Пароль аргументом не принимается сознательно: см. шапку файла.
  delete parsed.password;
  return parsed;
}

function loadDotEnv() {
  const result = { ...process.env };
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return result;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] ??= value;
  }
  return result;
}
