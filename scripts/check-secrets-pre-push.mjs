#!/usr/bin/env node
/**
 * Скан секретов перед push (решение Томаса 10.11.2026): та же проверка, что workflow
 * «Секреты» (gitleaks, тот же образ по дайджесту и .gitleaks.toml), но на машине
 * разработчика и до отправки — без минут GitHub Actions. На GitHub скан остался раз в
 * неделю и вручную.
 *
 *   printf '%s\n' "$refs" | node scripts/check-secrets-pre-push.mjs
 *
 * Сканирует только уходящие коммиты: для каждой строки ввода хука pre-push
 * (`<local ref> <local sha> <remote ref> <remote sha>`) — диапазон remote..local; новая
 * ветка — коммиты, которых нет в origin/main. Удаление ветки не сканируется.
 * Нет Docker — отправка остановлена: без скана секреты не проверены (обойти —
 * `git push --no-verify`, осознанно).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE =
  'zricethezav/gitleaks@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854';
const ZERO = /^0+$/;

const input = (() => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
})();
const ranges = [];
for (const line of input.split('\n')) {
  const [, local, , remote] = line.trim().split(/\s+/);
  if (!local || ZERO.test(local)) continue; // удаление ветки
  ranges.push(remote && !ZERO.test(remote) ? `${remote}..${local}` : `${local} --not origin/main`);
}
if (!ranges.length) process.exit(0);

const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
  encoding: 'utf8',
  timeout: 30_000,
});
if (docker.status !== 0) {
  console.error('pre-push: Docker не отвечает — скан секретов не выполнен, отправка остановлена.');
  console.error('Подними Docker и повтори push (обойти осознанно: git push --no-verify).');
  process.exit(1);
}

let failed = false;
for (const range of ranges) {
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--pull',
      'missing',
      '--entrypoint',
      'sh',
      '-v',
      `${ROOT}:/repo:ro`,
      IMAGE,
      '-c',
      // Владелец смонтированного репозитория другой — git внутри образа без safe.directory
      // откажется читать историю.
      'git config --global --add safe.directory /repo && ' +
        'gitleaks git --config=/repo/.gitleaks.toml --no-banner --redact --exit-code 1 ' +
        `--log-opts="${range}" /repo`,
    ],
    { encoding: 'utf8', timeout: 300_000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status === 0) {
    console.log(`  секреты: чисто (${range.split(' ')[0]})`);
  } else {
    failed = true;
    console.error(out.split('\n').slice(-40).join('\n'));
    console.error(`pre-push: ОСТАНОВЛЕНО — скан секретов (${range}), код ${r.status}.`);
  }
}
process.exit(failed ? 1 : 0);
