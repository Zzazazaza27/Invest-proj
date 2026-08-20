#!/usr/bin/env node
/**
 * Проверка, что граница «фронтенд не импортирует бэкенд» действительно
 * работает, а не просто описана в ADR-002.
 *
 * Метод — позитивный контроль: во фронтенд временно кладётся файл с
 * запрещённым импортом. Если линтер его НЕ поймал — значит правило перестало
 * действовать (переименовали каталог, поменяли конфиг, отключили плагин), и
 * заменяемость фронтенда держится на честном слове.
 *
 * Запуск: node scripts/check-frontend-boundary.mjs
 */
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Каждый случай — импорт, который обязан быть отвергнут. */
const FORBIDDEN_CASES = [
  { name: 'драйвер PostgreSQL', code: "import pg from 'pg';\nexport const x = pg;\n" },
  { name: 'клиент Redis', code: "import Redis from 'ioredis';\nexport const x = Redis;\n" },
  { name: 'шина NATS', code: "import { connect } from 'nats';\nexport const x = connect;\n" },
  { name: 'очередь BullMQ', code: "import { Queue } from 'bullmq';\nexport const x = Queue;\n" },
];

/** Импорт, который обязан быть разрешён: иначе правило просто запрещает всё. */
const ALLOWED_CASE = {
  name: 'контракты',
  code: "import { API_VERSION } from '@unicorn/contracts';\nexport const x = API_VERSION;\n",
};

// Консоль разработки — такой же фронтенд с точки зрения границы: она обращается
// к тому же публичному API и не имеет права ходить в БД, очереди и хранилище
// напрямую. Забыть её здесь означало бы оставить дыру в проверке (ADR-002).
const FRONTEND_APPS = ['web-public', 'lab', 'investor', 'expert', 'admin', 'console', 'auth'].filter(
  (app) => existsSync(join(ROOT, 'apps', app)),
);

if (FRONTEND_APPS.length === 0) {
  console.error('Ни одного фронтенд-приложения не найдено — проверять нечего.');
  process.exitCode = 1;
}

// eslint запускается напрямую через node, а не через npx: npx на Windows —
// это .cmd, execFileSync без shell на нём падает с ENOENT, и такой сбой
// раньше принимался за «линтер поймал нарушение».
const ESLINT_BIN = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');

/**
 * @returns true, если eslint СООБЩИЛ О НАРУШЕНИИ (код выхода 1).
 * Любой другой сбой запуска — исключение, а не молчаливое «нарушение найдено»:
 * иначе сломанный запуск выглядел бы как работающая защита.
 */
function lintFails(file) {
  try {
    execFileSync(process.execPath, [ESLINT_BIN, '--no-warn-ignored', file], {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return false;
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
      return true;
    }
    const detail =
      error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr)
        : String(error);
    throw new Error(`Не удалось запустить eslint для ${file}: ${detail}`, { cause: error });
  }
}

if (!existsSync(ESLINT_BIN)) {
  console.error(`eslint не найден по пути ${ESLINT_BIN}. Выполни npm install.`);
  process.exit(1);
}

let failures = 0;
let checks = 0;

for (const app of FRONTEND_APPS) {
  const dir = join(ROOT, 'apps', app, 'src', '__boundary_probe__');
  mkdirSync(dir, { recursive: true });

  try {
    for (const testCase of FORBIDDEN_CASES) {
      const file = join(dir, 'forbidden.ts');
      writeFileSync(file, testCase.code, 'utf8');
      checks += 1;
      if (lintFails(file)) {
        console.warn(`  OK    apps/${app}: импорт «${testCase.name}» отвергнут`);
      } else {
        failures += 1;
        console.warn(
          `  FAIL  apps/${app}: импорт «${testCase.name}» ПРОШЁЛ линтер. ` +
            'Граница фронт↔бэк не работает (ADR-002).',
        );
      }
      rmSync(file, { force: true });
    }

    const allowedFile = join(dir, 'allowed.ts');
    writeFileSync(allowedFile, ALLOWED_CASE.code, 'utf8');
    checks += 1;
    if (lintFails(allowedFile)) {
      failures += 1;
      console.warn(
        `  FAIL  apps/${app}: разрешённый импорт «${ALLOWED_CASE.name}» отвергнут. ` +
          'Правило слишком широкое — фронтенд не сможет пользоваться контрактами.',
      );
    } else {
      console.warn(`  OK    apps/${app}: импорт «${ALLOWED_CASE.name}» разрешён`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.warn(
  `\nГраница фронт↔бэк: ${checks - failures}/${checks} проверок пройдено ` +
    `(приложений: ${FRONTEND_APPS.length}).`,
);

if (failures > 0) {
  console.warn('Гейт НЕ пройден: заменяемость фронтенда не гарантируется.\n');
  process.exitCode = 1;
} else {
  console.warn('Гейт пройден.\n');
}

// Черновой каталог не должен пережить прогон ни при каком исходе — в том числе
// после прерванного запуска.
for (const app of FRONTEND_APPS) {
  rmSync(join(ROOT, 'apps', app, 'src', '__boundary_probe__'), { recursive: true, force: true });
}
