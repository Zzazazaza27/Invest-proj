/**
 * Активный слот ядра рабочей среды (блок 09, задание 3) — то же, что infra/host/core-slot.sh.
 *
 * Файл маршрута в машиночитаемом виде пишет установщик: `<корень>/.local/release/core-route.json`
 * `{ "format": 1, "slot": "core-a" | "core-b", ... }`. Нет файла — режима слотов ещё нет: одно
 * ядро `fifth-core`, служебный порт 4400. Файл есть, но не разбирается — ошибка: гадать нельзя.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SLOTS = {
  'core-a': { container: 'fifth-core', port: 4300, internalPort: 4401 },
  'core-b': { container: 'fifth-core-b', port: 4310, internalPort: 4411 },
};
export const LEGACY = { slot: null, container: 'fifth-core', port: 4300, internalPort: 4400 };

export const routeJsonPath = (root) => join(root, '.local', 'release', 'core-route.json');

/** Активное ядро: слот, контейнер и порты. */
export function activeCore(root) {
  const file = routeJsonPath(root);
  if (!existsSync(file)) return LEGACY;
  let route;
  try {
    route = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`файл маршрута ${file} не разобран — активное ядро неизвестно`);
  }
  const slot = SLOTS[route?.slot];
  if (route?.format !== 1 || !slot) {
    throw new Error(`файл маршрута ${file} не разобран — активное ядро неизвестно`);
  }
  return { slot: route.slot, ...slot };
}
