#!/usr/bin/env node
/**
 * Проверка, что граница «фронтенд не импортирует бэкенд» действительно
 * работает, а не просто описана в ADR-002.
 *
 * Метод — позитивный контроль: линтеру показывают файл с запрещённым
 * импортом. Если он его НЕ поймал — значит правило перестало действовать
 * (переименовали каталог, поменяли конфиг, отключили плагин), и заменяемость
 * фронтенда держится на честном слове.
 *
 * РАБОЧИЕ ИСХОДНИКИ НЕ ТРОГАЮТСЯ. Прежняя версия писала пробный файл прямо в
 * `apps/<приложение>/src/__boundary_probe__` и удаляла его в finally. Работало,
 * но означало, что обычная проверка изменяет дерево проекта: прерванный на
 * середине запуск оставлял мусор в исходниках, а параллельный запуск мешал
 * сборке. Теперь код проверяется через ESLint API методом `lintText` с
 * ВИРТУАЛЬНЫМ путём: правила применяются так, будто файл лежит в
 * `apps/<приложение>/src/`, но на диске он не появляется вовсе.
 *
 * Запуск: node scripts/check-frontend-boundary.mjs
 */
import { ESLint } from 'eslint';
import { existsSync } from 'node:fs';
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
const FRONTEND_APPS = [
  'web-public',
  'lab',
  'investor',
  'expert',
  'admin',
  'console',
  'auth',
].filter((app) => existsSync(join(ROOT, 'apps', app)));

if (FRONTEND_APPS.length === 0) {
  console.error('Ни одного фронтенд-приложения не найдено — проверять нечего.');
  process.exitCode = 1;
}

/*
 * Один экземпляр линтера на весь прогон.
 *
 * Прежде на каждый случай запускался отдельный процесс eslint — семь
 * приложений на пять случаев давали 35 запусков и больше минуты ожидания.
 * Здесь конфигурация читается один раз.
 */
const eslint = new ESLint({ cwd: ROOT, warnIgnored: false });

/**
 * Показать линтеру код по виртуальному пути.
 *
 * @returns true, если линтер СООБЩИЛ О НАРУШЕНИИ. Отсутствие результатов —
 * это не «чисто», а «файл не проверялся» (попал под ignores или не подошёл
 * ни под один блок конфигурации): такой исход считается сбоем прогона, иначе
 * неработающая проверка выглядела бы как работающая защита.
 */
async function lintFails(virtualPath, code) {
  const results = await eslint.lintText(code, { filePath: virtualPath });
  if (results.length === 0) {
    throw new Error(`ESLint не проверил ${virtualPath}: файл исключён из проверки`);
  }
  return results.some((r) => r.errorCount > 0);
}

let failures = 0;
let checks = 0;

for (const app of FRONTEND_APPS) {
  // Путь ВИРТУАЛЬНЫЙ: файла с таким именем на диске нет и не будет. Он нужен
  // лишь для того, чтобы конфигурация применила к коду те же правила, что и к
  // настоящему исходнику этого приложения.
  const probePath = join(ROOT, 'apps', app, 'src', '__boundary_probe__', 'probe.ts');

  for (const testCase of FORBIDDEN_CASES) {
    checks += 1;
    if (await lintFails(probePath, testCase.code)) {
      console.warn(`  OK    apps/${app}: импорт «${testCase.name}» отвергнут`);
    } else {
      failures += 1;
      console.warn(
        `  FAIL  apps/${app}: импорт «${testCase.name}» ПРОШЁЛ линтер. ` +
          'Граница фронт↔бэк не работает (ADR-002).',
      );
    }
  }

  checks += 1;
  if (await lintFails(probePath, ALLOWED_CASE.code)) {
    failures += 1;
    console.warn(
      `  FAIL  apps/${app}: разрешённый импорт «${ALLOWED_CASE.name}» отвергнут. ` +
        'Правило слишком широкое — фронтенд не сможет пользоваться контрактами.',
    );
  } else {
    console.warn(`  OK    apps/${app}: импорт «${ALLOWED_CASE.name}» разрешён`);
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
