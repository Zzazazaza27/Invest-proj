import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS опирается на emitDecoratorMetadata, которого esbuild не умеет.
// swc даёт метаданные декораторов — без него DI в тестах не работает.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    include: ['tests/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
});
