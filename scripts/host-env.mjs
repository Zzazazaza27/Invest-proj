#!/usr/bin/env node
/**
 * Окружение узла: опись, сверка, архив окружения (пакет «окружение узла», Тэнк 15.11).
 *
 *   node scripts/host-env.mjs inventory --set <скачанная копия> [--write <файл>]
 *       опись по записи узла в копии: состав и неполные сведения; с --write — черновик описания
 *       (status: draft). Ничего не утверждает: утверждение — правка status владельцем.
 *   node scripts/host-env.mjs check [--env <описание>] (--set <копия> | --live) [--holds]
 *        [--from-archive <id>] [--json]
 *       сверка описания с фактами; итог ok / differ / unverified, код 0 / 1 / 3. Ничего не чинит.
 *   node scripts/host-env.mjs archive build --env <описание> --out <каталог> [--sign-key <pem>]
 *   node scripts/host-env.mjs archive verify <архив.tar> [--pub <pem>]
 *       архив окружения — см. scripts/lib/host-env-archive.mjs.
 *
 * Описание по умолчанию — infra/host/environment.json.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareEnvironment,
  factsOfHost,
  inventoryOfHost,
  loadEnvironment,
  summarize,
} from './lib/host-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ENV = join(ROOT, 'infra/host/environment.json');
const argv = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(name);

/** Запись узла из скачанной копии: последний готовый набор. */
export function hostOfSet(dir) {
  const sets = join(dir, 'sets');
  const id = readdirSync(sets)
    .filter((d) => existsSync(join(sets, d, 'READY')))
    .sort()
    .pop();
  if (!id) throw new Error(`в ${dir} нет готового набора`);
  const catalog = JSON.parse(readFileSync(join(sets, id, 'catalog.json'), 'utf8'));
  const hostFile = join(dir, catalog.host.file);
  const host = JSON.parse(readFileSync(hostFile, 'utf8'));
  return { id, catalog, host, filesDir: join(dirname(hostFile), 'files') };
}

