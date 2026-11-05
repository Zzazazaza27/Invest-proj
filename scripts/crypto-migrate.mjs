#!/usr/bin/env node
/**
 * Перенос записей в формат vault (блок 5, задание 5). Запускается на сервере после включения
 * CRYPTO_WRITE_FORMAT=vault.
 *
 *   node scripts/crypto-migrate.mjs run [--batch 200] [--state <файл>]
 *   node scripts/crypto-migrate.mjs verify
 *
 * Значения не печатаются. `run` можно прервать и повторить. Завершение подтверждает только `verify`:
 * код 0 значит, что старых значений не осталось и каждая новая запись открывается.
 *
 * Окружение: DATABASE_URL_OWNER, OPENBAO_ADDR, OPENBAO_CA_PATH, OPENBAO_TOKEN_PATH, OPENBAO_KEY_PREFIX.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATE_TARGETS, migrateTarget, verifyTarget } from './lib/crypto-migrate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'apps', 'core', 'package.json'));
const pg = require('pg');
const env = process.env;
const [command] = process.argv.slice(2);
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Отказ службы помечается: перенос останавливается, а строка порченой не считается. */
function unavailable(message) {
  return Object.assign(new Error(message), { unavailable: true });
}

function decrypt(key, ciphertext, aad) {
  const url = new URL(`/v1/transit/decrypt/${key}`, env.OPENBAO_ADDR);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const token = readFileSync(env.OPENBAO_TOKEN_PATH, 'utf8').trim();
  const body = JSON.stringify({
    ciphertext,
    associated_data: Buffer.from(aad).toString('base64'),
  });
  return new Promise((done, fail) => {
    const req = send(
      url,
      {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
        ...(env.OPENBAO_CA_PATH
          ? { ca: readFileSync(env.OPENBAO_CA_PATH), servername: 'localhost' }
          : {}),
        headers: { 'Content-Type': 'application/json', 'X-Vault-Token': token },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('error', () => fail(unavailable('ответ OpenBao оборван')));
        res.on('end', () => {
          if (res.statusCode === 400) return fail(new Error('запись не открылась'));
          if (res.statusCode !== 200) return fail(unavailable(`OpenBao: код ${res.statusCode}`));
          try {
            done(Buffer.from(JSON.parse(text).data.plaintext, 'base64'));
          } catch {
            fail(unavailable('ответ OpenBao не разобран'));
          }
        });
      },
    );
    req.on('error', () => fail(unavailable('OpenBao недоступен')));
    req.end(body);
  });
}

const prefix = env.OPENBAO_KEY_PREFIX || 'prod';
const stateFile = option('--state');
const state = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};

const db = new pg.Client({ connectionString: env.DATABASE_URL_OWNER });
await db.connect();
try {
  if (command === 'run') {
    for (const target of MIGRATE_TARGETS) {
      const stats = await migrateTarget(db, decrypt, target, {
        prefix,
        batch: Number(option('--batch') ?? 200),
        from: state[target.table] ?? null,
        onPosition: (t, position) => {
          state[t.table] = position;
          if (stateFile) writeFileSync(stateFile, JSON.stringify(state));
        },
      });
      console.log(
        `${target.table}: переведено ${stats.converted}, изменились параллельно ${stats.skipped}, не открылись ${stats.failed}`,
      );
    }
    console.log('порции пройдены; завершение подтверждает только verify');
  } else if (command === 'verify') {
    let complete = true;
    for (const target of MIGRATE_TARGETS) {
      const r = await verifyTarget(db, decrypt, target, { prefix });
      console.log(
        `${target.table}: всего ${r.total}, старых ${r.legacy}, не открылись ${r.unreadable}`,
      );
      complete &&= r.complete;
    }
    console.log(complete ? 'перенос завершён' : 'перенос НЕ завершён');
    process.exitCode = complete ? 0 : 1;
  } else {
    console.error('команды: run, verify');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`ОШИБКА: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
