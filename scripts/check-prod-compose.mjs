#!/usr/bin/env node
/**
 * Файлы запуска рабочей среды берутся из комплекта (W09e). Узкая проверка без контейнеров:
 * два комплекта с разными файлами, активный набор виден в `docker compose config`, порча
 * файла останавливает установку, рабочая копия не участвует.
 *
 *   node scripts/check-prod-compose.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activateProdFiles, prodFileName } from './lib/prod-compose.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'infra/docker-compose.yml',
  'infra/docker-compose.prod.yml',
  'infra/docker-compose.journald.yml',
];
const dir = mkdtempSync(join(tmpdir(), 'prod-compose-'));
const active = join(dir, 'active');
let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Комплект с меткой в файле рабочей среды. */
function makeKit(build, mark) {
  const kitDir = join(dir, build);
  mkdirSync(join(kitDir, 'prod-compose'), { recursive: true });
  const prodCompose = {};
  for (const file of FILES) {
    let text = readFileSync(join(ROOT, file), 'utf8');
    if (file.endsWith('.prod.yml')) {
      text = text.replace('    init: true\n', `    init: true\n    hostname: ${mark}\n`);
    }
    writeFileSync(join(kitDir, 'prod-compose', prodFileName(file)), text);
    prodCompose[file] = sha(Buffer.from(text));
  }
  return { kitDir, kit: { build, prodCompose } };
}

function activeHostname() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'infra.mjs'), 'compose', 'config', '--format', 'json'],
    {
      encoding: 'utf8',
      maxBuffer: 1 << 24,
      env: {
        ...process.env,
        MSYS_NO_PATHCONV: '1',
        FIFTH_PROD_COMPOSE_DIR: active,
        FIFTH_CORE_IMAGE: 'a',
        FIFTH_WEB_IMAGE: 'b',
        FIFTH_POSTGRES_IMAGE: 'c',
      },
    },
  );
  try {
    return JSON.parse(r.stdout).services.core.hostname;
  } catch {
    return `ошибка: ${(r.stderr || r.stdout).trim().split('\n').pop()}`;
  }
}

console.log('=== ФАЙЛЫ ЗАПУСКА ИЗ КОМПЛЕКТА ===');
try {
  const a = makeKit('2.1-b1.1', 'kit-a');
  const b = makeKit('2.1-b2.1', 'kit-b');
  check(
    'файлы комплектов различаются',
    a.kit.prodCompose[FILES[1]] !== b.kit.prodCompose[FILES[1]],
  );
  activateProdFiles(a.kitDir, a.kit, active);
  check('действуют файлы комплекта A', activeHostname() === 'kit-a', activeHostname());
  activateProdFiles(b.kitDir, b.kit, active);
  check('выпуск B сменил файлы', activeHostname() === 'kit-b', activeHostname());
  activateProdFiles(a.kitDir, a.kit, active);
  check('возврат на A вернул его файлы', activeHostname() === 'kit-a', activeHostname());
  const broken = join(a.kitDir, 'prod-compose', 'docker-compose.prod.yml');
  writeFileSync(broken, `${readFileSync(broken, 'utf8')}# подмена\n`);
  let refused = '';
  try {
    activateProdFiles(a.kitDir, a.kit, active);
  } catch (e) {
    refused = e.message;
  }
  check('подмена файла останавливает установку', refused.includes('хеш не сошёлся'), refused);
  check('после отказа действующие файлы прежние', activeHostname() === 'kit-a');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\nИТОГО: ${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
