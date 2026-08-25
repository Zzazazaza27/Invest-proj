#!/usr/bin/env node
/**
 * Зонд готовности домена к почте: MX, SPF, DKIM, DMARC, PTR и сам релей.
 *
 * Зачем отдельный зонд. Отправку письма проверяет `smoke-mail-smtp.mjs`, но
 * доставку определяет не она: письмо, ушедшее с корректного релея, всё равно
 * ляжет в спам или будет отвергнуто, если у домена нет SPF, DMARC и обратной
 * записи. Эти четыре вещи живут в DNS и в панели VPS-провайдера, то есть вне
 * кода, и потому обязаны проверяться отдельно и наблюдаемо — иначе «почта
 * настроена» выясняется по жалобе «письма не приходят».
 *
 * Проверяется СОДЕРЖАТЕЛЬНЫМ запросом, а не наличием строки в конфиге:
 * запись читается из DNS, релей — настоящим SMTP-приветствием. Портовая проба
 * здесь не годится: она врёт про открытые порты (см. заметку проекта про
 * /dev/tcp в Git Bash).
 *
 * Запуск:
 *   node scripts/probe-mail-readiness.mjs --domain <домен> --ip <адрес ВПС>
 *   node scripts/probe-mail-readiness.mjs --relay smtp.timeweb.ru:2525
 *   node scripts/probe-mail-readiness.mjs --domain <домен> --direct   # свой MTA
 *   node scripts/probe-mail-readiness.mjs --domain <домен> --resolver system
 *
 * Без аргументов домен берётся из MAIL_FROM, релей — из MAIL_SMTP_HOST/PORT
 * корневого .env.
 *
 * Код возврата: 1, если не хватает записи, без которой письма будут
 * отвергаться или уходить в спам: SPF, DMARC, а при `--direct` — ещё и PTR.
 * Без `--direct` подразумевается smarthost: письмо уходит с адреса провайдера,
 * и наш PTR приёмник не смотрит.
 */
import { createConnection } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { existsSync, readFileSync } from 'node:fs';
import { Resolver } from 'node:dns/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DNS_TIMEOUT_MS = 5_000;
const SMTP_TIMEOUT_MS = 8_000;

const env = loadDotEnv();
const args = parseArgs(process.argv.slice(2));

const domain = args.domain ?? domainOf(env.MAIL_FROM ?? '');
const relay = args.relay ?? relayFrom(env);
const ip = args.ip ?? null;
const selectors = (args['dkim-selector'] ?? 'default,mail,dkim,timeweb').split(',');

if (!domain) {
  console.error('Не задан домен: --domain <домен> либо MAIL_FROM в .env');
  process.exit(2);
}

/**
 * Спрашиваем ПУБЛИЧНЫЙ резолвер, а не системный.
 *
 * Не перестраховка: на машине разработчика системный резолвер (роутер, VPN,
 * корпоративный DNS) отдал по этому домену пустоту там, где 8.8.8.8 и 1.1.1.1
 * возвращают и MX, и SPF. Зонд при этом рапортовал «записей нет» — то есть
 * ровно тот ложный результат, ради которого проверку и писали. Почту
 * принимает и отвергает интернет, значит и спрашивать надо его.
 *
 * `--resolver system` возвращает прежнее поведение, если это нужно осознанно.
 */
const PUBLIC_RESOLVERS = ['8.8.8.8', '1.1.1.1'];
const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
const resolverChoice = args.resolver ?? PUBLIC_RESOLVERS.join(',');
if (resolverChoice !== 'system') resolver.setServers(resolverChoice.split(','));

let blocking = 0;

console.warn(`\n=== ГОТОВНОСТЬ ДОМЕНА К ПОЧТЕ: ${domain} ===`);
console.warn(`    резолвер: ${resolverChoice === 'system' ? 'системный' : resolverChoice}\n`);

// --- MX --------------------------------------------------------------------

const mx = await resolver.resolveMx(domain).catch(() => []);
report(
  mx.length > 0 ? 'OK' : 'HIGH',
  'MX',
  mx.length > 0
    ? mx
        .sort((a, b) => a.priority - b.priority)
        .map((r) => `${r.priority} ${r.exchange}`)
        .join(', ')
    : 'записей нет — принимать почту домен не может',
);

