#!/usr/bin/env node
/**
 * Реестр проверок обязан соответствовать коду.
 *
 * ЗАЧЕМ. Документ о тестах расходится с репозиторием за недели, и это хуже
 * его отсутствия: на него ссылаются, принимая решения. Здесь расхождение —
 * красный прогон, а не открытие полугодовой давности.
 *
 * Тот же приём уже работает в проекте дважды: манифест RLS падает на
 * таблице без политики, реестр классов данных — на таблице без класса.
 *
 * ЧТО ПРОВЕРЯЕТСЯ:
 *   * идентификаторы уникальны;
 *   * каждый указанный файл существует;
 *   * каждая команда `npm run …` объявлена в package.json;
 *   * нет «сирот» — но с ИЗВЕСТНЫМИ границами: осматриваются только
 *     `scripts/*.mjs` (верхний уровень) и `database/tests/*.test.ts`.
 *     Вложенные каталоги, другие форматы, тесты внутри `apps/` и
 *     `packages/` и проверки, написанные прямо в шагах CI, этим осмотром
 *     НЕ охвачены — «сирот нет» значит «в осмотренном не найдено»;
 *   * ссылки требований и наборов ведут на существующие записи;
 *   * требование без покрытия помечено явно (`coverage: none`), а не молча;
 *   * у подтверждения запуском есть дата, у чувствительности — метод;
 *   * читаемое представление `docs/testing/реестр.md` собрано из текущего
 *     реестра, а не отстало на несколько правок.
 *
 * Запуск: npm run check:registry (входит в CI, задание static)
 */
import YAML from 'yaml';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderRegistryDoc } from './lib/registry-doc.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'docs', 'testing', 'registry.yaml');

