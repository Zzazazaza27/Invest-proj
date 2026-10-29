#!/usr/bin/env node
/**
 * Проверка перед выкатом: все фронты собраны в production-режиме.
 *
 * Корневой `.env` держит `NODE_ENV=development` для ядра, и `vite build` без
 * обёртки `scripts/vite-build.mjs` собирал отладочный React со StrictMode —
 * каждый запрос уходил дважды, потолок частоты срабатывал вдвое раньше
 * (найдено 2026-09-18, этап 5.6.4д). Признак отладочной сборки в бандле —
 * вызовы `jsxDEV` и тексты `Warning:`; в production их нет.
 *
 * Выход 1, если у какого-то приложения нет сборки или она отладочная.
 * Список приложений — те, что раздаёт единая точка входа, плюс консоль.
 *
 *   node scripts/check-front-builds.mjs            # все
 *   node scripts/check-front-builds.mjs lab admin  # выбранные
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['web-public', 'admin', 'lab', 'investor', 'auth', 'console'];
const apps = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ALL;

let failed = 0;
for (const app of apps) {
  const assets = join(ROOT, 'apps', app, 'dist', 'assets');
  if (!existsSync(assets)) {
    console.error(`  FAIL  ${app}: сборки нет (${assets})`);
    failed += 1;
    continue;
  }
  const bundles = readdirSync(assets).filter((f) => f.endsWith('.js'));
  if (bundles.length === 0) {
    console.error(`  FAIL  ${app}: в сборке нет js-бандлов`);
    failed += 1;
    continue;
  }
  const dev = bundles.filter((f) => {
    const text = readFileSync(join(assets, f), 'utf8');
    return text.includes('jsxDEV') || /\bWarning: /.test(text);
  });
  if (dev.length > 0) {
    console.error(
      `  FAIL  ${app}: отладочная сборка (${dev.join(', ')}) — пересоберите через scripts/vite-build.mjs`,
    );
    failed += 1;
  } else {
    console.warn(`  OK    ${app}: production-сборка (${bundles.length} бандл.)`);
  }
}
console.warn(
  failed === 0
    ? '\nВсе фронты собраны в production-режиме.'
    : `\nОтладочных или отсутствующих сборок: ${failed}.`,
);
process.exit(failed === 0 ? 0 : 1);
