#!/usr/bin/env node
/**
 * Запуск набора проверок по реестру.
 *
 * ЗАЧЕМ. «Прогони, что вспомнишь» — не порядок работы: вспоминается разное,
 * и отчитаться нечем. Набор описан в реестре (`docs/testing/registry.yaml`),
 * запускается одной командой и оставляет отчёт, по которому видно, что
 * именно проверено и на какой версии кода.
 *
 * ЧЕСТНОСТЬ ОТЧЁТА:
 *   * пропущенное и заблокированное НЕ считается зелёным и выводится
 *     отдельным списком с причиной;
 *   * повторный запуск не затирает предыдущий отчёт — видно, была ли
 *     проверка нестабильной;
 *   * в отчёте записана версия кода и состояние рабочего дерева: «зелено на
 *     незакоммиченных правках» — другое утверждение, чем «зелено на коммите».
 *
 * Запуск:
 *   npm run suite:handoff      перед передачей владельцу
 *   npm run suite:regression   перед выкатом или по требованию
 *   npm run suite:isolated     разрушительные проверки (своё окружение)
 */
import YAML from 'yaml';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'docs', 'testing', 'registry.yaml');

const suiteName = process.argv[2];
if (!suiteName) {
  console.error('нужно имя набора: handoff | regression | isolated');
  process.exit(1);
}

const registry = YAML.parse(readFileSync(REGISTRY, 'utf8'));
const suite = registry.suites?.[suiteName];
if (!suite) {
  console.error(
    `набора «${suiteName}» в реестре нет; есть: ${Object.keys(registry.suites ?? {}).join(', ')}`,
  );
  process.exit(1);
}
const byId = new Map(registry.checks.map((c) => [c.id, c]));

/** Версия кода: без неё «зелено» — утверждение ни о чём. */
function codeVersion() {
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return {
    commit: String(commit.stdout ?? '').trim() || 'неизвестно',
    dirty: String(dirty.stdout ?? '').trim().length > 0,
  };
}

/** Поднят ли стенд: браузерным прогонам без него делать нечего. */
function standUp() {
  const probe = spawnSync(
    'node',
    [
      '-e',
      "fetch('http://127.0.0.1/v1/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))",
    ],
    { encoding: 'utf8' },
  );
  return probe.status === 0;
}

const version = codeVersion();
const stand = standUp();

console.warn(`\n=== НАБОР «${suite.title}» ===\n`);
console.warn(`  версия кода: ${version.commit}${version.dirty ? ' + незакоммиченные правки' : ''}`);
console.warn(`  стенд: ${stand ? 'поднят' : 'НЕ поднят'}`);
console.warn(`  состав: ${suite.members.length} позиций\n`);

/*
 * Каталог отчёта заводится ДО прогонов: полный вывод упавшей проверки
 * сохраняется рядом с отчётом сразу, а не пересказывается тремя строками.
 * Разбирать отказ по обрезанному хвосту нельзя.
 */
const outDir = join(ROOT, 'out', 'suites');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const reportPath = join(outDir, `${suiteName}-${stamp}.md`);

const results = [];

function runOne(id) {
  // Собирательная позиция: весь набор тестов схемы одной командой.
  if (id === 'DBT-ALL') {
    return {
      id,
      title: 'Тесты схемы БД (18 файлов)',
      command: 'npm run test -w database',
      needs: ['db'],
    };
  }
  const entry = byId.get(id);
  if (!entry) return null;
  return {
    id,
    title: entry.purpose?.slice(0, 70) ?? id,
    command: entry.command,
    needs: entry.needs ?? [],
    kind: entry.kind,
  };
}