let passed = 0;
const defects = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    defects.push(`${name}${detail ? `: ${detail}` : ''}`);
    console.error(`  ДЕФЕКТ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.warn('\n=== ЦЕЛОСТНОСТЬ РЕЕСТРА ПРОВЕРОК ===\n');

if (!existsSync(REGISTRY)) {
  console.error('  ДЕФЕКТ реестра нет: docs/testing/registry.yaml');
  process.exit(1);
}

const registry = YAML.parse(readFileSync(REGISTRY, 'utf8'));
const checks = registry.checks ?? [];
const requirements = registry.requirements ?? [];
const suites = registry.suites ?? {};
const manual = registry.manualByDesign ?? [];

// ------------------------------------------------------------ уникальность
const ids = checks.map((c) => c.id);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
check('идентификаторы проверок уникальны', duplicates.length === 0, duplicates.join(', '));

const reqIds = requirements.map((r) => r.id);
const reqDupes = reqIds.filter((id, i) => reqIds.indexOf(id) !== i);
check('идентификаторы требований уникальны', reqDupes.length === 0, reqDupes.join(', '));

// ------------------------------------------------------------ файлы и команды
const missingFiles = checks.filter((c) => c.file && !existsSync(join(ROOT, c.file)));
check(
  'все указанные файлы существуют',
  missingFiles.length === 0,
  missingFiles.map((c) => `${c.id} → ${c.file}`).join(', '),
);

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const dbPkg = JSON.parse(readFileSync(join(ROOT, 'database', 'package.json'), 'utf8'));
const badCommands = checks.filter((c) => {
  const m = String(c.command ?? '').match(/^npm run ([a-z0-9:_-]+)(\s+-w\s+(\S+))?/);
  if (!m) return false;
  const [, script, , workspace] = m;
  const scripts = workspace === 'database' ? dbPkg.scripts : pkg.scripts;
  return !(script in (scripts ?? {}));
});
check(
  'все команды npm объявлены',
  badCommands.length === 0,
  badCommands.map((c) => `${c.id} → ${c.command}`).join(', '),
);

// ------------------------------------------------------------------ сироты
const known = new Set(checks.filter((c) => c.file).map((c) => c.file.replace(/\\/g, '/')));
const orphanScripts = readdirSync(join(ROOT, 'scripts'))
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => `scripts/${f}`)
  .filter((f) => !known.has(f));
check(
  'в осмотренном скриптов вне реестра нет',
  orphanScripts.length === 0,
  orphanScripts.join(', ') || `учтено ${checks.filter((c) => c.kind !== 'ci-step').length}`,
);

/*
 * Осмотр ОБЯЗАН покрывать модульные тесты рабочих областей.
 *
 * Пока он смотрел только database/tests, 24 файла модульных проверок в
 * apps/core и packages жили вне реестра — и карта пробелов утверждала, что
 * «модульных тестов нет ни одного». Утверждение о покрытии, сделанное по
 * неполному осмотру, хуже отсутствия утверждения: на него ссылаются.
 */
const TEST_ROOTS = [
  join(ROOT, 'database', 'tests'),
  ...readdirSync(join(ROOT, 'apps')).map((app) => join(ROOT, 'apps', app, 'tests')),
  ...readdirSync(join(ROOT, 'packages')).map((pkg) => join(ROOT, 'packages', pkg, 'tests')),
];
const orphanTests = [];
for (const dir of TEST_ROOTS) {
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.test.ts')) continue;
    const relative = join(dir, file)
      .slice(ROOT.length + 1)
      .replace(/\\/g, '/');
    if (!known.has(relative)) orphanTests.push(relative);
  }
}
check(
  'в осмотренном тестов вне реестра нет',
  orphanTests.length === 0,
  orphanTests.join(', ') ||
    `осмотрено каталогов: ${TEST_ROOTS.filter((d) => existsSync(d)).length}`,
);

// ------------------------------------------------------------------ ссылки
const checkIds = new Set(ids);
const brokenLinks = [];
for (const r of requirements) {
  for (const ref of r.checks ?? []) {
    if (!checkIds.has(ref)) brokenLinks.push(`${r.id} → ${ref}`);
  }
}
check(
  'ссылки требований ведут на существующие проверки',
  brokenLinks.length === 0,
  brokenLinks.join(', '),
);

const suiteErrors = [];
for (const [name, suite] of Object.entries(suites)) {
  for (const member of suite.members ?? []) {
    // DBT-ALL — собирательная запись: весь набор тестов схемы одной командой.
    if (member === 'DBT-ALL') continue;
    if (!checkIds.has(member)) suiteErrors.push(`${name} → ${member}`);
  }
}
check(
  'наборы ссылаются на существующие проверки',
  suiteErrors.length === 0,
  suiteErrors.join(', '),
);

/*
 * Блоки обязаны ссылаться на существующее и покрывать ВСЁ запускаемое.
 *
 * Прогон, не попавший ни в один блок, не будет запущен никогда: правило
 * «после большого изменения гоняем затронутый блок» его просто не
 * достигает. Молчаливая дыра в этом правиле — хуже отсутствия правила.
 */
const blocks = registry.blocks ?? {};
const blockErrors = [];
for (const [name, block] of Object.entries(blocks)) {
  for (const member of block.members ?? []) {
    if (!checkIds.has(member)) blockErrors.push(`${name} → ${member}`);
  }
}
check('блоки ссылаются на существующие проверки', blockErrors.length === 0, blockErrors.join(', '));

// Пробы тоже запускаемые: каждая закрывает находку внешнего аудита, и
// оставлять их вне блоков значит не запускать никогда.
const RUNNABLE = ['check', 'render', 'scenario', 'smoke', 'gate', 'unit-test', 'db-test', 'probe'];
const inBlocks = new Set(Object.values(blocks).flatMap((b) => b.members ?? []));
const outsideBlocks = checks.filter((x) => RUNNABLE.includes(x.kind) && !inBlocks.has(x.id));
check(
  'каждый запускаемый прогон входит хотя бы в один блок',
  outsideBlocks.length === 0,
  outsideBlocks
    .slice(0, 10)
    .map((x) => x.id)
    .join(', '),
);

const manualErrors = (manual ?? []).filter((m) => !checkIds.has(m.id)).map((m) => m.id);
check('ручные прогоны существуют', manualErrors.length === 0, manualErrors.join(', '));

// -------------------------------------------------------------- честность
const silentGaps = requirements.filter(
  (r) => (r.checks ?? []).length === 0 && r.coverage !== 'none',
);
check(
  'требование без покрытия помечено явно',
  silentGaps.length === 0,
  silentGaps.map((r) => r.id).join(', '),
);

const undatedRuns = requirements.filter(
  (r) => r.confirmation === 'confirmed-by-run' && !r.confirmedOn,
);
check(
  'у подтверждения запуском есть дата',
  undatedRuns.length === 0,
  undatedRuns.map((r) => r.id).join(', '),
);

/*
 * Подтверждение чувствительности состоит из трёх частей.
 *
 * «Краснеет без починки» без метода — вера; без даты и версии кода —
 * утверждение о неизвестно каком продукте. Проверка видела то поведение,
 * которое было в тот день и на том коммите.
 */
const unmethodicalSensitivity = requirements.filter(
  (r) =>
    r.sensitivity?.status === 'verified' &&
    (!r.sensitivity?.method || !r.sensitivity?.date || !r.sensitivity?.commit),
);
check(
  'у подтверждённой чувствительности назван метод, дата и версия кода',
  unmethodicalSensitivity.length === 0,
  unmethodicalSensitivity.map((r) => r.id).join(', '),
);

/*
 * ИЗУЧЕНИЕ И ЗАПУСК — РАЗНЫЕ ОСИ.
 *
 * Прогон можно запустить и не читать; можно прочитать и не запускать. Пока
 * это было одним полем, инвентаризация выдала за «изучено по коду» то, что
 * на деле прочитано по шапке файла, — и четыре записи «покрытия нет»
 * оказались неверными. Теперь уровень изучения назван прямо:
 *
 *   studied: code    — тело прочитано целиком или написано здесь;
 *   studied: partial — прочитаны отдельные места, и вывод сделан только
 *                      о них;
 *   studied: header  — известны название и шапка, тело не читалось.
 */
const badStudied = checks.filter((c) => !['code', 'partial', 'header'].includes(c.studied));
check(
  'у каждой проверки назван уровень изучения',
  badStudied.length === 0,
  badStudied
    .slice(0, 8)
    .map((c) => c.id)
    .join(', '),
);

const badConfirmation = checks
  .concat(requirements)
  .filter(
    (x) =>
      x.confirmation &&
      !['confirmed-by-run', 'reviewed-in-code', 'needs-study', 'blocked', 'not-run'].includes(
        x.confirmation,
      ),
  );
check(
  'уровни подтверждения из допустимого перечня',
  badConfirmation.length === 0,
  badConfirmation.map((x) => `${x.id}=${x.confirmation}`).join(', '),
);

/*
 * Читаемое представление не должно отставать от реестра.
 *
 * Текст генерируется (`npm run docs:registry`), а значит может быть забыт
 * после правки YAML. Документ о тестах, отставший на неделю, хуже его
 * отсутствия: по нему принимают решения. Поэтому расхождение — дефект.
 */
/** Перевод строк не должен решать, отстал документ или нет. */
const normalizeEol = (text) => text.split(String.fromCharCode(13)).join(String.fromCharCode());

const DOC = join(ROOT, 'docs', 'testing', 'реестр.md');
const expected = renderRegistryDoc(registry);
const actual = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
const docFresh = normalizeEol(actual) === expected;
check(
  'читаемое представление собрано из текущего реестра',
  docFresh,
  docFresh
    ? ''
    : actual
      ? 'файл отстал — выполните npm run docs:registry'
      : 'файла нет — npm run docs:registry',
);

// ------------------------------------------------------------------- сводка
const inSuites = new Set(Object.values(suites).flatMap((s) => s.members ?? []));
const manualIds = new Set(manual.map((m) => m.id));
const notInSuites = checks.filter(
  (c) =>
    c.runner !== 'ci' &&
    c.kind !== 'tool' &&
    c.kind !== 'ci-step' &&
    !inSuites.has(c.id) &&
    !manualIds.has(c.id),
);

console.warn('\n  Сводка:');
console.warn(`    проверок в реестре: ${checks.length}`);
console.warn(`    требований: ${requirements.length}`);
console.warn(
  `    запускается автоматически (CI): ${checks.filter((c) => c.runner === 'ci').length}`,
);
console.warn(`    в наборах: ${inSuites.size - 1}`); // минус собирательный DBT-ALL
console.warn(`    намеренно вручную: ${manual.length}`);
console.warn(`    зарегистрированы, но ни в наборе, ни в CI: ${notInSuites.length}`);

console.warn(`\nпройдено: ${passed}, дефектов: ${defects.length}\n`);
process.exit(defects.length === 0 ? 0 : 1);
