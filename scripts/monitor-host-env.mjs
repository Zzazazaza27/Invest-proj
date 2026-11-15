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
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
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

const out = result();
if (process.argv.includes('--print')) console.log(JSON.stringify(out, null, 2));
mkdirSync(dir, { recursive: true });
const file = join(dir, 'host-env.json');
writeFileSync(`${file}.tmp`, JSON.stringify(out));
renameSync(`${file}.tmp`, file);
