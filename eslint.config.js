// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Единая конфигурация линтера монорепо.
 *
 * Ключевой архитектурный инвариант, который проверяется здесь:
 * ФРОНТЕНД НЕ ИМПОРТИРУЕТ БЭКЕНД. Приложения из apps/{web-public,lab,investor,
 * expert,admin} могут зависеть только от packages/* (contracts, api-client, ui).
 * Любой импорт из apps/core или database — ошибка сборки, а не замечание в ревью.
 * Это то, что делает фронтенд заменяемым по частям.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.vite/**',
      '**/coverage/**',
      '**/playwright-report/**',
      'apps/ai-gateway/**',
      'apps/ai-workers/**',
      'graphify-out/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // По умолчанию flat config берёт только .js/.mjs/.cjs — JSX и TSX
    // приходится включать явно, иначе фронтенд молча остаётся непроверенным.
    files: ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-globals': ['error', 'event', 'name'],
    },
  },

  // --- Граница фронтенда: только контракты, клиент и UI-пакет ---
  {
    files: [
      'apps/web-public/**/*.{js,jsx,ts,tsx}',
      'apps/lab/**/*.{js,jsx,ts,tsx}',
      'apps/investor/**/*.{js,jsx,ts,tsx}',
      'apps/expert/**/*.{js,jsx,ts,tsx}',
      'apps/admin/**/*.{js,jsx,ts,tsx}',
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2023 },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/core/**', '@unicorn/core', '@unicorn/core/*'],
              message:
                'Фронтенд не импортирует бэкенд. Разрешены только @unicorn/contracts, @unicorn/api-client, @unicorn/ui.',
            },
            {
              group: ['**/database/**', 'pg', 'pg-*', 'nats', 'bullmq', 'ioredis'],
              message:
                'Фронтенд не имеет доступа к БД, очередям и шине. Только HTTP /v1 через @unicorn/api-client.',
            },
          ],
        },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // --- Бэкенд не импортирует фронтенд (обратная граница) ---
  {
    files: ['apps/core/**/*.ts', 'packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/apps/web-public/**',
                '**/apps/lab/**',
                '**/apps/investor/**',
                '**/apps/expert/**',
                '**/apps/admin/**',
                '@unicorn/ui',
                '@unicorn/ui/*',
                'react',
                'react-dom',
              ],
              message: 'Бэкенд не зависит от фронтенда. Общий язык — только @unicorn/contracts.',
            },
          ],
        },
      ],
    },
  },

  // --- Тесты: послабления ---
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
);
