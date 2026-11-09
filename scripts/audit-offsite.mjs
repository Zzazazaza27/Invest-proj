#!/usr/bin/env node
/**
 * Вынос выгрузки журнала аудита с сервера (2.1.5; согласовано Тэнком 09.11.2026) — на
 * ноутбуке Томаса, по расписанию раз в час (infra/laptop/install-audit-offsite.ps1; ставится
 * только по согласованию с Томасом). Среды — рабочая и test-2, у каждой свой каталог и
 * своя контрольная точка.
 *
 *   node scripts/audit-offsite.mjs pull  [--env prod|test-2] [--to <каталог>]
 *   node scripts/audit-offsite.mjs check [--env prod|test-2] [--to <каталог>]
 *
 * Порция принимается, только если подпись описи верна закреплённым ключом выгрузки
 * (infra/audit/export-signing.pub), шифротекст совпал с описью, и опись ПРОДОЛЖАЕТ
 * доверенную контрольную точку (<каталог>/<среда>/checkpoint.json): старая выгрузка вместо
 * новой, пропуск порции и усечённый хвост отвергаются. Контрольная точка хранится здесь, а
 * не на сервере, и при восстановлении передаётся применению (--checkpoint). После приёма —
 * отметка на сервере (номер и покрытие), по ней наблюдение видит давность выноса. Файлы
 * остаются зашифрованными на ключ Томаса. Значения не печатаются.
 *
 * Для испытаний источник — каталог (FIFTH_AUDIT_SOURCE_DIR/<среда>/out) вместо сервера.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptPortion } from './lib/audit-export.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const ENVS = ['prod', 'test-2'];
const ONLY = option('--env', null);
if (ONLY && !ENVS.includes(ONLY)) throw new Error('среда: prod или test-2');
const TO = resolve(option('--to', 'D:/cloud@mail.ru/projects/5E/audit-export'));
const PUBLIC_KEY =
  process.env.AUDIT_EXPORT_PUBLIC_KEY || join(ROOT, 'infra/audit/export-signing.pub');
const SOURCE_DIR = process.env.FIFTH_AUDIT_SOURCE_DIR || null;
const TASK = '5E audit offsite';
// SSH из Git для Windows: системный OpenSSH Windows на этом ноутбуке ждёт ~30 с на каждом
// соединении (09.11.2026), а вынос делает по соединению на файл.
const GIT_SSH = 'C:/Program Files/Git/usr/bin/ssh.exe';
const SSH = process.platform === 'win32' && existsSync(GIT_SSH) ? GIT_SSH : 'ssh';
const STALE_HOURS = 3;

function remote(command) {
  if (SOURCE_DIR) {
    const [cmd, arg] = command.split(' ');
    const [envId, rest] = arg.split(/[/:](.*)/s);
    const out = join(SOURCE_DIR, envId, 'out');
    if (cmd === 'audit-list') {
      return Buffer.from(
        existsSync(out)
          ? readdirSync(out)
              .filter((n) => /^[0-9]{6}\./.test(n))
              .sort()
              .join('\n')
          : '',
      );
    }
    if (cmd === 'audit-file') return readFileSync(join(out, rest));
    if (cmd === 'audit-ack') {
      writeFileSync(join(SOURCE_DIR, `ack-${envId}.txt`), rest);
      return Buffer.alloc(0);
    }
  }
  const r = spawnSync(
    SSH,
    [
      '-i',
      join(homedir(), '.ssh', 'maus_5e'),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=30',
      'maus@193.233.217.210',
      `sudo -n /usr/local/sbin/fifth-backup-read ${command}`,
    ],
    { maxBuffer: 1 << 30 },
  );
  if (r.status !== 0) throw new Error(`${command.split(' ')[0]}: код ${r.status ?? r.signal}`);
  return r.stdout;
}

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
function atomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, data);
  renameSync(`${path}.tmp`, path);
}

/** Проверка одной порции против контрольной точки (общая библиотека); новая точка. */
const accept = (checkpoint, manifestBytes, sig, cipher) =>
  acceptPortion(checkpoint, manifestBytes, sig, cipher, readFileSync(PUBLIC_KEY, 'utf8')).point;

