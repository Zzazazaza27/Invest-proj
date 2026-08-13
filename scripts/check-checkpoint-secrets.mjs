#!/usr/bin/env node
// Гейт: в ветках чекпоинтов Entire нет секретов (Ф47).
//
// Внешний аудит №2 утверждал, что ветка `entire/checkpoints/v1` держит на
// remote старые скомпрометированные KEK и потому подлежит перезаписи. Проверка
// всех объектов репозитория этого НЕ подтвердила (см. отчёт фазы): ни текущих
// значений `.env`, ни присвоений вида `KEK_*=<значение>` в объектах нет —
// редакция Entire (Ф25) и ротация ключей отработали.
//
// Разовая проверка, однако, ничего не гарантирует завтра: ветка чекпоинтов
// пишется КАЖДУЮ сессию и уходит на origin. Поэтому проверка сделана
// постоянной — это и есть закрытие класса проблемы вместо удаления ветки,
// которая пересоздалась бы при следующем же чекпоинте.
//
// Что проверяется:
//   1. фактические значения секретов из `.env` — побайтово, как в
//      `probe-secret-leak` (тот смотрит рабочее дерево и main, этот — ветки
//      чекпоинтов);
//   2. присвоения секретных ИМЁН непустым значением — ловит и те секреты,
//      которых в текущем `.env` уже нет (ротированные, чужие, временные).
//
// Запуск: node scripts/check-checkpoint-secrets.mjs
// В CI не запускается: там нет ни `.env`, ни веток `entire/*`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });

/** Имена, значения которых являются секретами. Адреса и идентификаторы — нет. */
// ACCESS_KEY_ID здесь НЕТ намеренно: идентификатор учётной записи хранилища
// публичен по построению (он в .env.example и в политиках MinIO), и считать
// его утечкой значит красить гейт на каждой сессии.
const SECRET_NAME = /(PASSWORD|SECRET|_KEY$|^KEK_|SIGNING|_TOKEN$|CLIENT_SECRET)/;

/**
 * Значения-заглушки: они существуют ради читаемости примеров и попадают в
 * документацию намеренно. Считать их утечкой — сделать гейт шумным, а шумный
 * гейт отключают.
 */
// Заглушки и заведомо не-боевые значения. Список выведен из ФАКТИЧЕСКИХ
// срабатываний первого прогона: fallback'и compose (`${VAR:-local_dev_only_…}`
// разбираются как значение, начинающееся с дефиса), CI-плейсхолдеры,
// временные учётки зондов. Гейт, красный на заглушках, отключат — и он не
// поймает настоящую утечку.
const PLACEHOLDER =
  /^(-|CHANGE_ME|SAMPLE|sample|EXAMPLE|example|local_dev_only|ci_only|placeholder|probe_|dev_|test_|dummy|\$\{|<)/;

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  ПРОВАЛ  ${msg}`);
};

console.warn('\n=== СЕКРЕТЫ В ВЕТКАХ ЧЕКПОИНТОВ ===\n');

const branches = git(['for-each-ref', '--format=%(refname)'])
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s.includes('entire/'));

if (branches.length === 0) {
  console.warn('  веток чекпоинтов нет — проверять нечего');
  process.exit(0);
}
console.warn(`  веток чекпоинтов: ${branches.length}`);

// --- значения из .env (если файл есть) ---------------------------------------
const envPath = resolve(ROOT, '.env');
const envSecrets = [];
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!SECRET_NAME.test(name)) continue;
    if (value.length < 12 || PLACEHOLDER.test(value)) continue;
    envSecrets.push({ name, value });
  }
  console.warn(`  секретов из .env для поиска: ${envSecrets.length}`);
} else {
  console.warn('  .env отсутствует — поиск фактических значений пропущен');
}

// --- объекты всех веток чекпоинтов -------------------------------------------
const objects = new Set();
for (const branch of branches) {
  for (const line of git(['rev-list', '--objects', branch]).split('\n')) {
    const sha = line.split(' ')[0];
    if (sha && line.includes(' ')) objects.add(sha);
  }
}
console.warn(`  объектов к проверке: ${objects.size}\n`);

// `[ \t]*`, а не `\s*`: перевод строки в разделителе означал, что у ПУСТОЙ
// переменной (`FOO=\nBAR=`) значением считалось имя следующей — .env.example
// с незаполненными полями давал ложные срабатывания (поймано первым же
// прогоном по объектам).
const ASSIGNMENT =
  /([A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|SIGNING_KEY|TOKEN|ACCESS_KEY|KEK_[A-Z_]+))[ \t]*[=:][ \t]*["']?([A-Za-z0-9+/=_-]{16,200})/g;

let leaked = 0;
let assignments = 0;
for (const sha of objects) {
  let content;
  try {
    content = git(['cat-file', '-p', sha]);
  } catch {
    continue; // не blob (дерево/коммит) либо бинарь — пропускаем
  }

  for (const secret of envSecrets) {
    if (content.includes(secret.value)) {
      leaked += 1;
      fail(`фактическое значение ${secret.name} найдено в объекте ${sha.slice(0, 10)}`);
      break;
    }
  }

  let match;
  while ((match = ASSIGNMENT.exec(content)) !== null) {
    const [, name, value] = match;
    if (PLACEHOLDER.test(value)) continue;
    // `${NAME:-…}` — подстановка переменной с запасным значением, а не секрет.
    if (content.slice(Math.max(0, match.index - 2), match.index) === '${') continue;
    // ПУСТАЯ переменная в .env-подобном файле: `FOO=\nBAR=` — регулярное
    // выражение видит имя следующей переменной как значение первой. Имя в
    // ВЕРХНЕМ регистре с подчёркиваниями значением секрета не бывает.
    if (/^[A-Z][A-Z0-9_]*$/.test(value)) continue;
    if (/REDACTED/.test(value)) continue;
    assignments += 1;
    fail(
      `присвоение ${name} непустым значением (длина ${value.length}) в объекте ${sha.slice(0, 10)}`,
    );
  }
}

if (failures === 0) {
  console.warn('  ok  фактических значений секретов нет');
  console.warn('  ok  присвоений секретных имён нет');
  console.warn('\nИтог: ветки чекпоинтов чисты.');
  process.exit(0);
}

console.error(`\nИтог: ${leaked} фактических утечек, ${assignments} подозрительных присвоений.`);
console.error(
  'Действия: пересобрать пак редакции (npm run secrets:redactors), ротировать\n' +
    'засветившиеся значения и переписать историю ветки чекпоинтов на origin.',
);
process.exit(1);
