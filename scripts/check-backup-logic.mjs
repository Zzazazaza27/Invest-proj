#!/usr/bin/env node
/**
 * Логика пригодности копий и сигналов (блок 7, 2.1-W07) — без docker и базы.
 *
 * Сценарии — четыре замечания Тэнка при приёмке W07; каждый падал на
 * `d984ec9`:
 *  1. разрыв журнала в середине при целом конечном сегменте → комплект не
 *     пригоден; пропавшая копия, от которой зависит добавочная, — тоже;
 *  2. подмена файла комплекта с тем же размером → сверка по описи ловит;
 *  3. готовый объект изменился под прежним ключом при том же размере →
 *     нарушение; временная загрузка изменилась → новая версия отдельно;
 *  4. недоставленный сигнал повторяется не чаще раза в 15 минут и после
 *     доставки больше не шлётся; так же — сообщение «восстановилось».
 *
 *   node scripts/check-backup-logic.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'backup-logic-'));
process.env.BACKUP_DIR = dir;
const lib = await import('./lib/backup.mjs');

let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};
const put = (rel, body = 'x') => {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), body);
};

// --------------------------------------------------- 1. цепочка журнала
console.log('\n▸ 1. Цепочка журнала и зависимости копии');
const ARCH = 'pgbackrest/archive/main/16-1/0000000100000000';
const seg = (n) => `0000000100000000000000${n.toString(16).toUpperCase().padStart(2, '0')}`;
put('pgbackrest/backup/main/L1F/backup.manifest');
put('pgbackrest/backup/main/L1F_L2I/backup.manifest');
for (const n of [0x10, 0x11, 0x13]) put(`${ARCH}/${seg(n)}-abc.zst`); // 0x12 пропал
put('keys/k.env.gpg');
const catalog = (over = {}) => ({
  db: { backup: 'L1F_L2I', references: ['L1F'], archiveId: '16-1', archiveStart: seg(0x10) },
  target: { walfile: seg(0x13) },
  keys: { file: 'keys/k.env.gpg' },
  files: { objects: [] },
  ...over,
});
let p = lib.chainProblems(catalog(), dir);
check(
  'средний сегмент пропал, конечный есть → разрыв',
  p.some((x) => x.includes('разрыв')),
  p.join('; '),
);
put(`${ARCH}/${seg(0x12)}-abc.zst`);
p = lib.chainProblems(catalog(), dir);
check('цепочка целая → проблем нет', p.length === 0, p.join('; '));
rmSync(join(dir, 'pgbackrest/backup/main/L1F'), { recursive: true });
p = lib.chainProblems(catalog(), dir);
check(
  'нет полной копии, от которой зависит добавочная → не пригоден',
  p.some((x) => x.includes('L1F')),
  p.join('; '),
);
put('pgbackrest/backup/main/L1F/backup.manifest');
check(
  'случай Тэнка: пустая копия и один конечный сегмент → не пригоден',
  lib.verifyCatalog(
    { ...catalog(), db: { backup: 'EMPTY', archiveId: '16-1', archiveStart: seg(0x01) } },
    dir,
  ).length > 0,
);

// ------------------------------------------------------- 2. опись и подмена
console.log('\n▸ 2. Опись комплекта: подмена файла того же размера');
put('files/enc/a', 'AAAA');
put('files/enc/b', 'BBBB');
const manifest = lib.buildManifest(dir, ['files/enc', 'keys/k.env.gpg']);
check('опись собрана', manifest.length === 3, manifest.map((m) => m.path).join(', '));
check('целая копия сходится с описью', lib.manifestProblems(dir, manifest).length === 0);
put('files/enc/b', 'XXXX'); // тот же размер
p = lib.manifestProblems(dir, manifest);
check(
  'подмена того же размера → другое содержимое',
  p.some((x) => x.includes('другое содержимое')),
  p.join('; '),
);
rmSync(join(dir, 'files/enc/a'));
p = lib.manifestProblems(dir, manifest);
check(
  'пропавший файл → нет файла',
  p.some((x) => x.includes('нет файла')),
  p.join('; '),
);

// ------------------------------------------------- 3. версии объектов
console.log('\n▸ 3. Изменяемые и неизменяемые объекты');
const index = new Map([
  ['p/materials/deck/m1/final/a1', { size: 10, version: 'md5-old' }],
  ['p/materials/deck/m2/upload', { size: 10, version: 'md5-old' }],
  ['p/media/logo/x/master', { size: 10, version: 'md5-same' }],
]);
const plan = lib.planObjects(index, [
  { key: 'p/materials/deck/m1/final/a1', size: 10, md5: 'md5-new' }, // готовый изменился, размер тот же
  { key: 'p/materials/deck/m2/upload', size: 10, md5: 'md5-new' }, // временный изменился
  { key: 'p/media/logo/x/master', size: 10, md5: 'md5-same' }, // без изменений
  { key: 'p/materials/deck/m3/upload', size: 5, md5: 'md5-x' }, // новый
]);
check(
  'готовый объект изменился при том же размере → нарушение',
  plan.immutableChanged.length === 1,
);
check('временная загрузка изменилась → новая версия', plan.mutableChanged.length === 1);
check('неизменившийся не копируется заново', !plan.fresh.some((o) => o.key.endsWith('master')));
const v1 = lib.backupPathOf('b', 'p/materials/deck/m2/upload', 'md5-old');
const v2 = lib.backupPathOf('b', 'p/materials/deck/m2/upload', 'md5-new');
check('версии временной загрузки — разные пути в копии', v1 !== v2, `${v1} | ${v2}`);
check(
  'готовый объект — путь по ключу',
  lib.backupPathOf('b', 'p/materials/deck/m1/final/a1', 'v') === 'b/p/materials/deck/m1/final/a1',
);

// ----------------------------------------------------------- 4. сигналы
console.log('\n▸ 4. Повтор недоставленного сигнала');
mkdirSync(join(dir, 'state'), { recursive: true });
let sent = [];
let online = false;
const send = async (text) => {
  sent.push(text);
  return online;
};
const t0 = Date.parse('2026-10-31T00:00:00Z');
const min = 60_000;
let e = await lib.signal('x', true, 'сбой', { send, now: t0 });
check(
  'первая отправка неуспешна — сообщение в очереди',
  sent.length === 1 && e.pending && !e.notified,
);
await lib.signal('x', true, 'сбой', { send, now: t0 + 5 * min });
check('через 5 минут не повторяет (частота ограничена)', sent.length === 1);
online = true;
e = await lib.signal('x', true, 'сбой', { send, now: t0 + 16 * min });
check('через 15+ минут повторяет и доставляет', sent.length === 2 && e.notified && !e.pending);
await lib.signal('x', true, 'сбой', { send, now: t0 + 40 * min });
check('после доставки той же неисправностью не засыпает', sent.length === 2);
online = false;
e = await lib.signal('x', false, 'норма', { send, now: t0 + 50 * min });
check(
  '«восстановилось» не доставлено — в очереди',
  sent.length === 3 && e.pending?.includes('восстановилось'),
);
online = true;
e = await lib.signal('x', false, 'норма', { send, now: t0 + 66 * min });
check('«восстановилось» повторено и доставлено', sent.length === 4 && e.notified && !e.pending);
sent = [];
await lib.signal('x', false, 'норма', { send, now: t0 + 120 * min });
check('дальше в норме — тишина', sent.length === 0);

rmSync(dir, { recursive: true, force: true });
console.log(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===`);
process.exit(failed ? 1 : 0);
