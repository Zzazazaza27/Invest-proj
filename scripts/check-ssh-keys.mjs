#!/usr/bin/env node
// Гейт: приватные SSH-ключи не уходят из локальной папки .ssh/ (Ф58).
//
// Правило владельца: ключ доступа к серверу лежит в `<корень>/.ssh/` и НИКОГДА
// не покидает машину — ни коммитом, ни пушем, ни чекпоинтом сессии.
//
// Одного `.gitignore` для этого мало. В проекте уже был случай, когда секрет
// ушёл на origin не через историю проекта, а через ветку чекпоинтов Entire
// (Ф47/Ф50): она пишется каждую сессию, её пушит хук `pre-push`, и правила
// `.gitignore` на неё не распространяются. Поэтому проверка смотрит четыре
// канала утечки, а не один:
//
//   1. `.ssh/` действительно игнорируется git (правило не потеряно при правке);
//   2. под `.ssh/` нет ни одного ОТСЛЕЖИВАЕМОГО файла и ничего в индексе;
//   3. в рабочем дереве нет приватного ключа ВНЕ `.ssh/` (забытая копия);
//   4. ни в одном объекте ЛЮБОЙ ветки (включая `entire/*`) нет ни маркера
//      приватного ключа, ни публичной части наших пар — публичная часть здесь
//      не секрет, а отпечаток: если она нашлась в истории, значит рядом
//      когда-то лежала и приватная.
//
// Запуск: node scripts/check-ssh-keys.mjs   (npm run gate:ssh-keys)

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SSH_DIR = resolve(ROOT, '.ssh');

const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, ...opts });

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  FAIL  ${msg}`);
};
const ok = (msg) => console.warn(`  ok  ${msg}`);

// Заголовок PEM-блока любого формата: OPENSSH, RSA, EC, DSA, PGP, ENCRYPTED,
// а также голый PKCS#8 `-----BEGIN PRIVATE KEY-----`.
const PEM_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----/g;

// Сколько символов base64 должно идти следом, чтобы считать блок ключом.
// Самый короткий реальный приватный ключ (ed25519 в формате OpenSSH) даёт
// около 380 символов тела; 100 взято с большим запасом вниз.
const BODY_MIN_CHARS = 100;

/**
 * Ищет НАСТОЯЩИЕ блоки приватного ключа и возвращает их типы.
 *
 * Почему не поиск подстроки `BEGIN RSA PRIVATE KEY`: эта строка встречается в
 * исходнике самого гейта (список выше) и, следовательно, в транскриптах сессий,
 * где гейт писался. Первый же прогон дал 25 таких срабатываний — все на
 * собственном коде в объектах ветки `entire/*`, ни одного настоящего ключа.
 * Гейт, который краснеет на упоминании, обходят не починкой, а исключением.
 *
 * Ключом маркер делает обрамление дефисами и base64-тело следом. Транскрипты
 * Entire — это JSONL, переводы строк в них экранированы (`\n` двумя символами),
 * поэтому перед измерением тела экранирование снимается: иначе настоящий ключ,
 * утёкший именно этим каналом, прошёл бы мимо.
 */
const findPrivateKeyBlocks = (text) => {
  const found = [];
  PEM_BEGIN.lastIndex = 0;
  let match;
  while ((match = PEM_BEGIN.exec(text)) !== null) {
    const from = match.index + match[0].length;
    const tail = text
      .slice(from, from + 16384)
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n');

    // Закрывающая строка обязательна. Без неё это упоминание формата в тексте,
    // а не ключ: настоящий PEM всегда закрыт, и 16 КБ хватает даже RSA-4096.
    const end = tail.indexOf('-----END');
    if (end === -1) continue;

    // Тело считается по ЦЕЛЫМ строкам чистого base64. Считать «телом» всё, из
    // чего вычеркнуты не-base64 символы, нельзя: под это подходит любой текст,
    // включая исходный код — на этом гейт и краснел на самом себе.
    let body = 0;
    for (const line of tail.slice(0, end).split('\n')) {
      const s = line.trim();
      if (!s) continue;
      if (/^[A-Za-z0-9+/=]{16,}$/.test(s)) body += s.length;
      else if (body > 0) break; // тело кончилось
      // строки до тела — заголовки PEM (Proc-Type, DEK-Info) — пропускаем
    }
    if (body >= BODY_MIN_CHARS && !found.includes(match[1])) found.push(match[1]);
  }
  return found;
};

