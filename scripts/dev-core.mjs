#!/usr/bin/env node
/**
 * Запуск собранного core с переменными из .env.
 *
 * Отдельный скрипт вместо dotenv в самом приложении: production получает
 * переменные из окружения (Vault/External Secrets), и код приложения не должен
 * уметь читать .env вовсе.
 *
 * Использование:
 *   node scripts/dev-core.mjs            — на переднем плане
 *   node scripts/dev-core.mjs --detached — в фоне, лог в core.log
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'apps', 'core', 'dist', 'main.js');

if (!existsSync(ENTRY)) {
  console.error('Сначала собери core: npm run build -w apps/core');
  process.exit(1);
}

const env = { ...process.env };
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
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
    env[key] ??= value;
  }
}

/**
 * Порт занят — значит запущена ПРЕЖНЯЯ сборка.
 *
 * Без этой проверки фоновый старт выглядит успешным (pid напечатан), новый
 * процесс тихо умирает на EADDRINUSE, а прогоны идут против старого кода и
 * показывают то, чего в текущей сборке нет. Проверено на живом прогоне Ф9:
 * 25 «падений» подряд объяснялись именно этим. Молчаливый успех здесь опаснее
 * явного отказа.
 */
async function assertPortFree(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok || response.status > 0) {
      console.error(
        `Порт ${port} уже занят запущенным core. Останови прежний процесс, ` +
          'иначе прогон пойдёт против СТАРОЙ сборки.',
      );
      process.exit(1);
    }
  } catch {
    // Соединения нет — порт свободен, это ожидаемый путь.
  }
}

const CORE_PORT = Number(env.PORT ?? 4300);
await assertPortFree(CORE_PORT);

const detached = process.argv.includes('--detached');
if (detached) {
  const out = openSync(join(ROOT, 'core.log'), 'w');
  const child = spawn(process.execPath, [ENTRY], {
    env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  console.warn(`core запущен в фоне, pid ${child.pid}, лог: core.log`);
} else {
  const child = spawn(process.execPath, [ENTRY], { env, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}
