#!/usr/bin/env node
/**
 * Ротация секретов локального стенда (Ф26).
 *
 * Разносит переиспользованные значения: каждой службе и каждому вебхуку —
 * своё случайное значение. Новые значения НИКОГДА не печатаются: генерируются
 * в памяти, пишутся напрямую в `.env` (как `rotate-kek.mjs --write-env`) и в
 * контейнер уходят через stdin, а не через argv.
 *
 * Что ротируется:
 *   - POSTGRES_PASSWORD (+ DATABASE_URL_OWNER, DATABASE_URL_TEST — пароль
 *     владельца входит в эти URL) — с ALTER ROLE в работающем postgres;
 *   - REDIS_PASSWORD, NATS_PASSWORD — конфигурация контейнеров, пересоздание;
 *   - MINIO_ROOT_PASSWORD — MinIO читает root-учётку из env при старте;
 *   - S3_ACCESS_KEY_ID → `unicorn_app` + новый S3_SECRET_ACCESS_KEY —
 *     отдельная учётка приложения, создаётся minio-init (не root!);
 *   - KEYCLOAK_ADMIN_PASSWORD — bootstrap-учётка (действует на первый старт);
 *   - OIDC_CLIENT_SECRET, PAYMENT_PROVIDER_WEBHOOK_SECRET,
 *     NOMINAL_ACCOUNT_WEBHOOK_SECRET, DEV_TEST_USER_PASSWORD.
 *
 * Порядок: генерация → бэкап `.env` → запись `.env` → ALTER ROLE (контейнер
 * ещё держит старый пароль в своём env) → пересоздание контейнеров →
 * пересборка пака редакции. Ошибка после записи `.env` откатывает бэкап.
 *
 * После прогона ОБЯЗАТЕЛЬНО: `node scripts/dev-seed-test-user.mjs` (обновить
 * пароль тестовой учётки) и перезапуск core, если он был запущен.
 *
 * Запуск: node scripts/rotate-stand-secrets.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const BACKUP_PATH = join(ROOT, '.env.rotate-backup'); // под .gitignore (.env.*)
const DRY_RUN = process.argv.includes('--dry-run');

/** URL-безопасный секрет без спецсимволов: попадает и в URL подключений. */
function generate(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

const text = readFileSync(ENV_PATH, 'utf8');
const lines = text.split(/\r?\n/);

const newValues = new Map([
  ['POSTGRES_PASSWORD', generate()],
  ['REDIS_PASSWORD', generate()],
  ['NATS_PASSWORD', generate()],
  ['MINIO_ROOT_PASSWORD', generate()],
  ['KEYCLOAK_ADMIN_PASSWORD', generate()],
  ['S3_ACCESS_KEY_ID', 'unicorn_app'],
  ['S3_SECRET_ACCESS_KEY', generate()],
  ['OIDC_CLIENT_SECRET', generate()],
  ['PAYMENT_PROVIDER_WEBHOOK_SECRET', generate()],
  ['NOMINAL_ACCOUNT_WEBHOOK_SECRET', generate()],
  ['DEV_TEST_USER_PASSWORD', generate()],
]);

// Пароль владельца входит в URL — пересобираем их из новых значений.
const newOwnerPassword = newValues.get('POSTGRES_PASSWORD');
function rewriteOwnerUrl(value) {
  const u = new URL(value);
  u.password = newOwnerPassword;
  return u.toString();
}

let replaced = 0;
const updated = lines.map((line) => {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) return line;
  const [, name, value] = m;
  if (newValues.has(name)) {
    replaced += 1;
    return `${name}=${newValues.get(name)}`;
  }
  if ((name === 'DATABASE_URL_OWNER' || name === 'DATABASE_URL_TEST') && value) {
    replaced += 1;
    return `${name}=${rewriteOwnerUrl(value)}`;
  }
  return line;
});

console.warn(`rotate-stand-secrets: к замене ${replaced} строк(и) .env`);
if (DRY_RUN) {
  console.warn('dry-run: файлы не тронуты, контейнеры не пересоздавались');
  process.exit(0);
}

