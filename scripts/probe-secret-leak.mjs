#!/usr/bin/env node
// Ищет ФАКТИЧЕСКИЕ значения секретов из .env во всех объектах git-репозитория.
//
// Зачем отдельно от gitleaks. Замер на стенде 2026-08-12: транскрипт, в котором
// значение POSTGRES_PASSWORD (24 символа) процитировано в тексте ответа агента,
// попал в git-объекты как есть — а `gitleaks detect` вернул 0. Сигнатурный
// сканер ищет узнаваемые формы и связку «ключевое слово рядом со значением»;
// секрет, упомянутый в свободном тексте, он не видит. Поэтому «gitleaks чисто»
// не является доказательством отсутствия утечки ключевого материала.
//
// Этот зонд сравнивает объекты репозитория с реальными значениями из .env
// побайтово — ложноотрицательных срабатываний по известным секретам у него нет.
//
// Значения секретов НИКОГДА не печатаются: в вывод идут только имя переменной,
// длина и идентификатор объекта.
//
// Запуск:  npm run probe:secret-leak
// Код возврата 1 — найдена утечка.

import { readFileSync, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, process.env.SECRET_LEAK_ENV ?? '.env');
const REPO = resolve(process.env.SECRET_LEAK_REPO ?? ROOT);

const SECRET_NAME =
  /(PASSWORD|SECRET|TOKEN|SIGNING_KEY|ACCESS_KEY|^KEK_|DATABASE_URL|_DSN$|CREDENTIAL)/;
const MIN_LEN = 8;
const PLACEHOLDER = /^(changeme|placeholder|example|test|dummy|none|null|undefined|true|false)$/i;

// Файлы, которые ПО ЗАМЫСЛУ содержат значения для локального стенда. Совпадение
// с ними означает, что значение опубликовано намеренно и секретом не является:
// поднять стенд по этим файлам может любой, кто склонировал репозиторий.
// Если такое значение подставить в боевое окружение, оно перестанет совпадать
// с умолчанием — и зонд снова начнёт его защищать.
const PUBLISHED_DEFAULT_SOURCES = ['.env.example', 'infra/docker-compose.yml'];
const ALLOW_PATH = resolve(ROOT, '.secret-leak-allow.json');

function parseEnv(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const name = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length > 1)
      value = value.slice(1, -1);
    out.push({ name, value });
  }
  return out;
}

if (!existsSync(ENV_PATH)) {
  console.error(`не найден файл окружения: ${ENV_PATH}`);
  process.exit(1);
}

const secrets = parseEnv(readFileSync(ENV_PATH, 'utf8')).filter(
  (e) => SECRET_NAME.test(e.name) && e.value.length >= MIN_LEN && !PLACEHOLDER.test(e.value),
);

if (secrets.length === 0) {
  console.error(
    'в .env не нашлось значений, подходящих под критерии — зонд бесполезен, проверь фильтр',
  );
  process.exit(1);
}

// Несколько имён могут делить одно значение — группируем, чтобы сообщить все имена.
const byValue = new Map();
for (const s of secrets) {
  if (!byValue.has(s.value)) byValue.set(s.value, []);
  byValue.get(s.value).push(s.name);
}
const values = [...byValue.keys()];
const maxLen = Math.max(...values.map((v) => v.length));

// Карта объектов: id -> тип, чтобы назвать место находки.
const objectList = execFileSync(
  'git',
  ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'],
  {
    cwd: REPO,
    maxBuffer: 1 << 28,
    encoding: 'utf8',
  },
);
const objectCount = objectList.split('\n').filter(Boolean).length;

// Где искать: ссылки, содержащие объект, определить дорого — сообщаем сам объект.
const hits = new Map(); // value -> Set(objectId)

await new Promise((resolvePromise, rejectPromise) => {
  const child = spawn('git', ['cat-file', '--batch-all-objects', '--batch'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  // Поток объектов разбираем как единый текст со скользящим хвостом: значение
  // может попасть на границу двух чанков.
  let tail = '';
  let currentObject = 'неизвестен';
  const headerRe = /^([0-9a-f]{40,64}) (blob|commit|tree|tag) (\d+)$/gm;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    const text = tail + chunk;
    let m;
    headerRe.lastIndex = 0;
    while ((m = headerRe.exec(text)) !== null) currentObject = m[1];
    for (const v of values) {
      if (text.includes(v)) {
        if (!hits.has(v)) hits.set(v, new Set());
        hits.get(v).add(currentObject);
      }
    }
    tail = text.slice(-(maxLen - 1));
  });
  child.on('error', rejectPromise);
  child.on('close', () => resolvePromise());
});

// Классификация находок.
const publishedText = PUBLISHED_DEFAULT_SOURCES.map((p) => {
  const full = resolve(REPO, p);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
}).join('\n');

let allowed = new Map();
if (existsSync(ALLOW_PATH)) {
  const parsed = JSON.parse(readFileSync(ALLOW_PATH, 'utf8'));
  for (const entry of parsed.allow ?? [])
    allowed.set(entry.name, entry.reason ?? 'без указания причины');
}

const leaks = [];
const published = [];
const accepted = [];
for (const [value, objs] of hits) {
  const names = byValue.get(value);
  const record = { names, len: value.length, objs };
  if (publishedText.includes(value)) published.push(record);
  else if (names.every((n) => allowed.has(n)))
    accepted.push({ ...record, reason: allowed.get(names[0]) });
  else leaks.push(record);
}

console.warn(`репозиторий: ${REPO}`);
console.warn(`объектов проверено: ${objectCount}`);
console.warn(
  `секретов из .env в проверке: ${secrets.length} (различных значений ${values.length})`,
);
console.warn('');

if (published.length) {
  console.warn(
    `опубликованные умолчания стенда — не секреты (${PUBLISHED_DEFAULT_SOURCES.join(', ')}):`,
  );
  for (const r of published) console.warn(`  ${r.names.join(' / ')} (длина ${r.len})`);
  console.warn('');
}

if (accepted.length) {
  console.warn('принято осознанно (.secret-leak-allow.json):');
  for (const r of accepted) console.warn(`  ${r.names.join(' / ')} (длина ${r.len}) — ${r.reason}`);
  console.warn('');
}

if (leaks.length === 0) {
  console.warn('УТЕЧЕК НЕ НАЙДЕНО: ключевой материал из .env в объектах репозитория отсутствует.');
  process.exit(0);
}

console.error('НАЙДЕНА УТЕЧКА — значения из .env присутствуют в объектах репозитория:');
for (const r of leaks) {
  console.error(
    `  ${r.names.join(' / ')} (длина ${r.len}) — объектов: ${r.objs.size}, например ${[...r.objs][0]}`,
  );
}
console.error('');
console.error('Значения скомпрометированы: объект в git невозможно считать приватным.');
console.error('Требуется ротация перечисленных секретов и вычистка объектов из истории.');
process.exit(1);