/** Отпечаток ключа репозитория (gpg --show-keys); не удалось — null. */
function fingerprintOf(file) {
  const r = spawnSync('gpg', ['--batch', '--with-colons', '--show-keys', file], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const fpr = r.stdout
    .split('\n')
    .filter((l) => l.startsWith('fpr:'))
    .map((l) => l.split(':')[9]);
  return fpr.length ? fpr[0] : null;
}

function inventory() {
  const dir = resolve(opt('--set') ?? '');
  const { id, host, filesDir } = hostOfSet(dir);
  const files = {};
  const fingerprints = {};
  const collect = (p) => {
    const local = join(filesDir, p);
    if (!existsSync(local)) return;
    try {
      for (const f of readdirSync(local)) collect(`${p}/${f}`);
    } catch {
      files[p] = readFileSync(local, 'utf8');
    }
  };
  collect('/etc/apt/sources.list.d');
  const { env: draft0 } = inventoryOfHost(host, { id: 'hostenv-draft', files });
  for (const s of draft0.sources)
    if (s.keyFile && existsSync(join(filesDir, s.keyFile)))
      fingerprints[s.keyFile] = fingerprintOf(join(filesDir, s.keyFile));
  const envId = `hostenv-${id.slice(0, 8)}-1`;
  const { env, gaps } = inventoryOfHost(host, { id: envId, files, fingerprints });
  const f = factsOfHost(host);

  console.log(`опись окружения по копии ${id} (запись узла ${host.capturedAt})`);
  console.log(`  ОС: ${env.os.id} ${env.os.versionId}, архитектура: ${env.os.arch ?? '—'}`);
  console.log(`  ядро (не сравнивается): ${host.kernel ?? '—'}`);
  for (const s of env.sources)
    console.log(
      `  источник ${s.name}: ${s.uri ?? '—'} ${s.suite ?? ''}; ключ ${s.keyFile ?? '—'} ${s.keyFingerprint ?? ''}`,
    );
  for (const c of env.components)
    for (const [n, v] of Object.entries(c.packages))
      console.log(`  ${c.name} [${c.match}]: ${n} ${v ?? '— не определено'}`);
  console.log(`  полный список пакетов в записи: ${f.complete ? 'есть' : 'нет (запись до 15.11)'}`);
  console.log(`  закрепления (apt-mark): ${f.holds ? f.holds.join(', ') || 'нет' : 'не записаны'}`);
  const extra = Object.keys(files).filter(
    (p) => !env.sources.some((s) => s.file === p) && !/ubuntu\.sources|\.orig$|\.save$/.test(p),
  );
  if (extra.length)
    console.log(`  прочие источники на узле (не управляются описанием): ${extra.join(', ')}`);
  console.log(`\nнеполные сведения (${gaps.length}):`);
  for (const g of gaps) console.log(`  · ${g}`);
  if (opt('--write')) {
    writeFileSync(resolve(opt('--write')), `${JSON.stringify(env, null, 2)}\n`);
    console.log(`\nчерновик описания: ${opt('--write')} (status: draft)`);
  }
}

async function check() {
  const { env, problems } = loadEnvironment(resolve(opt('--env', DEFAULT_ENV)));
  if (problems.length) {
    console.error(`описание не принято: ${problems.join('; ')}`);
    process.exit(2);
  }
  let facts;
  if (flag('--live')) {
    const { liveHostFacts } = await import('./lib/host-config.mjs');
    facts = factsOfHost(liveHostFacts(env.components.flatMap((c) => Object.keys(c.packages))));
  } else facts = factsOfHost(hostOfSet(resolve(opt('--set') ?? '')).host);
  const rows = compareEnvironment(env, facts, {
    holds: flag('--holds'),
    archive: opt('--from-archive'),
  });
  const sum = summarize(rows);
  if (flag('--json'))
    console.log(JSON.stringify({ env: env.id, status: env.status, ...sum, rows }));
  else {
    const mark = { ok: 'OK  ', differ: 'РАЗН', missing: 'НЕТ ', unverified: '??  ' };
    console.log(`сверка окружения с ${env.id} (${env.status})`);
    for (const r of rows)
      console.log(
        `  ${mark[r.state]}  ${r.subject}: ожидается ${r.want ?? '—'}, есть ${r.have ?? '—'} (${r.rule})`,
      );
    const word = { ok: 'совпадает', differ: 'РАСХОДИТСЯ', unverified: 'НЕ ПРОВЕРЕНО' }[sum.verdict];
    console.log(
      `=== ${word}: ok ${sum.count.ok}, расхождений ${sum.count.differ}, нет ${sum.count.missing}, не проверено ${sum.count.unverified} ===`,
    );
  }
  process.exit({ ok: 0, differ: 1, unverified: 3 }[sum.verdict]);
}

async function archive() {
  const { buildArchive, verifyArchive } = await import('./lib/host-env-archive.mjs');
  const sub = argv[1];
  if (sub === 'build') {
    const r = buildArchive({
      envFile: resolve(opt('--env', DEFAULT_ENV)),
      outDir: resolve(opt('--out') ?? ''),
      signKey: opt('--sign-key') ? readFileSync(resolve(opt('--sign-key')), 'utf8') : null,
    });
    console.log(JSON.stringify(r, null, 2));
  } else if (sub === 'verify') {
    const r = verifyArchive(resolve(argv[2] ?? ''), {
      publicPem: opt('--pub') ? readFileSync(resolve(opt('--pub')), 'utf8') : null,
    });
    for (const c of r.checks)
      console.log(`  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}${c.ok ? '' : ` — ${c.details}`}`);
    process.exit(r.ok ? 0 : 1);
  } else throw new Error('archive build | verify');
}

const commands = { inventory, check, archive };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = commands[argv[0]];
  if (!cmd) {
    console.error('команды: inventory, check, archive');
    process.exit(2);
  }
  Promise.resolve(cmd()).catch((e) => {
    console.error(`host-env: ${e.message}`);
    process.exit(2);
  });
}