function pullEnv(envId) {
  const series = join(TO, envId, 'series');
  const cpFile = join(TO, envId, 'checkpoint.json');
  let checkpoint = readJson(cpFile);
  const names = remote(`audit-list ${envId}`).toString('utf8').split('\n').filter(Boolean);
  const seqs = [...new Set(names.map((n) => Number(n.slice(0, 6))))].sort((a, b) => a - b);
  const pending = seqs.filter((s) => s > (checkpoint?.seq ?? 0));
  let taken = 0;
  for (const seq of pending) {
    const name = String(seq).padStart(6, '0');
    const manifestBytes = remote(`audit-file ${envId}/${name}.manifest.json`);
    const sig = remote(`audit-file ${envId}/${name}.manifest.sig`).toString('utf8');
    const cipher = remote(`audit-file ${envId}/${name}.jsonl.gpg`);
    const next = accept(checkpoint, manifestBytes, sig, cipher);
    atomic(join(series, `${name}.jsonl.gpg`), cipher);
    atomic(join(series, `${name}.manifest.json`), manifestBytes);
    atomic(join(series, `${name}.manifest.sig`), sig);
    atomic(cpFile, `${JSON.stringify(next, null, 2)}\n`);
    checkpoint = next;
    taken++;
  }
  if (checkpoint) remote(`audit-ack ${envId}:${checkpoint.seq}@${checkpoint.checkedAt}`);
  console.log(
    `${envId}: принято порций ${taken}; покрыто до ${checkpoint?.checkedAt ?? '—'} (порция ${checkpoint?.seq ?? '—'})`,
  );
}

function pull() {
  if (!existsSync(PUBLIC_KEY)) throw new Error('нет закреплённого ключа выгрузки');
  let failed = 0;
  for (const envId of ONLY ? [ONLY] : ENVS) {
    try {
      pullEnv(envId);
    } catch (error) {
      failed++;
      console.error(`${envId}: ОШИБКА: ${error.message}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

/** Вся локальная серия среды с начала: подписи, шифротексты, продолжение; и расписание. */
function check() {
  let failed = false;
  const say = (ok, text) => {
    if (!ok) failed = true;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${text}`);
  };
  for (const envId of ONLY ? [ONLY] : ENVS) {
    const series = join(TO, envId, 'series');
    let point = null;
    const files = existsSync(series) ? readdirSync(series) : [];
    const seqs = [
      ...new Set(
        files.filter((n) => /^[0-9]{6}\.manifest\.json$/.test(n)).map((n) => Number(n.slice(0, 6))),
      ),
    ].sort((a, b) => a - b);
    try {
      for (const seq of seqs) {
        const name = String(seq).padStart(6, '0');
        point = accept(
          point,
          readFileSync(join(series, `${name}.manifest.json`)),
          readFileSync(join(series, `${name}.manifest.sig`), 'utf8'),
          readFileSync(join(series, `${name}.jsonl.gpg`)),
        );
      }
      say(seqs.length > 0, `${envId}: серия с начала проверена, порций ${seqs.length}`);
    } catch (error) {
      say(false, `${envId}: серия не сходится: ${error.message}`);
    }
    const cp = readJson(join(TO, envId, 'checkpoint.json'));
    say(
      Boolean(cp && point && cp.seq === point.seq && cp.manifestSha256 === point.manifestSha256),
      `${envId}: контрольная точка совпадает с концом серии`,
    );
    if (point) {
      const age = (Date.now() - Date.parse(point.checkedAt)) / 3_600_000;
      say(
        age <= STALE_HOURS,
        `${envId}: покрыто до ${point.checkedAt} (${age.toFixed(1)} ч назад; цель ≤ ${STALE_HOURS} ч)`,
      );
    }
  }
  // Расписание Windows: задание есть и последний запуск успешен.
  const q = spawnSync('schtasks', ['/Query', '/TN', TASK, '/V', '/FO', 'LIST'], {
    encoding: 'utf8',
  });
  if (q.status !== 0) say(false, `задания «${TASK}» в расписании нет — не установлено`);
  else {
    const field = (re) =>
      q.stdout
        .split(/\r?\n/)
        .find((l) => re.test(l))
        ?.split(':')
        .slice(1)
        .join(':')
        .trim() ?? '—';
    const last = field(/^(Last Run Time|Время прошлого запуска)/i);
    const result = field(/^(Last Result|Прошлый результат)/i);
    say(result === '0', `расписание: последний запуск ${last}, результат ${result}`);
  }
  process.exitCode = failed ? 1 : 0;
}

const command = process.argv[2];
try {
  if (command === 'pull') pull();
  else if (command === 'check') check();
  else {
    console.error('команды: pull, check');
    process.exit(2);
  }
} catch (error) {
  console.error(`ОШИБКА: ${error.message}`);
  process.exit(1);
}
