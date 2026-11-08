import { defineConfig } from 'vitest/config';

/**
 * Собственная конфигурация пакета: без неё `vitest run` поднимается до корневой, и её
 * `projects` резолвятся от каталога пакета (как в packages/api-client). Тесты пакета —
 * логика без браузера.
 */
export default defineConfig({
  test: {},
});
