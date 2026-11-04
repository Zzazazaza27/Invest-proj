import type { Notebook } from './types';

const STORAGE_KEY = 'fifth-console-notebook';

/**
 * Блокнот идентификаторов сквозного прогона.
 *
 * Хранится в `sessionStorage`, а не в памяти: перезагрузка страницы посреди
 * сценария (а она случается — правка кода, перезапуск Vite) иначе стирала бы
 * все полученные идентификаторы, и сценарий пришлось бы начинать заново.
 *
 * Именно `sessionStorage`, а не `localStorage`: содержимое относится к одному
 * прогону в одной вкладке. Оставлять его между сеансами вредно — следующий
 * прогон подставил бы идентификаторы прошлого, и ошибка выглядела бы как
 * «сервер не находит только что созданный объект».
 *
 * Здесь нет и не должно быть ничего, кроме идентификаторов: токены и пароли в
 * хранилище браузера не кладутся — сессия живёт в httpOnly-cookie.
 */
export function createNotebook(): Notebook {
  function read(): Record<string, string> {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') result[key] = value;
      }
      return result;
    } catch {
      // Испорченное содержимое — не повод падать: блокнот вспомогательный.
      return {};
    }
  }

  function write(data: Record<string, string>): void {
    try {
      // Правило SAST запрещает класть в web storage сессионные данные — и это
      // верное правило: сессия консоли живёт в httpOnly-cookie и сюда не
      // попадает. Здесь хранятся ТОЛЬКО идентификаторы созданных объектов
      // (`projectId`, `materialId`), чтобы прогон переживал перезагрузку
      // страницы. Токенов, паролей и подписей в блокноте нет и быть не может:
      // значения кладёт `remembers` каждой операции, а он берёт их из ответов
      // API по именам полей.
      // nosemgrep: unicorn-no-token-in-web-storage
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Приватный режим или переполнение — прогон должен продолжаться.
    }
  }

  return {
    get(key) {
      return read()[key];
    },
    set(key, value) {
      const data = read();
      data[key] = value;
      write(data);
    },
    entries() {
      return Object.entries(read()).sort(([a], [b]) => a.localeCompare(b));
    },
    clear() {
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* см. выше */
      }
    },
  };
}

/**
 * Достаёт значение по пути вида `id`, `items.0.id`, `offer.id`.
 *
 * Возвращает строку или `undefined`: в блокнот кладутся только идентификаторы,
 * и молча записанный туда объект позже подставился бы в поле формы как
 * `[object Object]` — ошибка, которую пришлось бы искать глазами в запросе.
 */
export function pluck(source: unknown, path: string): string | undefined {
  let current: unknown = source;
  for (const step of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(step);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[step];
  }
  return typeof current === 'string' ? current : undefined;
}
