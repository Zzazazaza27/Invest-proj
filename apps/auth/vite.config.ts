import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Вход и регистрация. Единственная связь с бэкендом — VITE_API_BASE_URL
// (ADR-002): прямого доступа к БД, очередям и хранилищу здесь нет.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Порт берётся из корневого `.env` (см. `scripts/lib/ports.mjs`); дефолт —
 * поведение свежего клона. Под единой точкой входа приложение раздаётся по
 * пути `/login/`, поэтому `base` задан явно: без него ссылки на ассеты вели бы
 * в корень, и страница открывалась бы пустой.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, '');
  /*
   * Карта dev-портов нужна ТОЛЬКО прямому запуску dev-сервером.
   *
   * Относительный адрес API означает, что страница и API живут на одном
   * origin, — это единая точка входа, и переходы между кабинетами идут по
   * пути. Пустая карта ровно это и означает: в hrefFor для неизвестного
   * порта уже есть ветка «вернуть путь».
   *
   * Прежде признаком служил пустой порт страницы. На временном контуре
   * (вход на 8081) он давал неверный ответ: кабинет уводил на dev-адрес
   * localhost:5179, которого там нет.
   */
  // process.env читается ПЕРВЫМ: loadEnv берёт только файлы, а сборка
  // задаёт относительный адрес именно переменной окружения
  // (scripts/vite-build.mjs).
  const singleEntry = (process.env.VITE_API_BASE_URL ?? env.VITE_API_BASE_URL ?? '').startsWith(
    '/',
  );
  const raw = env.AUTH_PORT;
  const port = raw === undefined || raw === '' ? 5179 : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`AUTH_PORT=${raw} — не порт (нужно целое 1..65535)`);
  }

  /**
   * Порты кабинетов попадают в сборку значением.
   *
   * За единой точкой входа переход делается по пути (`/lab`), и порты не нужны
   * вовсе. Но приложение поднимают и напрямую — своим dev-сервером; тогда
   * относительный `/lab` вёл бы в никуда, и вход выглядел бы сломанным. Здесь
   * оба случая различает сам код по наличию порта в адресе страницы.
   */
  // Пустая карта при едином входе: переход идёт по пути, и dev-порты в
  // сборку не попадают вовсе (см. singleEntry выше).
  const cabinetPorts = singleEntry
    ? {}
    : {
        lab: Number(env.LAB_PORT || 5175),
        investor: Number(env.INVESTOR_PORT || 5176),
        expert: Number(env.EXPERT_PORT || 5177),
        admin: Number(env.ADMIN_PORT || 5174),
      };

  return {
    base: '/login/',
    // Значок вкладки лежит один на все приложения: иначе семь копий одного
    // favicon расходятся по одной за раз. Каталог общий — `packages/ui/public`.
    publicDir: resolve(ROOT, 'packages', 'ui', 'public'),
    define: { __CABINET_PORTS__: JSON.stringify(cabinetPorts) },
    plugins: [react()],
    optimizeDeps: { include: ['@unicorn/api-client', '@unicorn/contracts'] },
    server: { port, strictPort: true, host: '127.0.0.1' },
    preview: { port, strictPort: true, host: '127.0.0.1' },
    // Карты исходников не публикуются (SEC-13).
    build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
  };
});
