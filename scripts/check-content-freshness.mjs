#!/usr/bin/env node
/**
 * Актуален ли комплект содержимого в Git относительно базы.
 *
 * ЭТО ДРУГОЙ ВОПРОС, ЧЕМ ПЕРЕНОС. Их легко спутать, и путаница дорого стоит.
 *
 *   * `check:content-transfer` спрашивает: «переносится ли содержимое без
 *     потерь» — экспорт текущего состояния, загрузка в чистую базу,
 *     сравнение. Его красный цвет означает ДЕФЕКТ переноса;
 *   * этот прогон спрашивает: «совпадает ли комплект в Git с тем, что в
 *     базе сейчас». Его красный цвет означает, что КОМПЛЕКТ УСТАРЕЛ, а не
 *     что что-то сломано: владелец правил содержимое через админку, и
 *     снимок с тех пор не пересняли.
 *
 * Раньше это было одной проверкой, и правка владельца выглядела как дефект
 * переноса. Отсюда и разделение: расхождение — повод пересобрать комплект
 * (`npm run content:export`), а не искать поломку.
 *
 * ЧТО СЧИТАЕТСЯ РАСХОЖДЕНИЕМ. Только содержимое таблиц, объявленных
 * переносимыми в реестре классов данных. Записи, заведённые прогонами,
 * исключаются тем же отбором, что и при экспорте: по происхождению автора и
 * по отброшенному родителю.
 *
 * Запуск: npm run check:content-freshness
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = join(ROOT, 'scripts', 'content-snapshot.mjs');

let passed = 0;
const defects = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.warn(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    defects.push(name);
    console.error(`  ДЕФЕКТ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.warn('\n=== АКТУАЛЬНОСТЬ КОМПЛЕКТА СОДЕРЖИМОГО ===\n');

const status = spawnSync(process.execPath, [SNAPSHOT, 'status'], {
  cwd: ROOT,
  encoding: 'utf8',
});
const out = `${status.stdout ?? ''}${status.stderr ?? ''}`;

check('снимок состояния снят', status.status === 0, status.status === 0 ? '' : out.slice(-200));

/*
 * Строки вида «  billing.service_countries   +8  (файл правили после снимка)».
 * Считаем только те, где есть цифры расхождения: пометка «файл правили»
 * сама по себе ничего не значит — файлы лежат в Git и меняются вместе с
 * кодом.
 */
const diffLines = out
  .split('\n')
  .filter((line) => /^\s{2}[a-z_]+\.[a-z_]+\s/.test(line))
  .filter((line) => /[+~-]\d+/.test(line));

if (diffLines.length === 0) {
  check('комплект в Git соответствует базе', true, 'расхождений нет');
} else {
  check(
    'комплект в Git соответствует базе',
    false,
    `устарел по ${diffLines.length} таблицам — пересобрать: npm run content:export`,
  );
  console.warn('\n  Что разошлось:\n');
  for (const line of diffLines) console.warn(`  ${line.trim()}`);
  console.warn(
    '\n  Это НЕ дефект переноса. Либо владелец правил содержимое через\n' +
      '  админку и снимок пора пересобрать, либо прогон оставил записи,\n' +
      '  которых быть не должно, — посмотрите, что именно в списке выше.\n',
  );
}

console.warn(`\nпройдено: ${passed}, дефектов: ${defects.length}\n`);
process.exit(defects.length === 0 ? 0 : 1);
