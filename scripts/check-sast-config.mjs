#!/usr/bin/env node
// Гейт целостности SAST-конфига (Ф38).
//
// `.semgrep/guardian.yml` обнулялся до 0 байт ЧЕТЫРЕ раза (Ф4, Ф6, Ф8, Ф32).
// Semgrep с пустым конфигом молча прогоняет 0 правил и возвращает 0 — гейт
// зеленел, ничего не проверяя. Расследование Ф38 исключило виновника внутри
// репозитория фактами: ни один скрипт не открывает файл на запись (только
// `--config` на чтение), Entire пишет лишь shadow-чекпоинты (в истории всех
// ref'ов нет ни одного коммита с пустым файлом), лог Entire чист. Все четыре
// случая по времени совпадают с прогонами ВНЕШНИХ инструментов сканирования
// на этой машине; точный процесс не пойман (USN-журнал требует прав
// администратора).
//
// Поэтому защита двухслойная:
//  1. этот гейт — файл обязан БАЙТ В БАЙТ совпадать с версией из HEAD:
//     любое расхождение (не только обнуление) — красный, с mtime файла как
//     временной меткой инцидента для следующего расследования;
//  2. после успешной проверки файл получает атрибут read-only: внешний
//     процесс, открывающий его на запись с truncate, получит EACCES вместо
//     тихого обнуления. Git это не мешает (commit заменяет файл целиком),
//     а правка правил — осознанное действие: `attrib -R` → правка → коммит.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REL = '.semgrep/guardian.yml';
const FILE = resolve(ROOT, REL);

function die(reason) {
  console.error(`  ПРОВАЛ  ${reason}`);
  console.error(
    '\nВосстановление: git checkout -- .semgrep/guardian.yml\n' +
      'Если файл менялся осознанно — закоммить изменение, гейт сверяет с HEAD.',
  );
  process.exit(1);
}

console.warn('\n=== ЦЕЛОСТНОСТЬ SAST-КОНФИГА ===\n');

if (!existsSync(FILE)) die(`${REL} отсутствует`);

const stat = statSync(FILE);
console.warn(`  файл: ${stat.size} байт, mtime ${stat.mtime.toISOString()}`);
if (stat.size === 0) {
  die(
    `${REL} обнулён (пятый случай!). mtime выше — временная метка инцидента: ` +
      'сопоставь с процессами, работавшими в этот момент.',
  );
}

const working = readFileSync(FILE);
let committed;
try {
  committed = execFileSync('git', ['show', `HEAD:${REL}`], { cwd: ROOT, maxBuffer: 1 << 20 });
} catch {
  die(`не удалось прочитать ${REL} из HEAD — гейту не с чем сверять`);
}
if (!working.equals(committed)) {
  die(
    `${REL} расходится с HEAD (${working.length} байт против ${committed.length}). ` +
      'Либо файл повреждён внешним процессом, либо правка не закоммичена.',
  );
}

const ruleCount = (working.toString('utf8').match(/^ {2}- id:/gm) ?? []).length;
if (ruleCount < 5) die(`в конфиге подозрительно мало правил: ${ruleCount}`);
console.warn(`  ok  совпадает с HEAD, правил: ${ruleCount}`);

// Защитный атрибут: truncate внешним процессом теперь получает отказ ОС.
// Ошибка установки не валит гейт — атрибут есть только на Windows/NTFS.
if (process.platform === 'win32') {
  try {
    execFileSync('attrib', ['+R', FILE]);
    console.warn('  ok  атрибут read-only установлен');
  } catch {
    console.warn('  ПРОП  атрибут read-only поставить не удалось');
  }
}

console.warn('\nИтог: SAST-конфиг цел.');
