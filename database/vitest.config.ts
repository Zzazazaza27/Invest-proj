import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Тесты идут против реальной БД: параллельные файлы конкурировали бы за
    // advisory-локи и последовательность hash-chain.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { NODE_ENV: 'test' },
    include: ['tests/**/*.test.ts'],
  },
});
