#!/usr/bin/env node
/**
 * Проверка входа файлов (блок 4, «Вход и файлы MVP»; работа 2.1-W06).
 *
 * Гоняет публичный адрес загрузки так, как его видит внешний браузер, и
 * проверяет ДВА независимых рубежа:
 *   • CORS (Caddy, вторая линия — MinIO): разрешённому сайту кабинета —
 *     разрешение, чужому — нет;
 *   • право загрузки (подписанная форма): без подписи, с чужим типом, сверх
 *     размера и после срока MinIO отказывает, какой бы ни был Origin.
 * И закрытость: через вход файлов нельзя прочитать объект, получить список
 * бакета, записать мимо формы или попасть в консоль MinIO — всё это 404.
 *
 * Формы подписывает сборка ядра с переменными окружения ТЕКУЩЕЙ машины.
 * Поэтому на внешнем стенде прогон запускается на сервере:
 *   FILES_URL=https://files.5espace.com ALLOWED_ORIGIN=https://5espace.com \
 *     node scripts/check-files-endpoint.mjs
 * Локально (Caddy из infra/caddy/files.caddy на :8099):
 *   FILES_URL=http://127.0.0.1:8099 ALLOWED_ORIGIN=https://5espace.com \
 *     node scripts/check-files-endpoint.mjs
 *
 * Прогон передаёт настоящий файл наибольшего разрешённого размера (500 МиБ) и
 * тело сверх предела Caddy (521 МиБ): это минуты и ~500 МиБ в хранилище.
 *
 * Пробные объекты кладутся под префикс `w06-probe/` и не удаляются: удаление
 * объектов — не дело этого прогона (2.1.2).
 *
 * `--quick` — для рабочего сервера (после переключения хранилища): без
 * файла 500 МиБ и тела сверх предела Caddy; небольшая загрузка формой,
 * чтение тем же содержимым, отказы формы и закрытость входа; созданные
 * объекты (`files-check/`) удаляются в конце и проверяется, что их нет.
 */
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) process.env[t.slice(0, i).trim()] ??= t.slice(i + 1).trim();
  }
}

const FILES_URL = (process.env.FILES_URL ?? '').replace(/\/+$/, '');
const ALLOWED = process.env.ALLOWED_ORIGIN ?? 'https://5espace.com';
const FOREIGN = 'https://evil.example';
/** Предел тела у Caddy (`max_size 520MiB` в infra/caddy/files.caddy). */
const CADDY_MAX = 520 * 1024 * 1024;
if (!FILES_URL) {
  console.error('нужен FILES_URL — публичный адрес загрузки');
  process.exit(2);
}
// Формы подписываются на проверяемый адрес, а не на тот, что в .env.
process.env.S3_PUBLIC_ENDPOINT = FILES_URL;

const require = createRequire(import.meta.url);
const { S3Service } = require(join(ROOT, 'apps/core/dist/storage/s3.service.js'));
const { MATERIAL_UPLOAD_RULES } = require(join(ROOT, 'packages/contracts/dist/index.js'));
const s3 = new S3Service();
const BUCKET = s3.bucket;
/** Наибольший разрешённый материал по контракту. */
const MAX_FILE = Math.max(...Object.values(MATERIAL_UPLOAD_RULES).map((r) => r.maxBytes));

/**
 * Форма с файлом заданного размера — потоком, с объявленной длиной, как её
 * отправляет браузер. Полгигабайта в памяти держать незачем.
 */
function streamForm(form, size, origin = ALLOWED) {
  const boundary = `----w06${Date.now()}`;
  let head = '';
  for (const [k, v] of Object.entries(form.fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  head +=
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.pdf"\r\n` +
    'Content-Type: application/pdf\r\n\r\n';
  const headBuf = Buffer.from(head);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const url = new URL(form.url);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': headBuf.length + size + tail.length,
          Origin: origin,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () =>
          resolve({ status: res.statusCode, code: text.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? '' }),
        );
      },
    );
    // Отказ до конца передачи (413) закрывает соединение — это ответ, а не сбой прогона.
    req.on('error', (error) => resolve({ status: 0, code: error.code ?? error.message }));
    req.write(headBuf);
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    chunk.write('%PDF-1.4 ');
    let left = size;
    const pump = () => {
      while (left > 0) {
        const part = left >= chunk.length ? chunk : chunk.subarray(0, left);
        left -= part.length;
        if (!req.write(part)) return void req.once('drain', pump);
      }
      req.end(tail);
    };
    pump();
  });
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.warn(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// --quick — для рабочего сервера: без файла 500 МиБ и предела Caddy, свои
// пробные объекты удаляются в конце (просьба Томаса не копить пробные данные).
const QUICK = process.argv.includes('--quick');
const created = [];
const key = (label) => {
  const k = `${QUICK ? 'files-check' : 'w06-probe'}/${label}-${Date.now()}`;
  created.push(k);
  return k;
};
const pdf = (n = 64) => Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(n, 'x')]);

