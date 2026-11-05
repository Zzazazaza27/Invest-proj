#!/usr/bin/env node
/**
 * Состояние OpenBao для агента Zabbix (блок 5, задание 3): файл MONITOR_STATE_DIR/openbao.json.
 * Без токенов и секретов. Zabbix от OpenBao не зависит.
 *
 *   node scripts/monitor-openbao.mjs
 */
import { renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './lib/backup.mjs';
import { openbaoState } from './lib/openbao.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...parseEnvFile(join(ROOT, '.env')), ...process.env };
const dir = resolve(env.MONITOR_STATE_DIR || join(ROOT, '.local', 'monitor-state'));
const file = join(dir, 'openbao.json');
writeFileSync(`${file}.tmp`, JSON.stringify({ state: await openbaoState() }));
renameSync(`${file}.tmp`, file);
