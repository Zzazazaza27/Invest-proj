import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Публичная витрина. Единственная связь с бэкендом — VITE_API_BASE_URL.
// Никаких прокси к БД, очередям или внутренним сервисам (см. ADR-002).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Порт берётся из корневого `.env` стенда, а не зашивается здесь.
 *
 * Раньше число стояло прямо в конфиге, и такое же — в `package.json`,
 * `docker-compose.yml` и семи скриптах проверки. Смена порта (конфликт на
 * машине, переезд стенда) требовала синхронной правки всех, а рассинхрон
 * проявлялся не сообщением об ошибке, а «фронтенд не отвечает»: прогон стучался
 * по старому адресу, Vite слушал новый. Дефолт ниже — исходный порт проекта,
 * то есть поведение свежего клона без `.env`.
 *
 * `loadEnv` с пустым префиксом читает и переменные без `VITE_`; в код
 * приложения они при этом НЕ попадают — здесь это build-time значение конфига,
 * а не `import.meta.env` браузера.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, '');
  const raw = env.WEB_PUBLIC_PORT;
  const port = raw === undefined || raw === '' ? 5173 : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`WEB_PUBLIC_PORT=${raw} — не порт (нужно целое 1..65535)`);
  }

  return {
    // Значок вкладки лежит один на все приложения: иначе семь копий одного
    // favicon расходятся по одной за раз. Каталог общий — `packages/ui/public`.
    publicDir: resolve(ROOT, 'packages', 'ui', 'public'),
    plugins: [react()],
    // Пакеты монорепо собираются в CommonJS: их потребляет и ядро на NestJS,
    // которое ESM не принимает. Vite не пре-бандлит связанные пакеты по
    // умолчанию и подаёт их браузеру как есть — тот падает на именованном
    // экспорте из CJS-модуля. Явное включение возвращает шаг преобразования.
    optimizeDeps: { include: ['@fifth/api-client', '@fifth/contracts'] },
    server: {
      port,
      strictPort: true,
      host: '127.0.0.1',
    },
    preview: {
      port,
      strictPort: true,
      host: '127.0.0.1',
    },
    build: {
      outDir: 'dist',
      // Карты исходников НЕ публикуются: они восстанавливают исходный TypeScript,
      // имена и структуру маршрутов из раздаваемого каталога. Отдельного шага,
      // который бы вырезал `.map` из артефакта перед выкладкой, здесь нет — а
      // значит, «hidden» не помог бы: он лишь убирает ссылку, оставляя сами карты
      // доступными по прямому адресу (SEC-13).
      sourcemap: false,
      target: 'es2022',
    },
  };
});
