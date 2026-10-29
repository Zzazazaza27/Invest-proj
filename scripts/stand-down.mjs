#!/usr/bin/env node
/**
 * Остановить локальный стенд.
 *
 * Обратная сторона `stand:up`: то, что он поднял, должно выключаться одной
 * командой и предсказуемо. Без этого «остановить» превращается в поиск PID по
 * диспетчеру задач, а забытый процесс ядра на :4300 потом мешает следующему
 * запуску и выглядит как «порт занят непонятно чем».
 *
 * **Данные не трогаются.** Контейнеры останавливаются (`stop`), а не
 * удаляются, и тома с базой, хранилищем и очередью остаются на месте.
 * Удаление данных — это `npm run infra:reset`, отдельная команда с другим
 * именем, и здесь её нет намеренно.
 *
 * Запуск:
 *   npm run stand:down            остановить всё
 *   npm run stand:down -- --apps  только процессы на хосте (ядро и шлюз)
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { PORTS } from './lib/ports.mjs';
import { commandLine, portOwner, stopTree } from './lib/stand-processes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APPS_ONLY = process.argv.includes('--apps');

const ok = (text) => console.warn(`  ok    ${text}`);
const warn = (text) => console.warn(`  прим. ${text}`);
const step = (text) => console.warn(`\n▸ ${text}`);

/**
 * Процессы хоста: ядро, шлюз анализа и dev-серверы Vite.
 *
 * Dev-серверы здесь потому, что при работающей единой точке входа они —
 * ДУБЛИ: те же приложения, только из исходников и на своих портах. Оставлять
 * их работающими значит держать два стенда и потом гадать, какой из них
 * проверяешь.
 */
const HOST_SERVICES = [
  { port: PORTS.core, name: 'ядро', expect: 'main.js' },
  { port: PORTS.webPublic, name: 'dev-сервер витрины', expect: 'vite' },
  { port: PORTS.admin, name: 'dev-сервер админки', expect: 'vite' },
  { port: PORTS.lab, name: 'dev-сервер кабинета основателя', expect: 'vite' },
  { port: PORTS.investor, name: 'dev-сервер кабинета инвестора', expect: 'vite' },
  { port: PORTS.console, name: 'dev-сервер консоли', expect: 'vite' },
  { port: PORTS.auth, name: 'dev-сервер входа', expect: 'vite' },
];

step('Процессы на хосте');
let stopped = 0;
for (const service of HOST_SERVICES) {
  const pid = portOwner(service.port);
  if (!pid) continue;
  const cmd = commandLine(pid);
  // Чужое не трогаем: на машине могут работать другие сервисы, и «освободить
  // порт любой ценой» — способ однажды выключить не своё.
  if (service.expect && !cmd.toLowerCase().includes(service.expect)) {
    warn(`:${service.port} занят не нашим процессом (pid ${pid}) — оставлен`);
    continue;
  }
  stopTree(pid);
  ok(`${service.name} остановлен (:${service.port}, pid ${pid})`);
  stopped += 1;
}
if (stopped === 0) ok('нечего останавливать — все порты уже свободны');

if (!APPS_ONLY) {
  step('Контейнеры');
  try {
    execFileSync(process.execPath, [resolve(ROOT, 'scripts/infra.mjs'), 'stop'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ok('остановлены; тома с данными на месте');
  } catch {
    warn('остановить контейнеры не удалось — возможно, демон Docker уже выключен');
  }
}

console.warn(`
Стенд остановлен. Данные сохранены в томах Docker.

  Поднять снова:      npm run stand:up
  Посмотреть, что где: npm run stand:status
  Удалить данные:      npm run infra:reset   (отдельная команда, здесь не выполняется)
`);