for (const id of suite.members) {
  const item = runOne(id);
  if (!item) {
    results.push({ id, state: 'пропущено', reason: 'нет в реестре', ms: 0 });
    continue;
  }

  const needsStand =
    item.kind === 'render' || item.kind === 'scenario' || item.needs.includes('core');
  if (needsStand && !stand) {
    results.push({ id, state: 'пропущено', reason: 'стенд не поднят (npm run stand:up)', ms: 0 });
    console.warn(`  ПРОПУСК ${id} — стенд не поднят`);
    continue;
  }

  /*
   * Пауза перед прогоном, делящим с соседом ограничение частоты.
   *
   * Набор идёт подряд, а лимиты платформы рассчитаны на человека. Без паузы
   * второй прогон той же области получает 429 и краснеет не на продукте.
   * Пауза объявлена в реестре у самого прогона — там, где видно причину.
   */
  const cooldown = Number(byId.get(id)?.cooldownSeconds ?? 0);
  if (cooldown > 0) {
    console.warn(`  пауза ${cooldown} с перед ${id} (общее ограничение частоты)`);
    await new Promise((resolve) => setTimeout(resolve, cooldown * 1000));
  }

  const started = Date.now();
  const env = { ...process.env };
  if (item.kind === 'render') env.UNICORN_ENTRY = 'web';
  const [cmd, ...args] = item.command.split(' ');
  const run = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env, shell: true });
  const ms = Date.now() - started;
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const ok = run.status === 0;

  /*
   * У отказа причина обязательна.
   *
   * Сначала берутся итоговые строки прогона. Но прогон, упавший с
   * исключением, до них не доходит — и отчёт показывал пустую причину, по
   * которой разобрать нечего. Поэтому у отказа без итоговой строки берётся
   * хвост вывода как есть.
   */
  let tail = output
    .split('\n')
    .filter((l) => /пройдено|дефект|Tests|FAIL|ДЕФЕКТ/i.test(l))
    .slice(-2)
    .join(' | ')
    .slice(0, 160);
  if (!ok && !tail) {
    tail = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' | ')
      .slice(0, 220);
  }
  let log = null;
  if (!ok) {
    log = `${suiteName}-${stamp}-${id}.log`;
    writeFileSync(join(outDir, log), output, 'utf8');
  }
  results.push({ id, state: ok ? 'успех' : 'ОТКАЗ', reason: tail, ms, log });
  console.warn(
    `  ${ok ? 'ok    ' : 'ОТКАЗ '}${id} — ${Math.round(ms / 1000)} с${tail ? ` · ${tail}` : ''}`,
  );
}

// ---------------------------------------------------------------- отчёт
const failed = results.filter((r) => r.state === 'ОТКАЗ');
const skipped = results.filter((r) => r.state === 'пропущено');
const passed = results.filter((r) => r.state === 'успех');

const lines = [
  `# Набор «${suite.title}»`,
  '',
  `- Дата: ${new Date().toLocaleString('ru-RU')}`,
  `- Версия кода: \`${version.commit}\`${version.dirty ? ' **+ незакоммиченные правки**' : ''}`,
  `- Стенд: ${stand ? 'поднят' : 'не поднят'}`,
  `- Итог: успех ${passed.length}, отказ ${failed.length}, пропущено ${skipped.length}`,
  '',
  '| Проверка | Итог | Время | Подробности |',
  '| --- | --- | --- | --- |',
  ...results.map(
    (r) =>
      `| ${r.id} | ${r.state} | ${Math.round(r.ms / 1000)} с | ${r.reason || ''}${
        r.log ? ` (полный вывод: \`${r.log}\`)` : ''
      } |`,
  ),
  '',
];
if (failed.length > 0) {
  lines.push('## Отказы — полный вывод', '');
  for (const r of failed) lines.push(`- **${r.id}**: \`${r.log}\` рядом с этим отчётом`);
  lines.push('');
}
if (skipped.length > 0) {
  lines.push('## Пропущенное — НЕ считается пройденным', '');
  for (const r of skipped) lines.push(`- **${r.id}**: ${r.reason}`);
  lines.push('');
}
writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.warn(`\n  успех ${passed.length}, отказ ${failed.length}, пропущено ${skipped.length}`);
console.warn(`  отчёт: ${reportPath}\n`);

if (skipped.length > 0) {
  console.warn('  ВНИМАНИЕ: пропущенное не пройдено. Причины в отчёте.\n');
}

process.exit(failed.length === 0 ? 0 : 1);
