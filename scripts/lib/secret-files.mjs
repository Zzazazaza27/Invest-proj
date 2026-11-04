import { readFileSync } from 'node:fs';

const SUFFIX = '_FILE';

/**
 * Секреты из файлов для миграций и инициализации NATS: правила те же, что у ядра
 * (`apps/core/src/config/secret-files.ts`). Заданы и значение, и файл — отказ;
 * нечитаемый файл — отказ, значением из окружения он не обходится. Части установки
 * не должны брать один секрет из разных источников. Сверка загрузчиков —
 * `apps/core/tests/secret-files.test.ts`.
 */
export function applySecretFiles(env = process.env) {
  for (const [key, path] of Object.entries(env)) {
    if (!key.endsWith(SUFFIX) || !path) continue;
    const name = key.slice(0, -SUFFIX.length);
    if (env[name]) throw new Error(`Заданы и ${name}, и ${key}: оставь одно`);
    try {
      env[name] = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
    } catch {
      throw new Error(`${key}: файл ${path} не читается`);
    }
    delete env[key];
  }
}
