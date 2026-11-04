/**
 * Конфигурация подключения к БД для миграций и тестов.
 *
 * Секретов в коде нет: всё приходит из переменных окружения. Отсутствие
 * обязательной переменной — падение на старте (fail-closed), а не молчаливый
 * дефолт на localhost с пустым паролем.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySecretFiles } from '../../scripts/lib/secret-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

/**
 * Минимальный загрузчик .env: подтягивает переменные, если они не заданы в
 * окружении. Внешняя зависимость ради этого не нужна.
 */
function loadDotEnv(): void {
  const envPath = join(REPO_ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

applySecretFiles();

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '' || value.includes('CHANGE_ME')) {
    throw new Error(
      `Переменная окружения ${name} не задана или содержит плейсхолдер. ` +
        'Заполни .env по образцу .env.example — молчаливого дефолта здесь нет.',
    );
  }
  return value;
}

/** Строка подключения владельца схем: используется миграциями и тестами. */
export function ownerConnectionString(): string {
  return process.env.NODE_ENV === 'test'
    ? requireEnv('DATABASE_URL_TEST')
    : requireEnv('DATABASE_URL_OWNER');
}

export function testConnectionString(): string {
  return requireEnv('DATABASE_URL_TEST');
}

/** TLS для подключения к БД. В production выключать проверку нельзя. */
export function sslConfig(): { rejectUnauthorized: boolean } | false {
  const enabled = (process.env.DATABASE_SSL ?? 'false').toLowerCase() === 'true';
  if (!enabled) return false;
  return { rejectUnauthorized: true };
}
