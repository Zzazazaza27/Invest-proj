#!/usr/bin/env node
/**
 * Применение описания окружения на работающем узле (Тэнк 15.11) — отдельно от выпуска, по
 * команде Томаса. Запускается на узле под root.
 *
 *   node scripts/host-env-apply.mjs plan               что изменится; ничего не меняет
 *   node scripts/host-env-apply.mjs apply --yes        закрепить, политика, сверка по таймеру
 *   node scripts/host-env-apply.mjs rollback <отметка> вернуть состояние до apply
 *
 * Что делает apply — только три вещи, каждая обратима:
 *   1. apt-mark hold — ТОЛЬКО управляемые пакеты поставщиков из описания (правило exact): не вся
 *      ОС и не ядро; пакетам Ubuntu обновления безопасности остаются;
 *   2. /etc/apt/apt.conf.d/52fifth-unattended-upgrades — автообновления: только источники
 *      безопасности Ubuntu, управляемые пакеты исключены; перезагрузка не трогается;
 *   3. таймер fifth-monitor-host-env — ежедневная сверка в Zabbix; она ничего не исправляет.
 * Пакеты не ставятся, не обновляются и не удаляются; службы не перезапускаются.
 * Прежнее состояние — /var/backups/fifth-element/host-env-apply/<отметка>.json.
 *
 * Описание — из архива окружения, закреплённого комплектами среды (как у сверки).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinnedHostEnvs } from './lib/host-env-archive.mjs';
import { validateEnvironment } from './lib/host-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KITS = process.env.FIFTH_KITS_DIR || join(ROOT, '.local', 'kits');
const POLICY = '/etc/apt/apt.conf.d/52fifth-unattended-upgrades';
const UNITS = ['fifth-monitor-host-env.service', 'fifth-monitor-host-env.timer'];
const STATE_DIR = '/var/backups/fifth-element/host-env-apply';
const argv = process.argv.slice(2);

const run = (cmd, args, { allowFail = false } = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0 && !allowFail)
    throw new Error(`${cmd} ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
};

function description() {
  const pinned = pinnedHostEnvs(KITS);
  if (pinned.length !== 1)
    throw new Error(
      pinned.length
        ? `закреплено архивов окружения: ${pinned.length} — сначала один`
        : 'комплекты среды не закрепляют архив окружения: сначала выпуск с hostEnv',
    );
  const { id } = pinned[0];
  const tar = join(dirname(KITS), 'host-env', `${id}.tar`);
  const r = run('tar', ['-xOf', tar, `hostenv/${id}/environment.json`]);
  const env = JSON.parse(r.out);
  const problems = validateEnvironment(env);
  if (problems.length) throw new Error(`описание ${env.id}: ${problems.join('; ')}`);
  if (env.status !== 'approved') throw new Error(`описание ${env.id} не утверждено`);
  return { id, env };
}

const managedOf = (env) =>
  env.components.filter((c) => c.match === 'exact').flatMap((c) => Object.keys(c.packages));

function policyText(env, archive) {
  const q = (s) => `\t"${s}";`;
  return [
    `// 5Э, окружение узла: политика автообновлений по описанию ${env.id} (архив ${archive}).`,
    '// Ставит и снимает scripts/host-env-apply.mjs. Автоматически — только обновления',
    '// безопасности Ubuntu; управляемые компоненты меняются только новым архивом окружения.',
    '#clear Unattended-Upgrade::Allowed-Origins;',
    'Unattended-Upgrade::Allowed-Origins {',
    q('${distro_id}:${distro_codename}-security'),
    q('${distro_id}ESMApps:${distro_codename}-apps-security'),
    q('${distro_id}ESM:${distro_codename}-infra-security'),
    '};',
    'Unattended-Upgrade::Package-Blacklist {',
    ...managedOf(env).map(q),
    '};',
    '',
  ].join('\n');
}

function current() {
  const holds = run('apt-mark', ['showhold']).out.split('\n').filter(Boolean);
  const installed = Object.fromEntries(
    run('dpkg-query', ['-W', '-f', '${Package}\t${db:Status-Abbrev}\n'], { allowFail: true })
      .out.split('\n')
      .map((l) => l.split('\t'))
      .map(([p, s]) => [p, (s ?? '')[1] === 'i']),
  );
  const timer = run('systemctl', ['is-enabled', 'fifth-monitor-host-env.timer'], {
    allowFail: true,
  }).out;
  const origins = run('apt-config', ['dump', 'Unattended-Upgrade::Allowed-Origins'], {
    allowFail: true,
  }).out;
  return {
    holds,
    installed,
    policy: existsSync(POLICY) ? readFileSync(POLICY, 'utf8') : null,
    timer: timer || 'not-found',
    origins,
  };
}

function plan() {
  const { id, env } = description();
  const now = current();
  const managed = managedOf(env);
  const missing = managed.filter((p) => !now.installed[p]);
  const toHold = managed.filter((p) => now.installed[p] && !now.holds.includes(p));
  const text = policyText(env, id);
  return { id, env, now, managed, missing, toHold, text, policyChanges: now.policy !== text };
}

function print(p) {
  console.log(`описание ${p.env.id}, архив ${p.id}`);
  console.log(`  управляемые пакеты: ${p.managed.join(', ')}`);
  if (p.missing.length) console.log(`  НЕ УСТАНОВЛЕНЫ (apply не ставит): ${p.missing.join(', ')}`);
  console.log(`  закрепить: ${p.toHold.join(', ') || 'нечего'}`);
  console.log(`  уже закреплены: ${p.now.holds.join(', ') || 'нет'}`);
  console.log(
    `  автообновления сейчас (Allowed-Origins):\n${p.now.origins.replace(/^/gm, '    ')}`,
  );
  console.log(
    `  ${POLICY}: ${p.now.policy === null ? 'нет' : 'есть'} → ${p.policyChanges ? 'будет записан' : 'без изменений'}`,
  );
  console.log(`  таймер сверки: ${p.now.timer} → enabled`);
}

function apply() {
  if (!argv.includes('--yes')) throw new Error('apply только с --yes (после plan)');
  const p = plan();
  if (p.missing.length)
    throw new Error(`не установлены: ${p.missing.join(', ')} — apply пакеты не ставит`);
  print(p);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const saved = {
    stamp,
    archive: p.id,
    holdsBefore: p.now.holds,
    held: p.toHold,
    policyBefore: p.now.policy,
    timerBefore: p.now.timer,
  };
  writeFileSync(join(STATE_DIR, `${stamp}.json`), `${JSON.stringify(saved, null, 2)}\n`, {
    mode: 0o600,
  });
  if (p.toHold.length) run('apt-mark', ['hold', ...p.toHold]);
  writeFileSync(`${POLICY}.tmp`, p.text, { mode: 0o644 });
  run('apt-config', ['-c', `${POLICY}.tmp`, 'dump', 'Unattended-Upgrade']); // синтаксис до замены
  copyFileSync(`${POLICY}.tmp`, POLICY);
  rmSync(`${POLICY}.tmp`);
  for (const u of UNITS)
    copyFileSync(join(ROOT, 'infra', 'systemd', u), join('/etc/systemd/system', u));
  run('systemctl', ['daemon-reload']);
  run('systemctl', ['enable', '--now', 'fifth-monitor-host-env.timer']);
  run('systemctl', ['start', 'fifth-monitor-host-env.service'], { allowFail: true });
  console.log(`применено; прежнее состояние: ${join(STATE_DIR, `${stamp}.json`)}`);
  console.log(`возврат: node scripts/host-env-apply.mjs rollback ${stamp}`);
}

function rollback() {
  const stamp = argv[1];
  const file = join(STATE_DIR, `${stamp}.json`);
  if (!stamp || !existsSync(file)) throw new Error(`нет отметки ${stamp ?? ''}`);
  const s = JSON.parse(readFileSync(file, 'utf8'));
  // Снимаются только закрепления, поставленные этим apply; прежние остаются.
  const unhold = s.held.filter((p) => !s.holdsBefore.includes(p));
  if (unhold.length) run('apt-mark', ['unhold', ...unhold]);
  if (s.policyBefore === null) rmSync(POLICY, { force: true });
  else writeFileSync(POLICY, s.policyBefore, { mode: 0o644 });
  if (s.timerBefore !== 'enabled') {
    run('systemctl', ['disable', '--now', 'fifth-monitor-host-env.timer'], { allowFail: true });
    if (s.timerBefore === 'not-found')
      for (const u of UNITS) rmSync(join('/etc/systemd/system', u), { force: true });
    run('systemctl', ['daemon-reload']);
  }
  console.log(
    `возвращено к состоянию ${stamp}: сняты закрепления ${unhold.join(', ') || '—'}, политика ${s.policyBefore === null ? 'удалена' : 'прежняя'}, таймер ${s.timerBefore}`,
  );
}

const commands = { plan: () => print(plan()), apply, rollback };
try {
  if (!commands[argv[0]]) throw new Error('команды: plan, apply --yes, rollback <отметка>');
  commands[argv[0]]();
} catch (e) {
  console.error(`host-env-apply: ${e.message}`);
  process.exit(2);
}
