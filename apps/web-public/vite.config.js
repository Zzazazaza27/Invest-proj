import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Публичная витрина. Единственная связь с бэкендом — VITE_API_BASE_URL.
// Никаких прокси к БД, очередям или внутренним сервисам (см. ADR-002).
export default defineConfig({
  plugins: [react()],
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
    sourcemap: true,
    target: 'es2022',
  },
});
