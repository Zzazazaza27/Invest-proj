#!/usr/bin/env node
/**
 * Гейт AI-шлюза: тесты политики и анализатора + аудит зависимостей.
 *
 * Вынесен в скрипт, а не в строку package.json, по одной причине: путь к
 * интерпретатору различается на Windows и Linux, а гейт обязан выполняться
 * одинаково локально и в CI. Захардкоженный путь означал бы, что в одной из
 * сред гейт молча не запускается — то есть зелёный без проверки.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY = join(ROOT, 'apps', 'ai-gateway');

const candidates = [
  join(GATEWAY, '.venv', 'Scripts', 'python.exe'),
  join(GATEWAY, '.venv', 'bin', 'python'),
];
const python = candidates.find((p) => existsSync(p));

if (!python) {
  console.error(
    'Окружение шлюза не создано — гейт не может считаться пройденным.\n' +
      '  python -m venv apps/ai-gateway/.venv\n' +
      '  apps/ai-gateway/.venv/Scripts/python -m pip install -r apps/ai-gateway/requirements-dev.txt',
  );
  process.exit(1);
}

// PYTHONUTF8: без него интерпретатор на Windows читает исходники в кодировке
// системы и падает на кириллице в тестах и сообщениях (та же грабля, что с
// semgrep).
const env = { ...process.env, PYTHONUTF8: '1' };

const steps = [
  { name: 'тесты шлюза', args: ['-m', 'pytest', 'tests', '-q'] },
  {
    name: 'аудит зависимостей (pip-audit)',
    args: ['-m', 'pip_audit', '-r', 'requirements.txt', '--progress-spinner', 'off'],
  },
];

let failures = 0;
for (const step of steps) {
  console.warn(`\n=== ${step.name} ===`);
  const result = spawnSync(python, step.args, { cwd: GATEWAY, env, stdio: 'inherit' });
  if (result.status !== 0) failures += 1;
}

console.warn(
  failures === 0
    ? '\nГейт AI-шлюза пройден.\n'
    : `\nГейт AI-шлюза НЕ пройден: провалено шагов ${failures}.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
