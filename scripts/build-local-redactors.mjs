#!/usr/bin/env node
// Генерирует локальный пак редакции Entire из фактических значений .env.
//
// Зачем. Пак .entire/redactors/project-secrets.yaml закрывает присваивания вида
// ИМЯ=значение и длинный ключевой материал. Он принципиально не закрывает один
// класс: секрет, процитированный в свободном тексте без имени рядом и короче
// 43 символов — например «пароль базы R7hkt…». Ни одно обобщённое правило не
// отличит такую строку от обычного идентификатора, не выжигая заодно половину
// транскрипта. Единственное надёжное средство — точное совпадение со значением.
//
// Замерено на стенде 2026-08-12: без этого пака значение POSTGRES_PASSWORD,
// упомянутое в тексте ответа агента, попадает в git-объекты как есть.
//
// Файл на выходе СОДЕРЖИТ секреты в открытом виде и обязан оставаться
// незакоммиченным. Скрипт откажется писать, если каталог назначения перестал
// игнорироваться git.
//
// Запуск после каждой ротации секретов:  npm run secrets:redactors

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, process.argv[2] ?? '.env');
const OUT_DIR = resolve(ROOT, '.entire/redactors/local');
const OUT_PATH = resolve(OUT_DIR, 'env-values.yaml');

// Имена, значения которых считаем секретами. Осознанно узкий список: редактировать
// значение вроде NODE_ENV=development нельзя — это выжжет слово в любом тексте.
const SECRET_NAME =
  /(PASSWORD|SECRET|TOKEN|SIGNING_KEY|ACCESS_KEY|^KEK_|DATABASE_URL|_DSN$|CREDENTIAL)/;
// Значения короче этого не редактируем: слишком высок риск совпасть с обычным словом.
const MIN_LEN = 8;
// Заглушки, которые незачем редактировать.
const PLACEHOLDER = /^(changeme|placeholder|example|test|dummy|none|null|undefined|true|false)$/i;

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
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length > 1) {
      value = value.slice(1, -1);
    }
    out.push({ name, value });
  }
  return out;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const yamlSingleQuote = (s) => `'${s.replace(/'/g, "''")}'`;
const ruleId = (name) => name.toLowerCase().replace(/[^a-z0-9._-]/g, '-');

function assertIgnored(path) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!existsSync(ENV_PATH)) {
  console.error(`не найден файл окружения: ${ENV_PATH}`);
  process.exit(1);
}

const entries = parseEnv(readFileSync(ENV_PATH, 'utf8'));
const selected = entries.filter(
  (e) => SECRET_NAME.test(e.name) && e.value.length >= MIN_LEN && !PLACEHOLDER.test(e.value),
);

// Длинные значения — вперёд: если одно значение является префиксом другого,
// сначала должно сработать более длинное правило.
selected.sort((a, b) => b.value.length - a.value.length || a.name.localeCompare(b.name));

const seen = new Set();
const rules = [];
for (const e of selected) {
  if (seen.has(e.value)) continue; // одно и то же значение у двух имён — одно правило
  seen.add(e.value);
  rules.push(e);
}

if (rules.length === 0) {
  console.error('в файле окружения не нашлось значений, подходящих под критерии');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

if (!assertIgnored(OUT_PATH)) {
  console.error(
    `ОТКАЗ: ${OUT_PATH} не игнорируется git.\n` +
      'Файл содержит секреты в открытом виде. Восстанови правило redactors/local/ ' +
      'в .entire/.gitignore и запусти снова.',
  );
  process.exit(1);
}

const header = [
  '# СГЕНЕРИРОВАНО scripts/build-local-redactors.mjs — руками не править.',
  '# Файл содержит ЗНАЧЕНИЯ секретов из .env в открытом виде.',
  '# Не коммитить: каталог .entire/redactors/local/ должен оставаться в .gitignore.',
  '# Пересобрать после ротации секретов: npm run secrets:redactors',
  `# Источник: ${ENV_PATH.replace(ROOT, '.')}`,
  'name: env-values',
  'version: 1.0.0',
  'description: Точные значения секретов окружения (локальный, некоммитируемый пак)',
  'rules:',
].join('\n');

const body = rules
  .map((e) =>
    [
      `  - id: env-${ruleId(e.name)}`,
      `    description: Точное значение ${e.name}`,
      `    regex: ${yamlSingleQuote(escapeRegex(e.value))}`,
    ].join('\n'),
  )
  .join('\n');

writeFileSync(OUT_PATH, `${header}\n${body}\n`, 'utf8');

console.warn(`записан ${OUT_PATH.replace(ROOT, '.')}`);
console.warn(`правил: ${rules.length} (из ${entries.length} записей окружения)`);
console.warn('покрытые имена:');
for (const e of rules) console.warn(`  ${e.name} (длина значения ${e.value.length})`);
const skipped = entries.filter((e) => SECRET_NAME.test(e.name) && !rules.includes(e));
if (skipped.length) {
  console.warn('пропущено (пусто, заглушка, дубль значения или короче минимума):');
  for (const e of skipped) console.warn(`  ${e.name} (длина ${e.value.length})`);
}
