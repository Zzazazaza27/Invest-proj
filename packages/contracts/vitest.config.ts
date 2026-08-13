import { defineConfig } from 'vitest/config';

/**
 * Собственная конфигурация пакета. Без неё `vitest run` из каталога пакета
 * поднимается до корневой конфигурации, а её `projects` резолвятся от cwd —
 * запуск падает на несуществующем `packages/contracts/apps/core` (Ф26).
 * Пакету хватает умолчаний: чистые юнит-тесты без DI и без тестовой БД.
 */
export default defineConfig({
  test: {},
});