async function postForm(
  form,
  bytes,
  { origin = ALLOWED, type = 'application/pdf', drop = [] } = {},
) {
  const body = new FormData();
  for (const [k, v] of Object.entries(form.fields)) if (!drop.includes(k)) body.append(k, v);
  body.append('file', new Blob([bytes], { type }), 'x.pdf');
  const r = await fetch(form.url, {
    method: 'POST',
    body,
    headers: { Origin: origin },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  return {
    status: r.status,
    acao: r.headers.get('access-control-allow-origin'),
    acac: r.headers.get('access-control-allow-credentials'),
    code: text.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? '',
  };
}

const sign = (label, opts = {}) =>
  s3.presignUpload({
    key: opts.key ?? key(label),
    contentType: 'application/pdf',
    maxBytes: opts.maxBytes ?? 10 * 1024 * 1024,
    ttlSeconds: opts.ttl ?? 900,
  });

console.warn(`\n=== ВХОД ФАЙЛОВ: ${FILES_URL} (бакет ${BUCKET}) ===\n`);

console.warn('▸ Форма подписана на публичный адрес');
const probe = sign('addr');
check('адрес формы — публичный', probe.url.startsWith(FILES_URL), probe.url);

console.warn('▸ CORS: предварительный запрос');
for (const [origin, allowed] of [
  [ALLOWED, true],
  [FOREIGN, false],
]) {
  const r = await fetch(`${FILES_URL}/${BUCKET}`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const acao = r.headers.get('access-control-allow-origin');
  check(
    allowed ? `разрешённый сайт ${origin} — разрешение` : `чужой сайт ${origin} — отказ`,
    allowed ? r.status === 204 && acao === origin : r.status >= 400 && !acao,
    `HTTP ${r.status}, Allow-Origin: ${acao ?? '—'}`,
  );
}

console.warn('▸ Загрузка формой');
const okKey = key('ok');
const ok = await postForm(sign('ok', { key: okKey }), pdf());
check('PDF по действующей форме принят', ok.status === 204, `HTTP ${ok.status} ${ok.code}`);
check('ответ разрешает читать только своему сайту', ok.acao === ALLOWED, ok.acao ?? '—');
check('без разрешения на куки', !ok.acac, ok.acac ?? '—');
check('объект в хранилище', (await s3.headObject(okKey)).exists);
if (QUICK) {
  const back = await s3.getObject(okKey);
  check(
    'объект читается тем же содержимым',
    Boolean(back) && Buffer.compare(back.body, pdf()) === 0,
    back ? `${back.body.length} байт` : 'нет объекта',
  );
}
const foreign = await postForm(sign('foreign'), pdf(), { origin: FOREIGN });
check(
  'чужой сайт ответа не получает (CORS не авторизация: форма своя — объект принят)',
  !foreign.acao,
  `HTTP ${foreign.status}, Allow-Origin: ${foreign.acao ?? '—'}`,
);

console.warn('▸ Право загрузки держит форма, а не CORS');
// Отказ — это ошибка 4xx И отсутствие объекта. Код ответа у хранилищ разный:
// MinIO отвечал 403, Garage на чужой тип и истёкшую форму — 400
// InvalidRequest; смысл проверки не в коде, а в том, что объекта нет.
const refused = async (r, objectKey) =>
  r.status >= 400 && r.status < 500 && !(await s3.headObject(objectKey)).exists;
const unsignedForm = sign('unsigned');
const unsigned = await postForm(unsignedForm, pdf(), {
  drop: ['policy', 'x-amz-signature', 'x-amz-credential', 'x-amz-algorithm', 'x-amz-date'],
});
check(
  'без подписи — отказ, объекта нет',
  await refused(unsigned, unsignedForm.fields.key),
  `HTTP ${unsigned.status} ${unsigned.code}`,
);
const forged = sign('forged');
forged.fields['x-amz-signature'] = '0'.repeat(64);
const bad = await postForm(forged, pdf());
check(
  'с поддельной подписью — отказ, объекта нет',
  await refused(bad, forged.fields.key),
  `HTTP ${bad.status} ${bad.code}`,
);
const typeForm = sign('type2');
typeForm.fields['Content-Type'] = 'text/html';
const typed = await postForm(typeForm, pdf(), { type: 'text/html' });
check(
  'чужой тип — отказ, объекта нет',
  await refused(typed, typeForm.fields.key),
  `HTTP ${typed.status} ${typed.code}`,
);
const bigForm = sign('big', { maxBytes: 100 });
const big = await postForm(bigForm, pdf(400));
check(
  'сверх размера формы — отказ, объекта нет',
  await refused(big, bigForm.fields.key),
  `HTTP ${big.status} ${big.code}`,
);
const shortForm = s3.presignUpload({
  key: key('short'),
  contentType: 'application/pdf',
  maxBytes: 1024 * 1024,
  ttlSeconds: 60,
});
console.warn('  ·     ждём истечения формы на 60 с…');
await new Promise((r) => setTimeout(r, 65_000));
const late = await postForm(shortForm, pdf());
check(
  'после срока формы — отказ, объекта нет',
  await refused(late, shortForm.fields.key),
  `HTTP ${late.status} ${late.code}`,
);
if (!QUICK) {
  console.warn('▸ Настоящие пределы размера');
  // Наибольший разрешённый материал проходит через вход целиком. Проверка на
  // уменьшенном пределе это не ловила: «520MB» у Caddy — десятичные мегабайты,
  // меньше 500 МиБ контракта (замечание Тэнка при приёмке W06).
  const maxKey = key('max');
  const atMax = await streamForm(sign('max', { key: maxKey, maxBytes: MAX_FILE }), MAX_FILE);
  check(
    `наибольший разрешённый файл (${MAX_FILE} байт) принят`,
    atMax.status === 204,
    `HTTP ${atMax.status} ${atMax.code}`,
  );
  const stored = await s3.headObject(maxKey);
  check(
    'и сохранён целиком',
    stored.exists && stored.sizeBytes === MAX_FILE,
    `${stored.sizeBytes}`,
  );
  const over = await streamForm(
    sign('over', { maxBytes: CADDY_MAX + 16 * 1024 * 1024 }),
    CADDY_MAX + 1024 * 1024,
  );
  check(
    `сверх предела тела Caddy (${CADDY_MAX} байт) — 413`,
    over.status === 413,
    `HTTP ${over.status}`,
  );
}

console.warn('▸ Закрыто всё, кроме приёма формы');
const closed = [
  ['GET', `/${BUCKET}/${okKey}`, 'чтение объекта'],
  ['HEAD', `/${BUCKET}/${okKey}`, 'заголовки объекта'],
  ['GET', `/${BUCKET}`, 'список бакета'],
  ['GET', `/${BUCKET}?list-type=2`, 'список бакета v2'],
  ['GET', '/', 'список бакетов'],
  ['PUT', `/${BUCKET}/w06-probe/put-${Date.now()}`, 'запись мимо формы'],
  ['DELETE', `/${BUCKET}/${okKey}`, 'удаление'],
  ['GET', '/minio/health/live', 'служебные адреса MinIO'],
  ['GET', '/minio/admin/v3/info', 'администрирование MinIO'],
  ['GET', '/browser', 'консоль MinIO'],
];
for (const [method, path, label] of closed) {
  const r = await fetch(`${FILES_URL}${path}`, {
    method,
    headers: { Origin: ALLOWED },
    body: method === 'PUT' ? 'x' : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  check(`${label} — 404`, r.status === 404, `${method} ${path} → ${r.status}`);
}
check('объект после попытки удаления на месте', (await s3.headObject(okKey)).exists);

if (QUICK) {
  console.warn('▸ Уборка пробных объектов');
  for (const k of created) await s3.deleteObject(k).catch(() => undefined);
  const left = [];
  for (const k of created) if ((await s3.headObject(k)).exists) left.push(k);
  check(`пробные объекты удалены (${created.length})`, left.length === 0, left.join(', '));
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
