#!/usr/bin/env node
/**
 * Суммы входов образов выпуска для CI (Тэнк 13.11: web и postgres не пересоздаются без
 * изменения состава).
 *
 *   node scripts/image-inputs.mjs postgres [--period YYYY-MM] [--platform linux/amd64]
 *       сумма входов сборки образа базы: весь контекст infra/postgres (Dockerfile и файлы),
 *       платформа, значимые параметры сборки (метка источника) и месячный период. По ней CI
 *       ищет готовый образ в реестре и не собирает заново. Период меняется раз в месяц — первая
 *       разрешённая сборка месяца собирает образ заново (свежие пакеты), без отдельного запуска.
 *   node scripts/image-inputs.mjs web-runtime
 *       сумма серверной части web (scripts/lib/web-runtime.mjs) — метка образа fifth.web.runtime.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webRuntimeSum } from './lib/web-runtime.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);

/** Значимые параметры сборки образа базы — те же, что в шаге CI. */
export const POSTGRES_BUILD = {
  context: 'infra/postgres',
  labels: ['org.opencontainers.image.source=https://github.com/rebel-diesel/fifth-element'],
  buildArgs: [],
};

function files(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
}

export function postgresInputs({ root = ROOT, period, platform }) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('период: YYYY-MM');
  const h = createHash('sha256');
  h.update(`fifth-postgres-inputs/1\nplatform ${platform}\nperiod ${period}\n`);
  for (const l of POSTGRES_BUILD.labels) h.update(`label ${l}\n`);
  for (const a of POSTGRES_BUILD.buildArgs) h.update(`arg ${a}\n`);
  const ctx = join(root, POSTGRES_BUILD.context);
  for (const f of files(ctx)) {
    const st = statSync(f);
    // Права входят: исполняемость файла попадает в образ.
    h.update(
      `file ${relative(ctx, f).replace(/\\/g, '/')} ${(st.mode & 0o111) !== 0 ? 'x' : '-'}\n`,
    );
    h.update(readFileSync(f));
    h.update('\n');
  }
  return h.digest('hex');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = argv[0];
  if (cmd === 'postgres') {
    const period = flag('--period', new Date().toISOString().slice(0, 7));
    console.log(postgresInputs({ period, platform: flag('--platform', 'linux/amd64') }));
  } else if (cmd === 'web-runtime') {
    console.log(webRuntimeSum(ROOT));
  } else {
    console.error('команды: postgres, web-runtime');
    process.exit(2);
  }
}
