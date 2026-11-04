import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Файлы запуска рабочей среды живут в комплекте (`prod-compose/`), а не только в
 * репозитории: иначе возврат зависел бы от того, что сейчас лежит в рабочей копии.
 * Установка сверяет их с манифестом и делает действующими для этой среды.
 */
export const prodFileName = (file) => basename(file);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Сверка файлов комплекта с манифестом: список проблем. */
export function prodFileProblems(kitDir, kit) {
  if (!kit.prodCompose) return [`в комплекте ${kit.build} нет файлов рабочей среды`];
  const problems = [];
  for (const [file, sum] of Object.entries(kit.prodCompose)) {
    const path = join(kitDir, 'prod-compose', prodFileName(file));
    if (!existsSync(path)) problems.push(`${file}: нет в комплекте ${kit.build}`);
    else if (sha256(readFileSync(path)) !== sum) problems.push(`${file}: хеш не сошёлся`);
  }
  return problems;
}

/** Сделать файлы комплекта действующими. Отказ — до копирования. */
export function activateProdFiles(kitDir, kit, activeDir) {
  const problems = prodFileProblems(kitDir, kit);
  if (problems.length) throw new Error(problems.join('; '));
  mkdirSync(activeDir, { recursive: true });
  for (const file of Object.keys(kit.prodCompose)) {
    const name = prodFileName(file);
    copyFileSync(join(kitDir, 'prod-compose', name), join(activeDir, name));
  }
}
