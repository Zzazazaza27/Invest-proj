#!/usr/bin/env node
/**
 * Прогон совместимости в CI с подписью отчёта (блок 09, задание 2; способ согласован Тэнком
 * 09.11). Вызывается из .github/workflows/compat.yml — ручной процесс владельца, без выкладки.
 *
 *   node scripts/ci-compat.mjs --previous <сборка> --candidate <сборка> --out <каталог>
 *                              [--sign-key-file <pem>] [--plan]
 *
 *  1. Хранилище для временной среды: одноразовые ключи (garage-init --secrets-draft),
 *     три узла Garage, раскладка и бакеты. Только в CI (переменная CI) — на стенде своё.
 *  2. Оба комплекта — готовые артефакты CI (kit-<сборка>): находятся по имени, скачиваются
 *     `kit.mjs fetch` (образы по дайджесту), сверяются `kit.mjs check`. Без пересборки.
 *  3. scripts/check-migration-compat.mjs; подпись — только при `ok` и только если ключ
 *     передан (ключ есть лишь у доверенного процесса с защищённой ветки).
 *  4. В --out: compat-<прежняя>.json и, при подписи, compat-<прежняя>.json.sig —
 *     процесс выкладывает их отдельными артефактами.
 *
 * --plan — только найти запуски CI с комплектами и показать план, ничего не делая.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KITS = process.env.FIFTH_KITS_DIR || join(ROOT, '.local', 'kits');
const opt = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const PREVIOUS = opt('--previous');
const CANDIDATE = opt('--candidate');
const OUT = opt('--out');
const KEY = opt('--sign-key-file');
const BUILD = /^\d+\.\d+-b\d+\.\d+$/;
if (!BUILD.test(PREVIOUS ?? '') || !BUILD.test(CANDIDATE ?? '') || !OUT) {
  console.error('нужны --previous <сборка> --candidate <сборка> --out <каталог>');
  process.exit(2);
}
const step = (title) => console.log(`\n▸ ${title}`);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.capture ? 'pipe' : 'inherit',
    timeout: 3_600_000,
    env: { ...process.env, ...opts.env },
  });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(
      `${cmd} ${args.slice(0, 3).join(' ')}: код ${r.status}${opts.capture ? ` — ${r.stderr.trim().slice(-300)}` : ''}`,
    );
  }
  return r;
};

/** Запуск CI, в котором выложен комплект сборки: по имени артефакта, без угадывания. */
function runOf(build) {
  const r = run(
    'gh',
    [
      'api',
      `repos/{owner}/{repo}/actions/artifacts?name=kit-${build}&per_page=5`,
      '--jq',
      '[.artifacts[] | select(.expired == false)][0].workflow_run.id',
    ],
    { capture: true },
  );
  const id = r.stdout.trim();
  if (!/^\d+$/.test(id))
    throw new Error(`комплекта kit-${build} нет среди действующих артефактов CI`);
  return id;
}

let runs;
try {
  runs = { [PREVIOUS]: runOf(PREVIOUS), [CANDIDATE]: runOf(CANDIDATE) };
} catch (e) {
  console.error(`ci-compat: ${e.message}`);
  process.exit(2);
}
console.log(
  `комплекты: ${PREVIOUS} — запуск ${runs[PREVIOUS]}, ${CANDIDATE} — запуск ${runs[CANDIDATE]}`,
);
if (process.argv.includes('--plan')) process.exit(0);

// 1. Хранилище — только в CI: на стенде Garage уже свой.
if (process.env.CI) {
  step('Хранилище для временной среды (одноразовые ключи)');
  const draft = join(tmpdir(), `ci-compat-${process.pid}`);
  run(process.execPath, ['scripts/garage-init.mjs', '--secrets-draft', draft]);
  // Порт S3 — как на стенде (9000): прогон кладёт файлы по этому адресу.
  // GARAGE_S3_PORT в черновиках дважды (3900 и 9000): Compose берёт последнее значение, а
  // scripts/lib/ports.mjs — первое. Оставляем одно, иначе init стучится не в тот порт.
  const drafts = ['pre', 'window']
    .map((p) => readFileSync(`${draft}-${p}.env`, 'utf8'))
    .join('\n')
    .replace(/^GARAGE_S3_PORT=.*\n?/gm, '');
  const env = `${drafts}\nGARAGE_S3_PORT=9000\nS3_BUCKET=fifth-ci\n`;
  writeFileSync(join(ROOT, '.env'), env, { mode: 0o600 });
  run('docker', [
    'compose',
    '-f',
    'infra/docker-compose.yml',
    '--env-file',
    '.env',
    'up',
    '-d',
    '--wait',
    'garage-1',
    'garage-2',
    'garage-3',
  ]);
  run(process.execPath, ['scripts/garage-init.mjs']);
}

// 2. Комплекты — готовые, по дайджестам, со сверкой.
for (const build of [PREVIOUS, CANDIDATE]) {
  step(`Комплект ${build}`);
  if (!existsSync(join(KITS, build, 'kit.json'))) {
    run(process.execPath, ['scripts/kit.mjs', 'fetch', '--build', build, '--run', runs[build]]);
  }
  run(process.execPath, ['scripts/kit.mjs', 'check', '--build', build]);
}

// 3. Прогон; подпись — только при ok (это решает сам прогон).
step('Прогон совместимости');
const compat = run(
  process.execPath,
  [
    'scripts/check-migration-compat.mjs',
    '--previous',
    PREVIOUS,
    '--candidate',
    CANDIDATE,
    ...(KEY ? ['--sign-key-file', KEY] : []),
  ],
  { allowFail: true },
);

// 4. Отчёт и подпись — отдельными файлами для отдельных артефактов.
mkdirSync(OUT, { recursive: true });
const report = join(KITS, CANDIDATE, `compat-${PREVIOUS}.json`);
if (!existsSync(report)) throw new Error('отчёт не создан');
copyFileSync(report, join(OUT, `compat-${PREVIOUS}.json`));
if (existsSync(`${report}.sig`))
  copyFileSync(`${report}.sig`, join(OUT, `compat-${PREVIOUS}.json.sig`));
const result = JSON.parse(readFileSync(report, 'utf8')).result;
console.log(
  `\nитог: ${result}${existsSync(`${report}.sig`) ? ', отчёт подписан' : ', без подписи'}`,
);
process.exit(compat.status === 0 && result === 'ok' ? 0 : 1);
