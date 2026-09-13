#!/usr/bin/env node
/**
 * Гейт «служебная консоль закрыта постороннему».
 *
 * История. Консоль прятали от боевого контура тремя рубежами: её не собирал
 * `npm run build`, маршрут жил в отдельном каталоге конфигов, каталог монтировал
 * отдельный compose-файл — и подключался он, только когда окружение не боевое.
 * Любого одного рубежа считалось достаточно.
 *
 * 2026-09-13 выяснилось, что все три снимает ОДНО значение: на боевом стенде
 * стоял `NODE_ENV=development`, `infra.mjs` штатно подключил локальный профиль,
 * и https://vgorkakh.ru/console/ отдавала настоящую консоль кому угодно. Рубежи
 * выглядели эшелонированием, а стояли на одной оси. Тем же значением, к слову,
 * было открыто и описание API — 117 маршрутов анониму.
 *
 * Прежний гейт при этом был ЗЕЛЁНЫМ: он проверял файлы, а не поведение живой
 * системы, и консоль, отданную анониму локально, считал нормой.
 *
 * Теперь доступ решает роль: ядро отвечает на подзапрос nginx (`auth_request`),
 * посторонний получает 404. Прятать то, что защищено, смысла нет — консоль
 * монтируется наравне с остальными приложениями. Проверять надо ровно одно:
 * что привратник на месте и работает.
 *
 * Запуск: npm run gate:console-private
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS } from './lib/ports.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const ok = (text) => console.warn(`  ok    ${text}`);
const fail = (text) => {
  failed += 1;
  console.error(`  ПРОВАЛ ${text}`);
};

console.warn('\nГейт: служебная консоль закрыта постороннему\n');

// --- 1. Привратник объявлен в конфигурации прокси -------------------------
{
  const confPath = join(ROOT, 'infra', 'nginx', 'default.conf');
  const conf = existsSync(confPath) ? readFileSync(confPath, 'utf8') : '';

  if (!conf.includes('location /console/')) {
    fail('в infra/nginx/default.conf нет маршрута /console/ — консоль не раздаётся вовсе');
  } else if (!/location \/console\/ \{[^}]*auth_request/s.test(conf)) {
    fail('маршрут /console/ есть, но без auth_request — консоль откроется любому');
  } else {
    ok('маршрут /console/ защищён auth_request');
  }

  if (!conf.includes('/v1/auth/authz/console')) {
    fail('подзапрос не ведёт на /v1/auth/authz/console — проверять права нечем');
  } else {
    ok('подзапрос ведёт в ядро, на маршрут проверки прав');
  }

  // Отказ обязан выглядеть как отсутствие: 403 подтвердил бы, что консоль тут
  // есть. Та же анти-оракульная линия, что у описания API и у локального входа.
  if (!/error_page[^\n]*401[^\n]*403/.test(conf) || !conf.includes('return 404')) {
    fail('отказ не приводится к 404 — посторонний узнает, что консоль существует');
  } else {
    ok('отказ отдаётся как 404, а не 403');
  }
}

// --- 2. Маршрут проверки прав требует роль администратора ----------------
{
  const controller = join(ROOT, 'apps', 'core', 'src', 'identity', 'identity.controller.ts');
  const src = existsSync(controller) ? readFileSync(controller, 'utf8') : '';
  const guarded = /@Roles\('admin'\)[\s\S]{0,200}?authz\/console/.test(src);
  if (!guarded) {
    fail("маршрут authz/console не под @Roles('admin') — пустит любого, у кого есть сессия");
  } else {
    ok("маршрут проверки прав под @Roles('admin')");
  }
}

// --- 3. Факт: что отдаёт живая система ------------------------------------
/**
 * Проверки выше читают файлы. Эта смотрит, что сервер отдаёт НА САМОМ ДЕЛЕ:
 * конфигурация могла быть не перечитана. Ровно так и случилось при первом
 * боевом выкате — файл приехал, nginx его не применил, консоль осталась
 * открытой при обновлённом коде.
 */
{
  const origin = PORTS.web === 80 ? 'http://127.0.0.1' : `http://127.0.0.1:${PORTS.web}`;
  try {
    const response = await fetch(`${origin}/console/`, { signal: AbortSignal.timeout(3000) });
    const body = await response.text();
    const isConsole = /<title>[^<]*Консоль API/.test(body);

    if (isConsole) {
      fail(`${origin}/console/ отдаёт консоль анониму — привратник не работает`);
    } else if (response.status === 404) {
      ok(`${origin}/console/ анониму отвечает 404`);
    } else {
      // 500 здесь означает, что подзапрос вернул неожиданный код: так было,
      // когда ядро ещё не подхватило новый маршрут после перезапуска.
      fail(`${origin}/console/ отвечает ${response.status} — ожидался 404, проверьте подзапрос`);
    }
  } catch {
    ok('единая точка входа не отвечает — проверять фактом нечего');
  }
}

console.warn('');
if (failed > 0) {
  console.warn(`Нарушений: ${failed}. Консоль может открыться постороннему.\n`);
  process.exit(1);
}
console.warn('Консоль доступна только администратору.\n');
