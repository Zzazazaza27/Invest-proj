#!/usr/bin/env node
/**
 * Гейт: служебная консоль API не публикуется боевым контуром.
 *
 * Код консоли лежит в репозитории и попадёт на сервер вместе с ним — это
 * неизбежно и само по себе безобидно. Опасна публикация: консоль не защищает
 * себя сама (права проверяет сервер), но даёт постороннему карту всего API
 * одним списком — выдачу служебных токенов, вебхуки, ротацию секретов.
 *
 * Поэтому публикация выключена ТРЕМЯ независимыми способами, и здесь
 * проверяется каждый: достаточно одного уцелевшего, чтобы консоль не открылась,
 * но молча потерять два из трёх — плохая позиция.
 *
 *   1. СБОРКА       — `npm run build` не собирает консоль;
 *   2. МАРШРУТ      — `location /console/` только в `infra/nginx/local/`;
 *   3. МОНТИРОВАНИЕ — каталог подключает лишь `infra/docker-compose.local.yml`.
 *
 * Дополнительно, если единая точка входа поднята, проверяется ФАКТОМ: что
 * отдаёт `/console/` на самом деле.
 *
 * Запуск: node scripts/check-console-private.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTS } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;

function fail(message) {
  failed += 1;
  console.warn(`  FAIL  ${message}`);
}

function ok(message) {
  console.warn(`  OK    ${message}`);
}

function read(relative) {
  const path = join(ROOT, relative);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

console.warn('\n=== СЛУЖЕБНАЯ КОНСОЛЬ НЕ ПУБЛИКУЕТСЯ БОЕВЫМ КОНТУРОМ ===\n');

// --- 1. Сборка ------------------------------------------------------------
{
  const pkg = read('package.json');
  if (!pkg) {
    fail('package.json не найден');
  } else {
    const scripts = JSON.parse(pkg).scripts ?? {};
    const build = scripts.build ?? '';
    if (build.includes('apps/console')) {
      fail('`npm run build` собирает консоль — её dist появится на сервере');
    } else {
      ok('`npm run build` не собирает консоль (для неё есть build:console)');
    }
  }
}

// --- 2. Маршрут -----------------------------------------------------------
{
  const base = read('infra/nginx/default.conf');
  if (!base) {
    fail('infra/nginx/default.conf не найден');
  } else if (/location\s+[^\n]*\/console/.test(base)) {
    fail('маршрут /console/ объявлен в основном конфиге nginx');
  } else if (!base.includes('include /etc/nginx/local/')) {
    fail(
      'в основном конфиге нет подключения локальных дополнений — маршрут не появится и локально',
    );
  } else {
    ok('маршрут /console/ отсутствует в основном конфиге nginx');
  }

  const localConf = read('infra/nginx/local/console.conf');
  if (!localConf || !/location\s+\/console\//.test(localConf)) {
    fail('локальный маршрут /console/ отсутствует — консоль не откроется и в разработке');
  } else {
    ok('маршрут /console/ живёт в infra/nginx/local/');
  }
}

// --- 3. Монтирование ------------------------------------------------------
{
  const base = read('infra/docker-compose.yml');
  const local = read('infra/docker-compose.local.yml');
  if (!base) {
    fail('infra/docker-compose.yml не найден');
  } else if (base.includes('apps/console') || base.includes('/etc/nginx/local')) {
    fail('базовый compose монтирует консоль или каталог локальных дополнений');
  } else {
    ok('базовый compose не монтирует ни консоль, ни локальные дополнения');
  }

  if (!local || !local.includes('apps/console/dist')) {
    fail('infra/docker-compose.local.yml не монтирует консоль — локально она не откроется');
  } else {
    ok('консоль монтируется только локальным compose-файлом');
  }
}

// --- 4. Факт --------------------------------------------------------------
/**
 * Три проверки выше читают файлы. Эта смотрит, что сервер отдаёт НА САМОМ ДЕЛЕ:
 * конфигурация могла быть переопределена запуском, о котором файлы не знают.
 */
{
  const origin = PORTS.web === 80 ? 'http://127.0.0.1' : `http://127.0.0.1:${PORTS.web}`;
  try {
    const response = await fetch(`${origin}/console/`, { signal: AbortSignal.timeout(3000) });
    const body = await response.text();
    // Заголовок страницы отличает консоль от витрины: обе отвечают 200, потому
    // что неизвестный путь отдаёт index.html витрины.
    const isConsole = /<title>[^<]*Консоль API/.test(body);
    const expectedLocally = existsSync(join(ROOT, 'infra', 'docker-compose.local.yml'));

    // Состояний три, а не два. Раньше их различали только по содержимому
    // ответа, и «закрыто привратником» неотличимо сливалось с «профиль не
    // поднят» — гейт рапортовал неправду о живой системе.
    if (response.status === 404) {
      ok(`${origin}/console/ закрыта: анониму 404 (пускает только админа)`);
    } else if (isConsole && expectedLocally) {
      // Консоль отдана БЕЗ сессии — значит привратник не сработал. Раньше это
      // считалось нормой «раз локально»; 2026-09-13 ровно так она и оказалась
      // открыта в интернет на боевом стенде.
      fail(
        `${origin}/console/ отдаёт консоль анониму — привратник auth_request не работает ` +
          '(проверьте infra/nginx/local/console.conf и маршрут /v1/auth/authz/console)',
      );
    } else if (isConsole) {
      fail(`${origin}/console/ отдаёт консоль, хотя локального профиля быть не должно`);
    } else {
      ok(`${origin}/console/ отдаёт не консоль`);
    }
  } catch {
    ok('единая точка входа не отвечает — проверять фактом нечего');
  }
}

console.warn('');
if (failed > 0) {
  console.warn(`Нарушений: ${failed}. Консоль рискует уехать в боевой контур.\n`);
  process.exit(1);
}
console.warn('Консоль публикуется только локально.\n');
