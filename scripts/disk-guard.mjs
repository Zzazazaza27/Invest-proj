#!/usr/bin/env node
/**
 * Служба хоста «место на диске» (работа № 4 раздела 01; 06 Load «Место на диске», 6.4).
 *
 * Раз в минуту (таймер `fifth-disk-guard`) измеряет занятость файловой системы с данными и
 * сообщает её базе каждой среды узла (`availability.report_disk_usage`, M181):
 *   * занято ≥ 85 % или прогноз исчерпания < 24 ч — «Файлы» только чтение: новые загрузки
 *     не выдаются, чтение остаётся; ниже 80 % — ограничение снимается само;
 *   * пользовательские данные не удаляются; чистка истории этим не разрешается.
 * Предупреждение 70 % и критическое 85 % видит Zabbix (vfs.fs.size и файл состояния ниже).
 *
 *   node scripts/disk-guard.mjs [--path /] [--container <имя>] [--targets auto|prod,test-1,…]
 *
 *   --path        что измерять (по умолчанию «/» — корневой диск узла, на нём данные Garage
 *                 и PostgreSQL);
 *   --container   измерить внутри контейнера (`df` там) — для изолированных испытаний;
 *   --targets     базы: `prod` (fifth-postgres, адрес владельца из /run/fifth-secrets),
 *                 `<среда>` (.local/envs/<среда>), `local` (стенд разработчика),
 *                 `pg=<контейнер>:<роль>` (явно, вход по сокету — испытания); `auto` — prod,
 *                 если есть его адрес, и все среды узла с запущенной базой.
 *
 * Состояние для Zabbix — MONITOR_STATE_DIR/disk-guard.json; там же образцы для прогноза.
 * Значений секретов не печатает. Код выхода 1 — хоть одна база не получила отчёт.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseEnvFile } from './lib/backup.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SET_PCT = 85;
const CLEAR_PCT = 80;
const WARN_PCT = 70;
const PROD_URL_FILE = '/run/fifth-secrets/DATABASE_URL_OWNER';
/** Окно образцов прогноза и минимальный размах для него. */
const SAMPLES_WINDOW_MS = 6 * 3600_000;
const MIN_SPAN_MS = 30 * 60_000;
const MIN_SAMPLES = 5;

// Разбор аргументов — только при запуске командой: модуль импортируют проверки (прогноз).
let opt;
let stateDir;
function configure() {
  ({ values: opt } = parseArgs({
    options: {
      path: { type: 'string', default: '/' },
      container: { type: 'string' },
      targets: { type: 'string', default: 'auto' },
      'state-dir': { type: 'string' },
    },
  }));
  const env = { ...parseEnvFile(join(ROOT, '.env'), { secrets: false }), ...process.env };
  stateDir = resolve(
    opt['state-dir'] || env.MONITOR_STATE_DIR || join(ROOT, '.local', 'monitor-state'),
  );
  mkdirSync(stateDir, { recursive: true });
}

const run = (cmd, args, extra = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, ...extra });

/** Занятость: байты всего и занятые (как df: занятое / (занятое + доступное непривилегированным)). */
export function measure(path, container) {
  if (container) {
    const r = run('docker', ['exec', container, 'df', '-P', '-k', path]);
    if (r.status !== 0) throw new Error(`df в ${container}: ${(r.stderr || '').trim()}`);
    const cols = r.stdout.trim().split('\n').at(-1).split(/\s+/);
    const used = Number(cols[2]) * 1024;
    const avail = Number(cols[3]) * 1024;
    return { used, avail };
  }
  const s = statfsSync(path);
  const used = (s.blocks - s.bfree) * s.bsize;
  const avail = s.bavail * s.bsize;
  return { used, avail };
}

/**
 * Прогноз исчерпания, часов: наклон занятого по образцам окна (наименьшие квадраты). Мало
 * образцов, короткий размах или место не растёт — прогноза нет (`null`), а не «бесконечность».
 */
export function forecastHours(samples, avail) {
  if (samples.length < MIN_SAMPLES) return null;
  const t0 = samples[0].t;
  if (samples.at(-1).t - t0 < MIN_SPAN_MS) return null;
  const xs = samples.map((s) => (s.t - t0) / 3600_000);
  const ys = samples.map((s) => s.used);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const perHour = den > 0 ? num / den : 0;
  if (perHour <= 0) return null;
  return Math.round((avail / perHour) * 10) / 10;
}

