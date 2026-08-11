import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Кабинет инвестора. Единственная связь с бэкендом — HTTP /v1.
// Прямого доступа к БД, очередям и хранилищу у фронтенда нет и быть не может:
// это проверяется линтером и SAST-правилом, а не договорённостью (ADR-002).
export default defineConfig({
  plugins: [react()],
  server: { port: 5176, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5176, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