// --- SPF -------------------------------------------------------------------
//
// Две записи SPF хуже одной неправильной: по RFC 7208 приёмник обязан считать
// такой домен permerror и игнорировать ОБЕ, то есть проверка не проходит вовсе.

const txt = await resolver.resolveTxt(domain).catch(() => []);
const spf = txt
  .map((chunks) => chunks.join(''))
  .filter((v) => v.toLowerCase().startsWith('v=spf1'));

if (spf.length === 0) {
  blocking += 1;
  report('HIGH', 'SPF', 'записи нет — письма от домена не подтверждаются отправителем');
  hint(`${domain}. TXT "v=spf1 include:<релей> ~all"`);
} else if (spf.length > 1) {
  blocking += 1;
  report('HIGH', 'SPF', `записей ${spf.length} — приёмник обязан игнорировать обе (permerror)`);
} else {
  const value = spf[0];
  const soft = /[~-]all\s*$/.test(value);
  report(soft ? 'OK' : 'MEDIUM', 'SPF', value);
  if (!soft) hint('запись обязана заканчиваться на ~all или -all: +all разрешает подделку');
}

// --- DMARC -----------------------------------------------------------------

const dmarcTxt = await resolver.resolveTxt(`_dmarc.${domain}`).catch(() => []);
const dmarc = dmarcTxt
  .map((chunks) => chunks.join(''))
  .filter((v) => v.toLowerCase().startsWith('v=dmarc1'));

if (dmarc.length === 0) {
  blocking += 1;
  report('HIGH', 'DMARC', 'записи нет — крупные провайдеры складывают такую почту в спам');
  hint(`_dmarc.${domain}. TXT "v=DMARC1; p=none; rua=mailto:postmaster@${domain}"`);
} else {
  const policy = /p=([a-z]+)/i.exec(dmarc[0])?.[1] ?? '?';
  report(policy === 'none' ? 'LOW' : 'OK', 'DMARC', dmarc[0]);
  if (policy === 'none') {
    hint('p=none — режим наблюдения: подделку домена он фиксирует, но не блокирует');
  }
}

// --- DKIM ------------------------------------------------------------------
//
// Селектор задаёт релей, и угадать его нельзя — проверяются частые варианты.
// Отсутствие ключа не блокирует отправку, но письмо теряет второй фактор
// подлинности, и DMARC начинает держаться на одном SPF.

const found = [];
for (const selector of selectors) {
  const record = await resolver.resolveTxt(`${selector}._domainkey.${domain}`).catch(() => []);
  if (record.length > 0) found.push(`${selector}: ${record[0].join('').slice(0, 60)}…`);
}
report(
  found.length > 0 ? 'OK' : 'MEDIUM',
  'DKIM',
  found.length > 0
    ? found.join(' | ')
    : `ключа нет ни для одного из проверенных селекторов (${selectors.join(', ')}) — ` +
        'ключ выдаёт релей, селектор уточнить у него',
);

// --- PTR -------------------------------------------------------------------
//
// Обратная запись проверяется вместе с прямой (forward-confirmed rDNS): PTR,
// который указывает на имя, не резолвящееся обратно в тот же адрес, приёмники
// не засчитывают.

// Насколько это блокирует — зависит от схемы отправки. При smarthost письмо
// уходит с адреса провайдера, и наш PTR приёмник не смотрит вовсе: он смотрит
// PTR того, кто с ним соединился. Требовать его в этом случае — требовать
// закрыть то, что не мешает. При прямой отправке (--direct) всё наоборот.
const directSending = Boolean(args.direct);

if (!ip) {
  report('SKIP', 'PTR', 'адрес не задан (--ip) — проверка не выполнялась');
} else {
  const names = await resolver.reverse(ip).catch(() => []);
  if (names.length === 0) {
    if (directSending) blocking += 1;
    report(
      directSending ? 'HIGH' : 'LOW',
      'PTR',
      `для ${ip} обратной записи нет` +
        (directSending
          ? ' — почту с такого адреса отвергают'
          : ' — при отправке через smarthost это не мешает: приёмник смотрит PTR релея'),
    );
    hint('PTR настраивается в панели VPS-провайдера, а не в DNS домена');
  } else {
    const forward = await resolver.resolve4(names[0]).catch(() => []);
    const confirmed = forward.includes(ip);
    report(confirmed ? 'OK' : 'MEDIUM', 'PTR', `${ip} → ${names[0]}${confirmed ? '' : ''}`);
    if (!confirmed) hint(`${names[0]} не резолвится обратно в ${ip} — приёмник это не засчитает`);
  }
}

