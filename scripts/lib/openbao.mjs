/**
 * Служебные обращения к OpenBao с узла: состояние и снимок для копий (блок 5, задание 3).
 * Токены и значения не печатаются. Static seal key здесь не читается и в снимок не входит.
 */
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const DIR = process.env.FIFTH_OPENBAO_DIR || '/etc/fifth-openbao';
const PORT = Number(process.env.FIFTH_OPENBAO_PORT || 8200);
const CA = join(DIR, 'tls', 'tls.crt');
const BACKUP = join(DIR, 'approle', 'prod-backup');

function open(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path: `/v1/${path}`,
        ca: readFileSync(CA),
        servername: 'localhost',
        headers: {
          ...(token ? { 'X-Vault-Token': token } : {}),
          ...(data ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      resolve,
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('OpenBao не ответил вовремя')));
    req.end(data);
  });
}

async function json(res) {
  let text = '';
  for await (const chunk of res) text += chunk;
  return text ? JSON.parse(text) : {};
}

/** Состояние для наблюдения: absent, open, sealed, down. */
export async function openbaoState() {
  if (!existsSync(CA)) return 'absent';
  try {
    const res = await open('GET', 'sys/health?standbyok=true&sealedcode=200&uninitcode=200');
    const health = await json(res);
    if (!health.initialized || health.sealed) return 'sealed';
    return 'open';
  } catch {
    return 'down';
  }
}

/**
 * Снимок OpenBao в файл. Возвращает `null`, если OpenBao на узле нет.
 * Работающий OpenBao без входа для копий — ошибка: копия была бы неполной молча.
 */
export async function openbaoSnapshot(file) {
  const state = await openbaoState();
  if (state === 'absent') return null;
  if (state !== 'open') throw new Error(`снимок OpenBao невозможен: состояние ${state}`);
  if (!existsSync(join(BACKUP, 'role-id'))) throw new Error('нет входа для снимка OpenBao');
  const login = await json(
    await open('POST', 'auth/approle/login', {
      body: {
        role_id: readFileSync(join(BACKUP, 'role-id'), 'utf8').trim(),
        // Значение читается из файла, в коде его нет.
        // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
        secret_id: readFileSync(join(BACKUP, 'secret-id'), 'utf8').trim(),
      },
    }),
  );
  const token = login.auth?.client_token;
  if (!token) throw new Error('вход для снимка OpenBao отклонён');
  const res = await open('GET', 'sys/storage/raft/snapshot', { token });
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`снимок OpenBao: код ${res.statusCode}`);
  }
  await pipeline(res, createWriteStream(file, { mode: 0o600 }));
  return file;
}
