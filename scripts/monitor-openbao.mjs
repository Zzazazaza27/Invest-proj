#!/usr/bin/env node
/**
 * Состояние OpenBao для агента Zabbix (блок 5, задание 3): файл MONITOR_STATE_DIR/openbao.json.
 * `requests` — обслуживает ли открытый OpenBao запросы с журналом (работа № 4: отказ аудита).
 * Без токенов и секретов. Zabbix от OpenBao не зависит.
 *
 *   node scripts/monitor-openbao.mjs
 */
import { renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './lib/backup.mjs';
import { openbaoRequestsState, openbaoState } from './lib/openbao.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...parseEnvFile(join(ROOT, '.env'), { secrets: false }), ...process.env };
const dir = resolve(env.MONITOR_STATE_DIR || join(ROOT, '.local', 'monitor-state'));
const file = join(dir, 'openbao.json');
/** Agent жив, если файл токена на месте: без него секреты и служебные запуски не работают. */
function agentState() {
  if (env.KMS_MODE !== 'kms') return 'absent';
  try {
    return statSync(env.OPENBAO_TOKEN_PATH).size > 0 ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}
const state = await openbaoState();
// Открыт, но не обслуживает (отказ аудита и т. п.) — отдельный признак: `sys/health` его не видит.
const requests = state === 'open' ? await openbaoRequestsState() : 'unknown';
writeFileSync(`${file}.tmp`, JSON.stringify({ state, requests, agent: agentState() }));
renameSync(`${file}.tmp`, file);
