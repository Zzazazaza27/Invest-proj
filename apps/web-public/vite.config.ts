import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Публичная витрина. Единственная связь с бэкендом — VITE_API_BASE_URL.
// Никаких прокси к БД, очередям или внутренним сервисам (см. ADR-002).
export default defineConfig({
  plugins: [react()],
  // Пакеты монорепо собираются в CommonJS: их потребляет и ядро на NestJS,
  // которое ESM не принимает. Vite не пре-бандлит связанные пакеты по
  // умолчанию и подаёт их браузеру как есть — тот падает на именованном
  // экспорте из CJS-модуля. Явное включение возвращает шаг преобразования.
  optimizeDeps: { include: ['@unicorn/api-client', '@unicorn/contracts'] },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  preview: {
    port: 5173,
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
});
