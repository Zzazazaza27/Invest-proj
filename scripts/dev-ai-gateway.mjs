#!/usr/bin/env node
/**
 * Запуск AI-шлюза с переменными из .env.
 *
 * Как и `dev-core.mjs`: переменные читает скрипт, а не приложение. Сам шлюз в
 * production получает окружение от платформы и `.env` читать не умеет — это
 * принципиально, потому что именно у него будут ключи внешних моделей.
 *
 *   node scripts/dev-ai-gateway.mjs            — на переднем плане
 *   node scripts/dev-ai-gateway.mjs --detached — в фоне, лог в ai-gateway.log
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTS } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = join(ROOT, 'apps', 'ai-gateway', '.venv', 'Scripts', 'python.exe');
const PYTHON_POSIX = join(ROOT, 'apps', 'ai-gateway', '.venv', 'bin', 'python');

const interpreter = existsSync(PYTHON) ? PYTHON : PYTHON_POSIX;
if (!existsSync(interpreter)) {
  console.error(
    'Виртуальное окружение шлюза не создано. Выполни:\n' +
      '  python -m venv apps/ai-gateway/.venv\n' +
      '  apps/ai-gateway/.venv/Scripts/python -m pip install -r apps/ai-gateway/requirements.txt',
  );
  process.exit(1);
}

const env = { ...process.env, PYTHONUTF8: '1' };
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

// Пути в .env заданы от корня репозитория, а uvicorn запускается из папки
// шлюза. Приводим к абсолютному здесь: иначе шлюз ищет политику относительно
// своего каталога и падает при старте — правильным падением по неправильной
// причине.
if (env.AI_POLICY_PATH && !isAbsolute(env.AI_POLICY_PATH)) {
  env.AI_POLICY_PATH = join(ROOT, env.AI_POLICY_PATH.replace(/^\.[\\/]/, ''));
}

const detached = process.argv.includes('--detached');
// Порт берётся из AI_GATEWAY_URL: два источника правды разошлись бы на первом же
// изменении, и core стучался бы не туда.
const url = new URL(env.AI_GATEWAY_URL ?? `http://127.0.0.1:${PORTS.aiGateway}`);
const args = [
  '-m',
  'uvicorn',
  'app.main:get_app',
  '--factory',
  // Только loopback: шлюз не выставляется в сеть даже локально (RULES.md §3.2).
  '--host',
  '127.0.0.1',
  '--port',
  url.port || '8100',
  // Заголовок `server: uvicorn` называет стек и его версию любому, кто
  // отправит один запрос (RULES.md §3.2, «утечки в сетевом слое»).
  '--no-server-header',
  // Предел одновременных соединений: без него всплеск запросов ставит в
  // очередь неограниченное число задач, и отказ становится каскадным —
  // включая /healthz, по которому оркестратор решает, жив ли сервис
  // (MEDIUM внешнего аудита №2). Разбор вынесен в threadpool, но очередь
  // всё равно нужно ограничивать: сверх предела uvicorn отвечает 503.
  '--limit-concurrency',
  process.env.AI_GATEWAY_LIMIT_CONCURRENCY ?? '64',
];

const options = { cwd: join(ROOT, 'apps', 'ai-gateway'), env };
if (detached) {
  const log = openSync(join(ROOT, 'ai-gateway.log'), 'a');
  const child = spawn(interpreter, args, {
    ...options,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  console.warn(`ai-gateway запущен в фоне, pid ${child.pid}, лог: ai-gateway.log`);
} else {
  const child = spawn(interpreter, args, { ...options, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}
