import { defineConfig, loadEnv } from 'vite';
import { appVersion } from '../../scripts/lib/app-version.mjs';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Служебная консоль разработки и тестирования. Как и кабинеты, знает о бэкенде
// ровно одно — VITE_API_BASE_URL (ADR-002): прямого доступа к БД, очередям и
// хранилищу у неё нет. В production не публикуется.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Порт берётся из корневого `.env` стенда (см. `scripts/lib/ports.mjs`).
 * Дефолт ниже — поведение свежего клона без `.env`.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, '');
  const raw = env.CONSOLE_PORT;
  const port = raw === undefined || raw === '' ? 5178 : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CONSOLE_PORT=${raw} — не порт (нужно целое 1..65535)`);
  }

  return {
    // Консоль раздаётся под своим подпутём — и локальным прокси, и своим
    // dev-сервером. Без `base` ссылки на ассеты в index.html вели бы в корень:
    // страница отвечала бы 200, оставаясь пустой, потому что вместо бандла
    // приходил бы HTML витрины. Проверено рендером.
    base: '/console/',
    // Значок вкладки лежит один на все приложения: иначе семь копий одного
    // favicon расходятся по одной за раз. Каталог общий — `packages/ui/public`.
    publicDir: resolve(ROOT, 'packages', 'ui', 'public'),
    define: { __APP_VERSION__: JSON.stringify(appVersion()) },
    plugins: [react()],
    // Пакеты монорепо собираются в CommonJS: их потребляет и ядро на NestJS,
    // которое ESM не принимает. Явное включение возвращает шаг преобразования.
    optimizeDeps: { include: ['@fifth/api-client', '@fifth/contracts'] },
    server: { port, strictPort: true, host: '127.0.0.1' },
    preview: { port, strictPort: true, host: '127.0.0.1' },
    // Карты исходников не публикуются — по той же причине, что и в кабинетах
    // (SEC-13): они восстанавливают исходный TypeScript из раздаваемого каталога.
    build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
  };
});