// --- Релей -----------------------------------------------------------------

if (!relay) {
  report('SKIP', 'релей', 'не задан (--relay host:port либо MAIL_SMTP_HOST/PORT в .env)');
} else {
  const [host, port] = splitRelay(relay);
  const greeting = await probeRelay(host, port);
  if (greeting.error) {
    blocking += 1;
    report('HIGH', 'релей', `${host}:${port} — ${greeting.error}`);
  } else {
    report('OK', 'релей', `${host}:${port} — ${greeting.banner}`);
    report(
      greeting.caps.includes('STARTTLS') || greeting.implicitTls ? 'OK' : 'HIGH',
      'релей: TLS',
      greeting.implicitTls ? 'TLS с первого байта' : `возможности: ${greeting.caps.join(' ')}`,
    );
    const auth = greeting.caps.filter((c) => c.startsWith('AUTH'));
    report(
      auth.length > 0 ? 'OK' : 'MEDIUM',
      'релей: вход',
      auth.length > 0 ? auth.join(' ') : 'механизмы входа не объявлены до TLS — это нормально',
    );
  }
}

console.warn(
  `\nИтог: блокирующих пробелов ${blocking}. ` +
    (blocking === 0
      ? 'Домен готов принимать и отправлять почту.'
      : 'До подключения почты их нужно закрыть.'),
);
process.exitCode = blocking === 0 ? 0 : 1;

// ---------------------------------------------------------------- служебное

function report(level, name, detail) {
  const line = `  ${level.padEnd(6)} ${name.padEnd(12)} ${detail}`;
  if (level === 'HIGH') console.error(line);
  else console.warn(line);
}

function hint(text) {
  console.warn(`         └─ нужно: ${text}`);
}

/** Приветствие релея настоящим SMTP-диалогом, а не пробой порта. */
async function probeRelay(host, port) {
  const implicitTls = port === 465;
  return new Promise((resolve) => {
    let buffer = '';
    const caps = [];
    let banner = '';
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    const socket = implicitTls
      ? tlsConnect({ host, port, servername: host, minVersion: 'TLSv1.2' }, onReady)
      : createConnection({ host, port }, onReady);

    socket.setTimeout(SMTP_TIMEOUT_MS);
    socket.on('timeout', () => finish({ error: 'молчит до таймаута' }));
    socket.on('error', (error) => finish({ error: error.message }));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!banner && buffer.includes('\r\n')) {
        banner = buffer.split('\r\n')[0];
        socket.write('EHLO probe.unicorn.local\r\n');
        buffer = '';
        return;
      }
      if (banner && /^\d{3} /m.test(buffer)) {
        for (const line of buffer.split('\r\n')) {
          const value = line.slice(4).trim().toUpperCase();
          if (value) caps.push(value.split(' ')[0] === 'AUTH' ? value : value.split(' ')[0]);
        }
        socket.write('QUIT\r\n');
        finish({ banner, caps, implicitTls });
      }
    });

    function onReady() {
      /* приветствие придёт событием data */
    }
  });
}

function splitRelay(value) {
  const at = value.lastIndexOf(':');
  return at === -1 ? [value, 2525] : [value.slice(0, at), Number(value.slice(at + 1))];
}

function relayFrom(source) {
  return source.MAIL_SMTP_HOST ? `${source.MAIL_SMTP_HOST}:${source.MAIL_SMTP_PORT ?? 2525}` : null;
}

function domainOf(address) {
  const at = address.lastIndexOf('@');
  return at === -1 ? null : address.slice(at + 1).trim() || null;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    // Флаг без значения — это `true`, а не `undefined`: последний аргумент в
    // строке (`--direct`) иначе молча терялся, и режим не включался.
    const next = argv[i + 1];
    parsed[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : argv[++i];
  }
  return parsed;
}

/** Значения из корневого .env — без перезаписи того, что уже в окружении. */
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
