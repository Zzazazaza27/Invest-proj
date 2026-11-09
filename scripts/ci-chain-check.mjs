#!/usr/bin/env node
/**
 * Цепочка SSH на настоящем узле до выдачи рабочего доступа CI. Запускает Томас из папки проекта.
 *
 *   node scripts/ci-chain-check.mjs --commit <sha> --run <запуск CI комплекта> --build <текущая сборка>
 *
 * Ставит установщик с одноразовыми ключами и шлёт только запросы, которые обязаны получить отказ:
 * рабочая среда не меняется. Запрос на текущую сборку доходит до класса операций, поэтому
 * подтверждает sudo, обёртку, копию инструментов, реестр и закреплённые файлы запуска. В конце
 * ключ входа снимается, одноразовые ключи уничтожаются. Значения не печатаются.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { signKit } from './lib/kit-sign.mjs';

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
};
const commit = option('--commit');
const run = option('--run');
const build = option('--build');
if (!commit || !run || !build) {
  console.error('нужны --commit, --run, --build');
  process.exit(2);
}
const HOST = '193.233.217.210';
const MAUS = join(homedir(), '.ssh', 'maus_5e');
const WORK = resolve('.local', 'ci-chain');
const say = (line) => console.log(line);
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  say(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`);
};
const b64 = (text) => Buffer.from(text).toString('base64');
const maus = (command) =>
  spawnSync(
    'ssh',
    ['-i', MAUS, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', `maus@${HOST}`, command],
    { encoding: 'utf8' },
  );
const setup = (sign, ssh = '') =>
  maus(`sudo -n /usr/local/sbin/fifth-test op prod-install-setup ${sign} ${ssh}`);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
let signPub = '';
try {
  const art = join(WORK, 'kit');
  const got = spawnSync('gh', ['run', 'download', run, '-n', `kit-${build}`, '--dir', art], {
    encoding: 'utf8',
  });
  if (got.status !== 0) throw new Error(`комплект не скачан: ${got.stderr.trim()}`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signing = privateKey.export({ type: 'pkcs8', format: 'pem' });
  signPub = b64(publicKey.export({ type: 'spki', format: 'pem' }));
  const key = join(WORK, 'ci');
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);

  say('▸ Установка с одноразовыми ключами');
  const sync = maus(`sudo -n /usr/local/sbin/fifth-test sync ${commit}`);
  check('код на узле', sync.status === 0, sync.stderr);
  const installed = setup(signPub, b64(readFileSync(`${key}.pub`, 'utf8')));
  check(
    'установка',
    installed.status === 0,
    `${installed.stdout}${installed.stderr}`.trim().slice(-200),
  );

  const request = (expect, signature) => {
    const bytes = readFileSync(join(art, 'kit.json'));
    const files = {
      'kit.json': bytes.toString('base64'),
      'compose.yml': readFileSync(join(art, 'compose.yml')).toString('base64'),
    };
    for (const name of readdirSync(join(art, 'prod-compose'))) {
      files[`prod-compose/${name}`] = readFileSync(join(art, 'prod-compose', name)).toString(
        'base64',
      );
    }
    const kit = JSON.parse(bytes.toString('utf8'));
    for (const name of Object.keys(kit.sbom?.files ?? {})) {
      files[`sbom/${name}`] = readFileSync(join(art, 'sbom', name)).toString('base64');
    }
    return JSON.stringify({
      build,
      expect,
      token: 'none',
      signature: signature ?? signKit(bytes, signing),
      files,
    });
  };
  const ci = (input, extra = []) => {
    const r = spawnSync(
      'ssh',
      [
        '-i',
        key,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        `UserKnownHostsFile=${join(WORK, 'known_hosts')}`,
        `fifth-ci@${HOST}`,
        ...extra,
      ],
      { encoding: 'utf8', input, timeout: 120_000 },
    );
    return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
  };

  say('▸ Цепочка');
  const shell = ci('', ['id; cat /etc/shadow']);
  check(
    'своя команда не выполняется',
    !shell.out.includes('uid=') && shell.code === 2,
    shell.out.slice(-160),
  );
  const forged = ci(request(build, 'AAAA'));
  check(
    'чужая подпись — отказ',
    forged.code === 2 && forged.out.includes('подпись'),
    forged.out.slice(-160),
  );
  const stale = ci(request('2.1-b1.1'));
  check(
    'устаревшее задание — отказ',
    stale.code === 2 && stale.out.includes('ожидалась'),
    stale.out.slice(-160),
  );
  const same = ci(request(build));
  check(
    'реестр, копия и файлы запуска прочитаны: отказ только из-за той же сборки',
    same.code === 2 && same.out.includes('не новее') && !same.out.includes('файлы запуска'),
    same.out.slice(-220),
  );
} catch (error) {
  check('проверка оборвана', false, error.message);
} finally {
  say('▸ Закрытие');
  if (signPub) {
    const closed = setup(signPub);
    check(
      'ключ входа снят',
      closed.status === 0 && closed.stdout.includes('вход закрыт'),
      closed.stderr,
    );
  }
  rmSync(WORK, { recursive: true, force: true });
}
say(
  failed ? `ИТОГ: отказов ${failed}` : 'ИТОГ: цепочка SSH подтверждена, рабочая среда не менялась',
);
process.exit(failed ? 1 : 0);
