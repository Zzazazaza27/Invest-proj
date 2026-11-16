#!/usr/bin/env node
/**
 * Периодическая сверка окружения узла (Тэнк 15.11) для агента Zabbix: файл
 * MONITOR_STATE_DIR/host-env.json. Описание — из архива окружения, закреплённого комплектами
 * среды (pins → kit.json → hostEnv → .local/host-env/<id>.tar). Только чтение: расхождение
 * сообщается, ничего не исправляется. Не удалось определить — `unverified`, а не совпадение.
 *
 *   node scripts/monitor-host-env.mjs [--print]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './lib/backup.mjs';
import { liveHostFacts } from './lib/host-config.mjs';
import { pinnedHostEnvs } from './lib/host-env-archive.mjs';
import {
  compareEnvironment,
  factsOfHost,
  summarize,
  validateEnvironment,
} from './lib/host-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...parseEnvFile(join(ROOT, '.env'), { secrets: false }), ...process.env };
const dir = resolve(env.MONITOR_STATE_DIR || join(ROOT, '.local', 'monitor-state'));
const kits = env.FIFTH_KITS_DIR || join(ROOT, '.local', 'kits');

function result() {
  const base = { checkedAt: new Date().toISOString() };
  let pinned;
  try {
    pinned = pinnedHostEnvs(kits);
  } catch (e) {
    return { ...base, verdict: 'unverified', reason: `закрепления не прочитаны: ${e.message}` };
  }
  if (!pinned.length)
    return {
      ...base,
      verdict: 'unverified',
      reason: 'комплекты среды не закрепляют архив окружения',
    };
  if (pinned.length > 1)
    return {
      ...base,
      verdict: 'unverified',
      reason: `закреплено архивов: ${pinned.length} (${pinned.map((p) => p.id).join(', ')})`,
    };
  const { id } = pinned[0];
  const tar = join(dirname(kits), 'host-env', `${id}.tar`);
  if (!existsSync(tar))
    return { ...base, archive: id, verdict: 'unverified', reason: 'архива нет на узле' };
  const r = spawnSync('tar', ['-xOf', tar, `hostenv/${id}/environment.json`], { encoding: 'utf8' });
  if (r.status !== 0)
    return {
      ...base,
      archive: id,
      verdict: 'unverified',
      reason: 'описание из архива не прочитано',
    };
  const description = JSON.parse(r.stdout);
  const problems = validateEnvironment(description);
  if (problems.length)
    return { ...base, archive: id, verdict: 'unverified', reason: problems.join('; ') };
  const facts = factsOfHost(
    liveHostFacts(description.components.flatMap((c) => Object.keys(c.packages))),
  );
  const rows = compareEnvironment(description, facts, { holds: true });
  const sum = summarize(rows);
  return {
    ...base,
    archive: id,
    env: description.id,
    ...sum,
    // Только отличия — для комментария тревоги; полный список даёт `host-env check --live`.
    notOk: rows
      .filter((x) => x.state !== 'ok')
      .map((x) => `${x.subject}: ${x.state} (есть ${x.have ?? '—'})`),
  };
}

/**
 * Обновления безопасности (Томас 16.11: «кто следить будет»): ставит их unattended-upgrades,
 * следит Zabbix. Независимо от архива окружения. Не удалось определить — null, а не «всё хорошо».
 *   enabled         — unattended-upgrades установлен И таймер apt-daily-upgrade активен (16.11:
 *                     на узле таймеры apt были выключены — пакет без них не запускается);
 *   lastRunAt       — последний запуск службы apt-daily-upgrade (журнал пишет и пробный
 *                     прогон, поэтому не по нему);
 *   lastResult      — итог службы apt-daily-upgrade (success | failed | …);
 *   pendingSecurity — сколько обновлений безопасности ждут установки (apt-check Ubuntu, по
 *                     кешу списков apt; нет счётчика — null);
 *   rebootRequired  — система просит перезагрузку (ядро, libc); перезагружает владелец.
 */
function updates() {
  const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
  const q = sh('dpkg-query', ['-W', '-f', '${db:Status-Abbrev}', 'unattended-upgrades']);
  // Result у службы, которая ни разу не запускалась, тоже «success» — итог берётся только при
  // отметке запуска.
  const timer = sh('systemctl', ['is-active', 'apt-daily-upgrade.timer']);
  const svc = sh('systemctl', [
    'show',
    '--timestamp=unix',
    'apt-daily-upgrade.service',
    '-p',
    'ExecMainStartTimestamp',
    '-p',
    'Result',
  ]);
  // Ключ=значение: systemctl печатает свойства в своём порядке, а не в порядке -p (16.11: с
  // --value время запуска попало в итог).
  const prop = Object.fromEntries(
    (svc.status === 0 ? svc.stdout : '')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
  const startedAt = prop.ExecMainStartTimestamp;
  const result = prop.Result;
  // Счётчик Ubuntu (update-notifier-common): stderr «все;безопасности». Строки apt-get -s
  // называют один архив версии и обновление из -security часто показывают как -updates.
  const check = sh('/usr/lib/update-notifier/apt-check', []);
  // Перед итогом бывают предупреждения apt — итог в последней строке.
  const counted = check.status === 0 && /(?:^|\n)\d+;(\d+)$/.exec(check.stderr.trim());
  const reboot = '/var/run/reboot-required';
  // После перезагрузки systemd не помнит прошлый запуск службы (16.11) — до первого запуска
  // берётся прежнее значение из своего файла, иначе наблюдение решит, что запусков не было.
  const ran = /^@\d+$/.test(startedAt?.trim() ?? '');
  // Нет и в файле — отметка apt.systemd.daily, которую он ставит только после успешного прохода
  // unattended-upgrade (время конца прохода, а не начала).
  const stamp = '/var/lib/apt/periodic/unattended-upgrades-stamp';
  const prev =
    ran || previous()?.updates?.lastRunAt
      ? previous()?.updates
      : existsSync(stamp)
        ? { lastRunAt: statSync(stamp).mtime.toISOString(), lastResult: 'success' }
        : null;
  return {
    enabled:
      q.error || timer.error
        ? null
        : q.status === 0 && q.stdout.startsWith('ii') && timer.stdout.trim() === 'active',
    lastRunAt: ran
      ? new Date(Number(startedAt.trim().slice(1)) * 1000).toISOString()
      : (prev?.lastRunAt ?? null),
    lastResult: ran ? result?.trim() || null : (prev?.lastResult ?? null),
    pendingSecurity: counted ? Number(counted[1]) : null,
    rebootRequired: existsSync(reboot),
    rebootPackages: existsSync(`${reboot}.pkgs`)
      ? [...new Set(readFileSync(`${reboot}.pkgs`, 'utf8').split('\n').filter(Boolean))]
      : [],
  };
}

const file = join(dir, 'host-env.json');
function previous() {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const out = { ...result(), updates: updates() };
if (process.argv.includes('--print')) console.log(JSON.stringify(out, null, 2));
mkdirSync(dir, { recursive: true });
writeFileSync(`${file}.tmp`, JSON.stringify(out));
renameSync(`${file}.tmp`, file);
