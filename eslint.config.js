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
      // Консоль разработки — тоже фронтенд: она ходит в то же публичное API и
      // прямого доступа к БД, очередям и хранилищу иметь не должна. Пропуск её
      // здесь оставлял бы в границе дыру ровно там, где удобнее всего срезать
      // угол (ADR-002).
      'apps/console/**/*.{js,jsx,ts,tsx}',
      'apps/auth/**/*.{js,jsx,ts,tsx}',
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
                '**/apps/console/**',
                '**/apps/auth/**',
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

  // --- Ядро на NestJS: DI зависит от РАНТАЙМНЫХ импортов ---
  // consistent-type-imports превращает импорт внедряемого класса в type-only,
  // а такой импорт стирается при компиляции. emitDecoratorMetadata теряет
  // токен, и приложение падает на старте с 'Nest can't resolve dependencies'.
  // Автофикс этого правила уже ломал сборку — поэтому оно здесь выключено.
  {
    files: ['apps/core/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
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

  // --- Скрипты: печать в консоль — их работа, а не забытая отладка ---
  //
  // Запрет `console.log` осмыслен в серверном коде: там он мусорит в проде и
  // тащит в журнал то, чему в нём не место. Скрипты в `scripts/` наоборот
  // существуют, чтобы печатать: гейты выводят проверки, прогоны — итоги,
  // зонды — отчёты. Правило давало 53 ошибки в четырёх файлах и держало
  // джоб CI красным, ничего при этом не защищая.
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    rules: {
      'no-console': 'off',
    },
  },
);