// 1. Бэкап и атомарная запись .env.
copyFileSync(ENV_PATH, BACKUP_PATH);
const TMP_PATH = `${ENV_PATH}.tmp`;
writeFileSync(TMP_PATH, updated.join('\n'), 'utf8');
renameSync(TMP_PATH, ENV_PATH);
console.warn(`rotate-stand-secrets: .env записан, бэкап в ${BACKUP_PATH}`);

function rollback(reason) {
  copyFileSync(BACKUP_PATH, ENV_PATH);
  console.error(`rotate-stand-secrets: ОТКАТ .env из бэкапа — ${reason}`);
  process.exit(1);
}

// 2. ALTER ROLE владельца в работающем postgres. Контейнер держит СТАРЫЙ
//    пароль в своём env — аутентифицируемся им, новый передаём через stdin.
const alterSql = `ALTER ROLE unicorn_owner WITH PASSWORD '${newOwnerPassword.replaceAll("'", "''")}';\n`;
const alter = spawnSync(
  'docker',
  [
    'exec',
    '-i',
    'unicorn-postgres',
    'sh',
    '-c',
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U unicorn_owner -d unicorn_launch -f -',
  ],
  { input: alterSql, encoding: 'utf8' },
);
if (alter.status !== 0) {
  console.error(alter.stderr?.slice(0, 500) ?? '');
  rollback('ALTER ROLE не прошёл, база осталась на старом пароле');
}
console.warn('rotate-stand-secrets: пароль владельца БД сменён (ALTER ROLE)');

// 3. Пересоздание контейнеров с новым env. postgres пересоздаётся тоже —
//    его env должен соответствовать фактическому паролю (healthcheck, будущие
//    ALTER); volume уже инициализирован, initdb не повторяется.
const compose = spawnSync(
  'docker',
  [
    'compose',
    '--env-file',
    ENV_PATH,
    '-f',
    join(ROOT, 'infra', 'docker-compose.yml'),
    'up',
    '-d',
    '--force-recreate',
    'postgres',
    'redis',
    'nats',
    'minio',
    'minio-init',
  ],
  { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
);
if (compose.status !== 0) {
  console.error('rotate-stand-secrets: пересоздание контейнеров не прошло — .env уже новый,');
  console.error('база на новом пароле; разбирайся вручную, бэкап старых значений в', BACKUP_PATH);
  process.exit(1);
}

// 4. Пак редакции: новые значения обязаны попасть в редакторы Entire ДО того,
//    как окажутся в любом транскрипте.
const redactors = spawnSync('node', [join(ROOT, 'scripts', 'build-local-redactors.mjs')], {
  encoding: 'utf8',
  stdio: 'inherit',
});
if (redactors.status !== 0) {
  console.error('rotate-stand-secrets: пересборка пака редакции упала — прогони вручную:');
  console.error('  npm run secrets:redactors');
  process.exit(1);
}

// 5. Бэкап со СТАРЫМИ секретами удаляется сам: до Ф45 он оставался на диске
//    в открытом виде до ручной уборки (LOW внешнего аудита №2), а «удалить
//    после проверки» — это шаг, который забывают. Все проверки, ради которых
//    он нужен (откат при неудаче ротации), к этому моменту уже пройдены:
//    ниже по коду откатов нет. `--keep-backup` оставляет файл осознанно.
if (process.argv.includes('--keep-backup')) {
  console.warn(`rotate-stand-secrets: бэкап оставлен по --keep-backup: ${BACKUP_PATH}`);
  console.warn('  Удали его вручную: в нём ПРЕЖНИЕ значения всех секретов стенда.');
} else {
  rmSync(BACKUP_PATH, { force: true });
  console.warn('rotate-stand-secrets: бэкап со старыми секретами удалён');
}

console.warn('rotate-stand-secrets: ГОТОВО. Дальше обязательно:');
console.warn('  1. node scripts/dev-seed-test-user.mjs   (пароль тестовой учётки)');
console.warn('  2. перезапустить core, если он был запущен');
console.warn('  3. node scripts/check-secret-reuse.mjs   (убедиться, что дублей нет)');
