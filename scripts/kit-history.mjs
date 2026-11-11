#!/usr/bin/env node
/**
 * Закреплённые дополнения Compose выпущенных сборок без поля `overlays` в манифесте (Тэнк 11.11:
 * исторический комплект не пересобирается и его манифест не переписывается; для перехода нужны
 * отдельно закреплённые дополнения с проверяемым происхождением).
 *
 *   node scripts/kit-history.mjs pin --build <сборка> --commit <коммит сборки>
 *   node scripts/kit-history.mjs check
 *
 * pin — копии дополнений из `git show <коммит>:<путь>` в infra/kit-history/<сборка>/ и manifest.json
 * (коммит, суммы, отсутствующие на том коммите). check — каждая копия совпадает и с манифестом, и с
 * Git на заявленном коммите; копий сверх манифеста нет. Код: 0 — сходится, 1 — расхождение.
 * Связь с комплектом (коммит манифеста комплекта = коммит истории) проверяет lib/overlays.mjs.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OVERLAYS } from './lib/overlays.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY = join(ROOT, 'infra', 'kit-history');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Файл на коммите или null, если его там не было. */
function gitShow(commit, path) {
  try {
    return execFileSync('git', ['show', `${commit}:${path}`], {
      cwd: ROOT,
      maxBuffer: 1 << 24,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function pin() {
  const build = flag('--build');
  const commit = flag('--commit');
  if (!/^\d+\.\d+-b\d+\.\d+$/.test(build ?? '') || !/^[0-9a-f]{7,40}$/.test(commit ?? '')) {
    console.error('нужны --build <сборка> и --commit <коммит>');
    process.exit(2);
  }
  const full = execFileSync('git', ['rev-parse', commit], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dir = join(HISTORY, build);
  if (existsSync(join(dir, 'manifest.json'))) {
    console.error(`история ${build} уже закреплена — не переписывается`);
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  const files = {};
  const absent = [];
  for (const path of Object.values(OVERLAYS)) {
    const text = gitShow(full, path);
    if (!text) {
      absent.push(path);
      continue;
    }
    writeFileSync(join(dir, basename(path)), text);
    files[path] = sha256(text);
  }
  const manifest = { format: 1, build, commit: full, files, absent };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, build, commit: full, files: Object.keys(files), absent }));
}

function check() {
  const problems = [];
  let builds = 0;
  for (const build of existsSync(HISTORY) ? readdirSync(HISTORY) : []) {
    const dir = join(HISTORY, build);
    const mf = join(dir, 'manifest.json');
    if (!existsSync(mf)) {
      problems.push(`${build}: нет manifest.json`);
      continue;
    }
    builds += 1;
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    if (m.build !== build) problems.push(`${build}: манифест от сборки ${m.build}`);
    const expected = new Set(['manifest.json']);
    for (const [path, sum] of Object.entries(m.files ?? {})) {
      const name = basename(path);
      expected.add(name);
      const local = join(dir, name);
      if (!existsSync(local)) problems.push(`${build}/${name}: нет копии`);
      else if (sha256(readFileSync(local)) !== sum)
        problems.push(`${build}/${name}: копия ≠ манифест`);
      const atCommit = gitShow(m.commit, path);
      if (!atCommit) problems.push(`${build}/${name}: нет в Git на ${m.commit.slice(0, 7)}`);
      else if (sha256(atCommit) !== sum)
        problems.push(`${build}/${name}: манифест ≠ Git на коммите`);
    }
    for (const path of m.absent ?? []) {
      if (gitShow(m.commit, path))
        problems.push(`${build}: ${path} есть на коммите, а записан отсутствующим`);
    }
    for (const f of readdirSync(dir)) {
      if (!expected.has(f)) problems.push(`${build}/${f}: лишний файл`);
    }
  }
  for (const p of problems) console.log(`  FAIL  ${p}`);
  console.log(`\nсборок: ${builds}, расхождений: ${problems.length}`);
  process.exit(problems.length ? 1 : 0);
}

const command = argv[0];
if (command === 'pin') pin();
else if (command === 'check') check();
else {
  console.error('команды: pin, check');
  process.exit(2);
}