function resolveTargets(spec) {
  if (spec !== 'auto')
    return spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const out = [];
  if (existsSync(PROD_URL_FILE)) out.push('prod');
  const envsDir = join(ROOT, '.local', 'envs');
  if (existsSync(envsDir)) {
    for (const id of readdirSync(envsDir)) {
      if (!existsSync(join(envsDir, id, 'secrets', 'POSTGRES_PASSWORD'))) continue;
      const r = run('docker', ['inspect', '-f', '{{.State.Running}}', `fifth-${id}-postgres`]);
      if (r.stdout.trim() === 'true') out.push(id);
    }
  }
  return out;
}

/** Вызов функции базы цели; значения секретов — только через переменные окружения docker exec. */
function report(target, sql) {
  let args;
  let childEnv = process.env;
  if (target === 'prod') {
    const url = readFileSync(PROD_URL_FILE, 'utf8')
      .trim()
      .replace(/@[^/]*\//, '@127.0.0.1:5432/');
    childEnv = { ...process.env, URL: url };
    args = [
      'exec',
      '-i',
      '-e',
      'URL',
      'fifth-postgres',
      'sh',
      '-c',
      'psql "$URL" -X -At -v ON_ERROR_STOP=1',
    ];
  } else if (target === 'local') {
    args = [
      'exec',
      '-i',
      'fifth-postgres',
      'psql',
      '-X',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'unicorn_owner',
      '-d',
      'fifth_element',
    ];
  } else if (target.startsWith('pg=')) {
    const [container, role] = target.slice(3).split(':');
    args = [
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      role,
      '-d',
      'fifth_element',
    ];
  } else {
    if (!/^[a-z0-9-]{1,40}$/.test(target)) throw new Error(`неизвестная цель ${target}`);
    // пароль читается из файла среды, литерала нет.
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
    const pw = readFileSync(
      join(ROOT, '.local', 'envs', target, 'secrets', 'POSTGRES_PASSWORD'),
      'utf8',
    ).trim();
    childEnv = { ...process.env, PGPASSWORD: pw };
    args = [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      `fifth-${target}-postgres`,
      'psql',
      '-X',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-U',
      'fifth_owner',
      '-d',
      'fifth_element',
    ];
  }
  const r = run('docker', args, { input: sql, env: childEnv });
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n')[0] || `код ${r.status}`);
  return (
    r.stdout
      .trim()
      .split('\n')
      .filter((l) => /^(set|kept|cleared|none)$/.test(l))[0] ?? '?'
  );
}

async function main() {
  configure();
  const { used, avail } = measure(opt.path, opt.container);
  const usedPct = Math.round((used / (used + avail)) * 10000) / 100;
  const key = `${opt.container ?? 'host'}:${opt.path}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  const samplesFile = join(stateDir, `disk-guard-samples-${key}.json`);
  let samples;
  try {
    samples = JSON.parse(readFileSync(samplesFile, 'utf8'));
  } catch {
    samples = [];
  }
  const now = Date.now();
  samples = [
    ...samples.filter((s) => now - s.t < SAMPLES_WINDOW_MS && s.t < now),
    { t: now, used },
  ];
  writeFileSync(`${samplesFile}.tmp`, JSON.stringify(samples));
  renameSync(`${samplesFile}.tmp`, samplesFile);
  const forecast = forecastHours(samples, avail);

  const trace = `disk-guard-${now}`;
  const sql =
    `SELECT availability.report_disk_usage(${usedPct}, ${quote(opt.path)}, ` +
    `${forecast === null ? 'NULL' : forecast}, ${quote(trace)}, ${SET_PCT}, ${CLEAR_PCT});\n`;
  const targets = {};
  let errors = 0;
  for (const t of resolveTargets(opt.targets)) {
    try {
      targets[t] = report(t, sql);
    } catch (e) {
      errors++;
      targets[t] = 'error';
      console.error(`${t}: отчёт не принят — ${String(e.message).slice(0, 200)}`);
    }
  }
  const critical = usedPct >= SET_PCT || (forecast !== null && forecast < 24);
  const state = {
    ts: Math.floor(now / 1000),
    path: opt.path,
    usedPct,
    level: critical ? 'critical' : usedPct >= WARN_PCT ? 'warning' : 'ok',
    forecastHours: forecast,
    targets,
    errors,
  };
  const file = join(stateDir, 'disk-guard.json');
  writeFileSync(`${file}.tmp`, JSON.stringify(state));
  renameSync(`${file}.tmp`, file);
  console.log(JSON.stringify(state));
  if (errors) process.exitCode = 1;
}

function quote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
