#!/usr/bin/env node
/**
 * Убрать залипший сокет секрет-движка Docker Desktop, иначе он не стартует.
 *
 * Симптом. Docker Desktop падает окном «An unexpected error occurred» с
 * текстом:
 *
 *     starting services: initializing Secrets Engine: listening on
 *     unix://…/docker-secrets-engine/engine.sock: rename …engine.sock
 *     …engine.sock.stale: The file cannot be accessed by the system.
 *
 * Причина. `engine.sock` — это AF_UNIX-сокет, на Windows он реализован точкой
 * повторного разбора (reparse point). Когда Docker завершается некорректно,
 * запись в каталоге остаётся, а объекта за ней уже нет: Windows отвечает «file
 * cannot be accessed by the system» на ЛЮБУЮ операцию. Проверено на этой
 * машине — не берут ни `Remove-Item`, ни `del`, ни `rm` из bash, ни
 * `fsutil reparsepoint delete`, ни robocopy-зеркалом, ни права администратора.
 * Такая запись живёт до перезагрузки системы.
 *
 * Обход. Переименовать САМ КАТАЛОГ — на это доступ к битой записи не нужен.
 * Docker создаёт новый и запускается. Старый остаётся мусором и исчезает после
 * ближайшей перезагрузки.
 *
 * Почему скриптом, а не руками: 11 и 12 сентября 2026 сокет залипал два дня
 * подряд, и каждый раз это стоило разбирательства с нуля.
 *
 * Запуск:
 *   node scripts/fix-docker-socket.mjs             проверить и починить
 *   node scripts/fix-docker-socket.mjs --check     только проверить (exit 1 — залип)
 *   node scripts/fix-docker-socket.mjs --clean     заодно снести старые .broken-*
 */
import { existsSync, renameSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CHECK_ONLY = process.argv.includes('--check');
const CLEAN_OLD = process.argv.includes('--clean');

// Только Windows: на Linux и macOS сокеты так не ломаются.
if (process.platform !== 'win32') {
  console.warn('не Windows — проверка сокета не нужна');
  process.exit(0);
}

const LOCAL = process.env.LOCALAPPDATA;
if (!LOCAL) {
  console.warn('LOCALAPPDATA не задан — пропускаю проверку');
  process.exit(0);
}

const DIR = join(LOCAL, 'docker-secrets-engine');
const SOCK = join(DIR, 'engine.sock');

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '').replace(/-/g, '');

if (!existsSync(DIR)) {
  console.warn('ok  каталог секрет-движка отсутствует — Docker создаст его сам');
  process.exit(0);
}

/**
 * Живой сокет от залипшего отличается одним: у залипшего недоступны даже
 * атрибуты. Пробное переименование туда-обратно — самый честный способ
 * спросить об этом систему, не полагаясь на догадки.
 */
function isStale() {
  if (!existsSync(SOCK)) return false;
  const probe = `${SOCK}.probe-${process.pid}`;
  try {
    renameSync(SOCK, probe);
    renameSync(probe, SOCK);
    return false;
  } catch {
    return true;
  }
}

if (!isStale()) {
  console.warn('ok  сокет Docker в порядке');
} else if (CHECK_ONLY) {
  console.error('ЗАЛИП  engine.sock недоступен — Docker Desktop не стартует');
  console.error('       почините: node scripts/fix-docker-socket.mjs');
  process.exit(1);
} else {
  const broken = `${DIR}.broken-${stamp()}`;
  try {
    renameSync(DIR, broken);
    console.warn('ПОЧИНЕНО  залипший сокет отодвинут, Docker создаст каталог заново');
    console.warn(`          мусор: ${broken} (исчезнет после перезагрузки)`);
  } catch (error) {
    console.error('НЕ ВЫШЛО  каталог не переименовывается:', error.message);
    console.error('          остаётся перезагрузка Windows — так запись уходит всегда');
    process.exit(1);
  }
}

// Старый мусор копится по каталогу на каждый случай. Удалять его можно только
// после перезагрузки — до неё битая запись внутри не даётся и удалению.
const old = readdirSync(LOCAL).filter((n) => n.startsWith('docker-secrets-engine.broken-'));
if (old.length === 0) {
  process.exit(0);
}

if (!CLEAN_OLD) {
  console.warn(`прим.  осталось мусорных каталогов: ${old.length} (убрать: --clean)`);
  process.exit(0);
}

let removed = 0;
for (const name of old) {
  const path = join(LOCAL, name);
  try {
    statSync(path);
    rmSync(path, { recursive: true, force: true });
    if (!existsSync(path)) removed += 1;
  } catch {
    // Ещё не пережил перезагрузку — битая запись внутри неудаляема. Это норма.
  }
}
console.warn(
  removed > 0
    ? `убрано мусорных каталогов: ${removed} из ${old.length}`
    : `мусорные каталоги (${old.length}) пока не удаляются — уйдут после перезагрузки`,
);