console.warn('Гейт: приватные SSH-ключи не покидают .ssh/\n');

// --- 1. правило в .gitignore живо ---------------------------------------------
// Проверяем не текстом файла, а поведением git: правило можно записать
// по-разному, значение имеет только результат.
{
  const probe = join(SSH_DIR, '.gate-probe');
  let ignored;
  try {
    if (!existsSync(SSH_DIR)) {
      console.warn('  .ssh/ отсутствует — проверка правила по пробному пути');
    }
    writeFileSync(probe, 'probe\n');
    try {
      git(['check-ignore', '-q', '.ssh/.gate-probe']);
      ignored = true;
    } catch {
      ignored = false;
    }
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      /* пробник мог не создаться — это не ошибка гейта */
    }
  }
  if (ignored) ok('.ssh/ игнорируется git');
  else fail('.ssh/ НЕ игнорируется git — добавь `.ssh/` в .gitignore');
}

// --- 2. ничего из .ssh/ не отслеживается и не лежит в индексе ------------------
{
  const tracked = git(['ls-files', '--', '.ssh'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (tracked.length === 0) ok('под .ssh/ нет отслеживаемых файлов');
  else for (const p of tracked) fail(`файл под .ssh/ отслеживается git: ${p}`);

  const staged = git(['diff', '--cached', '--name-only'])
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('.ssh/'));
  if (staged.length === 0) ok('в индексе нет путей из .ssh/');
  else for (const p of staged) fail(`путь из .ssh/ добавлен в индекс: ${p}`);
}

// --- 3. приватного ключа нет в рабочем дереве вне .ssh/ ------------------------
// Смотрим только отслеживаемые файлы: именно они уходят в коммит. Забытая
// копия ключа среди них — прямая дорога на origin.
{
  const files = git(['ls-files'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  let found = 0;
  for (const rel of files) {
    const abs = resolve(ROOT, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // файл в индексе, но удалён из дерева
    }
    if (!st.isFile() || st.size > 1 << 20) continue;
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue; // бинарь
    }
    const blocks = findPrivateKeyBlocks(text);
    if (blocks.length > 0) {
      found += 1;
      fail(`приватный ключ в отслеживаемом файле: ${rel} (${blocks.join(', ')})`);
    }
  }
  if (found === 0) ok('приватных ключей среди отслеживаемых файлов нет');
}

// --- 4. материал ключа отсутствует во всех объектах всех веток ----------------
// Публичные части локальных пар — отпечаток для поиска. Их «утечка» сама по
// себе безвредна, но означает, что каталог .ssh/ когда-то попадал в историю.
const publicBlobs = [];
if (existsSync(SSH_DIR)) {
  for (const name of readdirSync(SSH_DIR)) {
    if (!name.endsWith('.pub')) continue;
    const parts = readFileSync(join(SSH_DIR, name), 'utf8').trim().split(/\s+/);
    if (parts.length >= 2 && parts[1].length > 40) publicBlobs.push({ name, blob: parts[1] });
  }
}
console.warn(
  `  локальных публичных ключей для поиска: ${publicBlobs.length}` +
    (publicBlobs.length ? ` (${publicBlobs.map((p) => p.name).join(', ')})` : ''),
);

{
  // Только ДОСТИЖИМЫЕ объекты — из всех веток сразу, включая `entire/*`.
  //
  // Не `--batch-all-objects`: тот перечисляет и недостижимые объекты, а они на
  // origin не уходят — push отправляет то, что достижимо из ссылок. Разница не
  // теоретическая: `git add` файла, который потом убрали из индекса, оставляет
  // висячий блоб, и на нём проверка краснела бы вечно, не отражая никакого
  // риска. Канал «файл в индексе» закрывают проверки 2 и 3 выше.
  const reachable = new Set();
  for (const line of git(['rev-list', '--objects', '--all']).split('\n')) {
    const sha = line.split(' ')[0];
    if (sha) reachable.add(sha);
  }
  const catalogue = git(['cat-file', '--batch-check'], {
    input: [...reachable].join('\n') + '\n',
  })
    .split('\n')
    .map((line) => line.split(' '))
    .filter((p) => p[1] === 'blob' && Number(p[2]) > 0 && Number(p[2]) <= 1 << 20)
    .map((p) => p[0]);

  console.warn(`  объектов-блобов к проверке: ${catalogue.length}`);

  let hits = 0;
  // Читаем пачками через один процесс `cat-file --batch`: пообъектный запуск
  // git на нескольких тысячах блобов занимает минуты.
  //
  // Ответ разбирается по ЗАГОЛОВКАМ (`<sha> blob <размер>\n<содержимое>\n`), а
  // не поиском подстроки по всей пачке: так объект-нарушитель известен сразу и
  // повторный проход по пачке не нужен. Прежняя версия при каждом попадании
  // перечитывала все 500 объектов пачки поштучно — отсюда и брались минуты.
  // Размер берётся в БАЙТАХ, поэтому пачка читается буфером, а не строкой.
  const CHUNK = 500;
  for (let i = 0; i < catalogue.length; i += CHUNK) {
    const chunk = catalogue.slice(i, i + CHUNK);
    // `encoding: null` — чтобы stdout пришёл буфером: размер в заголовке задан
    // в байтах. Вход подаётся тоже буфером: при `encoding: null` строку на
    // входе node декодировать отказывается.
    const dump = git(['cat-file', '--batch'], {
      input: Buffer.from(chunk.join('\n') + '\n', 'utf8'),
      encoding: null,
    });

    let off = 0;
    while (off < dump.length) {
      const nl = dump.indexOf(0x0a, off);
      if (nl === -1) break;
      const header = dump.toString('utf8', off, nl).split(' ');
      const [sha, type, size] = [header[0], header[1], Number(header[2])];
      if (type !== 'blob' || !Number.isFinite(size)) {
        off = nl + 1; // `<sha> missing` и прочее, чего мы не запрашивали
        continue;
      }
      const content = dump.toString('utf8', nl + 1, nl + 1 + size);
      off = nl + 1 + size + 1; // за содержимым идёт перевод строки

      for (const kind of findPrivateKeyBlocks(content)) {
        hits += 1;
        fail(`ПРИВАТНЫЙ ключ (${kind}) найден в объекте ${sha.slice(0, 10)}`);
      }
      for (const pub of publicBlobs) {
        if (!content.includes(pub.blob)) continue;
        hits += 1;
        fail(`публичная часть ${pub.name} найдена в объекте ${sha.slice(0, 10)}`);
      }
    }
  }
  if (hits === 0) ok('в объектах репозитория (включая ветки чекпоинтов) материала ключей нет');
}

if (failures === 0) {
  console.warn('\nИтог: приватные ключи из .ssh/ никуда не уходят.');
  process.exit(0);
}

console.error(`\nИтог: ${failures} нарушений.`);
console.error(
  'Действия: убрать путь из индекса (git rm --cached), вернуть правило `.ssh/`\n' +
    'в .gitignore. Если ключ уже попал в объекты — считать его скомпрометированным:\n' +
    'сгенерировать новый, снять старый с authorized_keys на серверах, и только\n' +
    'потом чистить историю.',
);
process.exit(1);
