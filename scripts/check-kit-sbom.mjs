#!/usr/bin/env node
/**
 * Опись в комплекте выпуска: сохранение и проверка (блок 11; замечание Тэнка 09.11).
 *
 *   node scripts/check-kit-sbom.mjs
 *
 * Полный путь kit.mjs pack → storeKit → commitKit → kit.mjs check на своём каталоге
 * комплектов (FIFTH_KITS_DIR). Образы не собираются: три метки на один маленький
 * локальный образ. Случаи: исправная опись, удалённый файл, изменённый файл, комплект
 * без описи (выпущенный раньше), опись, не совпавшая с суммами уже при сборке.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WORK = join(ROOT, '.local', 'check-kit-sbom');
const KITS = join(WORK, 'kits');
const SBOM = join(WORK, 'sbom');
const TAG = 'sbom-check';
const BASE = process.env.FIFTH_SBOM_CHECK_IMAGE ?? 'nats:2.10-alpine';
const env = { ...process.env, FIFTH_KITS_DIR: KITS, MSYS_NO_PATHCONV: '1' };

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const node = (script, args) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    env,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    /* не JSON */
  }
  return { code: r.status, json, out: `${r.stdout}${r.stderr}`.trim() };
};
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' });
const kit = (...a) => node('kit.mjs', a);
const kitFile = (build, name) => join(KITS, build, 'sbom', name);

console.log('\n=== ОПИСЬ В КОМПЛЕКТЕ: СОХРАНЕНИЕ И ПРОВЕРКА ===\n');
rmSync(WORK, { recursive: true, force: true });
mkdirSync(KITS, { recursive: true });
try {
  if (docker('image', 'inspect', BASE).status !== 0) throw new Error(`нет образа ${BASE}`);
  for (const c of ['core', 'web', 'postgres']) docker('tag', BASE, `fifth/${c}:${TAG}`);
  const made = node('sbom.mjs', ['--out', SBOM]);
  if (made.code !== 0) throw new Error(`опись не собрана: ${made.out.slice(-200)}`);

  // 1. Исправная опись.
  const B1 = '2.1-b9101.1';
  const p1 = kit('pack', '--build', B1, '--from', TAG, '--sbom', SBOM);
  check('комплект с описью сохранён', p1.code === 0, p1.out.slice(-160));
  const manifest = JSON.parse(readFileSync(join(KITS, B1, 'kit.json'), 'utf8'));
  const names = Object.keys(manifest.sbom?.files ?? {});
  check(
    'все файлы описи из манифеста лежат в комплекте',
    names.length >= 5 && names.every((n) => existsSync(kitFile(B1, n))),
    names.join(', '),
  );
  check('проверка исправного комплекта проходит', kit('check', '--build', B1).code === 0);

  // 2. Удалённый файл.
  const keep = readFileSync(kitFile(B1, 'licenses.md'));
  rmSync(kitFile(B1, 'licenses.md'));
  const gone = kit('check', '--build', B1);
  check(
    'удалённый файл описи — отказ',
    gone.code !== 0 && /licenses\.md нет/.test(gone.json?.error ?? ''),
    gone.json?.error,
  );
  writeFileSync(kitFile(B1, 'licenses.md'), keep);

  // 3. Изменённый файл.
  appendFileSync(kitFile(B1, 'sbom-shipped.cdx.json'), ' ');
  const changed = kit('check', '--build', B1);
  check(
    'изменённый файл описи — отказ',
    changed.code !== 0 &&
      /sbom-shipped\.cdx\.json — хеш не сошёлся/.test(changed.json?.error ?? ''),
    changed.json?.error,
  );

  // 4. Комплект без описи (выпущенный до неё) — совместим.
  const B2 = '2.1-b9102.1';
  const p2 = kit('pack', '--build', B2, '--from', TAG);
  const old = JSON.parse(readFileSync(join(KITS, B2, 'kit.json'), 'utf8'));
  delete old.sbom; // у старых комплектов поля нет вовсе
  writeFileSync(join(KITS, B2, 'kit.json'), `${JSON.stringify(old, null, 2)}\n`);
  check(
    'старый комплект без поля описи проходит проверку',
    p2.code === 0 && kit('check', '--build', B2).code === 0,
  );

  // 5. Опись не совпала с суммами уже при сборке — комплект не создаётся.
  appendFileSync(join(SBOM, 'images.json'), ' ');
  const B3 = '2.1-b9103.1';
  const p3 = kit('pack', '--build', B3, '--from', TAG, '--sbom', SBOM);
  check(
    'подменённая до сборки опись — отказ, комплекта нет',
    p3.code === 2 && !existsSync(join(KITS, B3)),
    p3.json?.error,
  );
} catch (error) {
  failed += 1;
  console.log(`  FAIL  прогон прерван — ${error.message}`);
} finally {
  for (const c of ['core', 'web', 'postgres']) docker('rmi', `fifth/${c}:${TAG}`);
  for (const b of ['2.1-b9101.1', '2.1-b9102.1', '2.1-b9103.1'])
    for (const c of ['core', 'web', 'postgres']) docker('rmi', `fifth/${c}:${b}`);
  rmSync(WORK, { recursive: true, force: true });
}
console.log(`\nИТОГО: ${passed} пройдено, ${failed} провалено`);
process.exit(failed === 0 ? 0 : 1);
