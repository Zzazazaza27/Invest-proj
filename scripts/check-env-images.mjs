#!/usr/bin/env node
/**
 * Подмена образов: в окружении процесса стоят образы рабочей среды, а тестовая среда получает
 * образы своего комплекта.
 *
 *   node scripts/check-env-images.mjs
 *
 * Контейнеры не запускаются: Compose только разбирает конфигурацию среды во временном каталоге.
 * Контрольный прямой вызов Compose обязан показать подмену, иначе проверка ничего не доказывает.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'test-73';
const OWN = '9.9-b2.1';
const PROD = '9.9-b1.1';
const envs = mkdtempSync(join(tmpdir(), 'fifth-env-images-'));
const dir = join(envs, ID);

let failed = 0;
const check = (name, ok, details = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};
const fifth = (images) => images.filter((i) => i.startsWith('fifth/')).sort();
const own = ['core', 'postgres', 'web'].map((name) => `fifth/${name}:${OWN}`);

mkdirSync(dir, { recursive: true });
try {
  copyFileSync(join(ROOT, 'infra', 'docker-compose.env.yml'), join(dir, 'compose.yml'));
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ env: ID }));
  writeFileSync(join(dir, 'settings.env'), '');
  writeFileSync(
    join(dir, 'compose.env'),
    [
      `FIFTH_PROJECT=fifth-${ID}`,
      `FIFTH_ENV_DIR=${dir.replace(/\\/g, '/')}`,
      `FIFTH_CORE_IMAGE=fifth/core:${OWN}`,
      `FIFTH_WEB_IMAGE=fifth/web:${OWN}`,
      `FIFTH_POSTGRES_IMAGE=fifth/postgres:${OWN}`,
      'FIFTH_WEB_PORT=18973',
      'FIFTH_KEYCLOAK_DB_PASSWORD=x',
      'FIFTH_STORAGE_NETWORK=fifth_default',
      '',
    ].join('\n'),
  );
  const env = {
    ...process.env,
    MSYS_NO_PATHCONV: '1',
    FIFTH_ENVS_DIR: envs,
    FIFTH_CORE_IMAGE: `fifth/core:${PROD}`,
    FIFTH_WEB_IMAGE: `fifth/web:${PROD}`,
    FIFTH_POSTGRES_IMAGE: `fifth/postgres:${PROD}`,
  };

  const direct = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      join(dir, 'compose.env'),
      '-f',
      join(dir, 'compose.yml'),
      'config',
      '--images',
    ],
    { encoding: 'utf8', env },
  );
  const leaked = fifth(direct.stdout.trim().split('\n'));
  check(
    'контроль: без защиты Compose берёт образы из окружения',
    leaked.includes(`fifth/core:${PROD}`),
    leaked.join(' '),
  );

  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'env.mjs'), 'images', ID], {
    encoding: 'utf8',
    env,
  });
  check('env.mjs разобрал конфигурацию среды', run.status === 0, run.stderr.slice(-200));
  const got = fifth(JSON.parse(run.stdout.trim().split('\n').pop()).images ?? []);
  check(
    'все образы — из комплекта среды',
    own.every((image) => got.includes(image)),
    got.join(' '),
  );
  check('образов рабочей среды нет', !got.some((image) => image.endsWith(`:${PROD}`)));
} catch (error) {
  check('проверка оборвана', false, error.message);
} finally {
  rmSync(envs, { recursive: true, force: true });
}
console.log(failed ? `=== ОТКАЗОВ: ${failed} ===` : '=== ОБРАЗЫ СВОИ ===');
process.exit(failed ? 1 : 0);
