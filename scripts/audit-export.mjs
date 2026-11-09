#!/usr/bin/env node
/**
 * Ежечасная выгрузка журнала аудита (2.1.5; согласовано Тэнком 09.11.2026).
 *
 *   node scripts/audit-export.mjs run                     порция с последнего хвоста
 *   node scripts/audit-export.mjs keygen --out <закрытый> --pub <открытый>
 *
 * Порция: NNNNNN.jsonl.gpg (события подряд по цепочке, на ключ Томаса), NNNNNN.manifest.json
 * (опись) и NNNNNN.manifest.sig (подпись описи ключом выгрузки Ed25519). Порция пишется и
 * без новых событий: её опись подтверждает конец периода. Цепочка сверяется в базе
 * (audit.verify_event_chain) и по ссылкам до подписи. Роль — app_archive_user: журнал только
 * на чтение (M052). Ничего не удаляется: ни события, ни прежние порции.
 *
 * Здесь же — копия на этом сервере, независимой она не считается. Вне сервера порции
 * забирает scripts/audit-offsite.mjs.
 *
 * Окружение: AUDIT_EXPORT_DB_URL (или DATABASE_URL_APP_ARCHIVE), AUDIT_EXPORT_DIR,
 * AUDIT_EXPORT_SIGNING_KEY, AUDIT_EXPORT_RECIPIENT, AUDIT_EXPORT_MONITOR_FILE.
 * Значения не печатаются.
 */
import { spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { checkEventChain, FORMAT, sha256Hex, signManifest } from './lib/audit-export.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const DIR = env.AUDIT_EXPORT_DIR || '/var/lib/fifth-audit-export';
const OUT = join(DIR, 'out');
const STATE = join(DIR, 'state.json');
const MONITOR = env.AUDIT_EXPORT_MONITOR_FILE || '/var/lib/fifth-monitor/audit-export.json';
const KEY = env.AUDIT_EXPORT_SIGNING_KEY || '/etc/fifth-audit-export/signing.key';
const RECIPIENT = env.AUDIT_EXPORT_RECIPIENT || join(ROOT, 'infra/openbao/thomas-recipient.asc');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};

function atomic(path, data, mode = 0o640) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

function report(ok, detail, extra = {}) {
  try {
    atomic(
      MONITOR,
      `${JSON.stringify({ at: new Date().toISOString(), ok, detail, ...extra })}\n`,
      0o644,
    );
  } catch {
    /* наблюдение увидит устаревание файла */
  }
}

/** Шифрование на открытый ключ Томаса во временном каталоге gpg. */
function seal(plain) {
  const home = mkdtempSync(join(tmpdir(), 'audit-export-gpg-'));
  try {
    const gpg = (args, input) =>
      spawnSync('gpg', ['--homedir', home, '--batch', '-q', ...args], {
        input,
        maxBuffer: 1 << 30,
      });
    if (gpg(['--import', RECIPIENT]).status !== 0) throw new Error('ключ получателя не принят');
    const fpr = String(gpg(['--list-keys', '--with-colons']).stdout)
      .split('\n')
      .find((l) => l.startsWith('fpr:'))
      ?.split(':')[9];
    if (!fpr) throw new Error('нет отпечатка получателя');
    const r = gpg(
      ['--trust-model', 'always', '--encrypt', '--recipient', fpr, '--output', '-'],
      plain,
    );
    if (r.status !== 0 || !r.stdout?.length) throw new Error('шифрование не удалось');
    return r.stdout;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const EVENT_SQL = `
  SELECT id::text, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
         verb, actor_id::text, actor_role, subject_type, subject_id::text,
         context_jsonb AS context, trace_id,
         encode(prev_hash, 'hex') AS prev_hash, encode(row_hash, 'hex') AS row_hash
    FROM audit.events`;

async function run() {
  const url = env.AUDIT_EXPORT_DB_URL || env.DATABASE_URL_APP_ARCHIVE;
  if (!url) throw new Error('нет AUDIT_EXPORT_DB_URL');
  const privateKey = createPrivateKey(readFileSync(KEY));
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
  // TLS с проверкой сертификата, как у ядра (DATABASE_SSL): рабочая база требует шифрования;
  // доверенный центр — NODE_EXTRA_CA_CERTS.
  const db = new pg.Client({
    connectionString: url,
    ssl: env.AUDIT_EXPORT_DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  });
  await db.connect();
  try {
    const databaseId = (await db.query('SELECT id::text FROM ops.database_identity')).rows[0]?.id;
    if (!databaseId) throw new Error('нет идентификатора базы');
    if (state && state.databaseId !== databaseId) {
      // Другая база — восстановление или подмена: серия не продолжается сама.
      throw new Error('база сменилась — новую серию начинают вручную после восстановления');
    }
    // Момент проверки берётся ДО чтения: всё, что записано до него, в порции есть.
    const checkedAt = (
      await db.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`)
    ).rows[0].t;
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tail = state?.to ?? null;
    const { rows: events } = tail
      ? await db.query(
          `${EVENT_SQL} WHERE (ts, id) > ($1::timestamptz, $2::uuid) ORDER BY ts, id`,
          [tail.ts, tail.eventId],
        )
      : await db.query(`${EVENT_SQL} ORDER BY ts, id`);
    // Хеши пересчитываются в базе с хвоста прошлой порции (или с начала журнала).
    const broken = (
      await db.query('SELECT count(*)::int AS n FROM audit.verify_event_chain($1)', [
        tail?.ts ?? null,
      ])
    ).rows[0].n;
    await db.query('COMMIT');
    if (broken) throw new Error(`цепочка аудита нарушена: ${broken}`);
    const last = events.at(-1);
    const to = last ? { eventId: last.id, ts: last.ts, rowHash: last.row_hash } : tail;
    const problem = checkEventChain(events, tail?.rowHash ?? null, to?.rowHash ?? null);
    if (problem) throw new Error(problem);

    const seq = (state?.seq ?? 0) + 1;
    const name = String(seq).padStart(6, '0');
    const plain = Buffer.from(events.map((e) => `${JSON.stringify(e)}\n`).join(''));
    const cipher = seal(plain);
    const manifest = {
      format: FORMAT,
      databaseId,
      seq,
      prevManifestSha256: state?.manifestSha256 ?? null,
      from: { afterEventId: tail?.eventId ?? null, afterRowHash: tail?.rowHash ?? null },
      to: to ?? { eventId: null, ts: null, rowHash: null },
      count: events.length,
      plainSha256: sha256Hex(plain),
      cipherSha256: sha256Hex(cipher),
      checkedAt,
    };
    const { bytes, signature } = signManifest(manifest, privateKey);
    atomic(join(OUT, `${name}.jsonl.gpg`), cipher);
    atomic(join(OUT, `${name}.manifest.json`), bytes);
    atomic(join(OUT, `${name}.manifest.sig`), `${signature}\n`);
    atomic(
      STATE,
      `${JSON.stringify({ databaseId, seq, manifestSha256: sha256Hex(bytes), to, checkedAt })}\n`,
      0o600,
    );
    report(true, '', { seq, count: events.length, coveredUntil: checkedAt });
    console.log(`порция ${name}: событий ${events.length}, покрыто до ${checkedAt}`);
  } finally {
    await db.end().catch(() => undefined);
  }
}

function keygen() {
  const out = arg('--out');
  const pub = arg('--pub');
  if (!out || !pub) throw new Error('нужны --out и --pub');
  if (existsSync(out)) throw new Error('закрытый ключ уже есть — не перезаписываю');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  atomic(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
  atomic(pub, publicKey.export({ type: 'spki', format: 'pem' }), 0o644);
  console.log('ключ выгрузки создан');
}

const command = process.argv[2];
try {
  if (command === 'run') await run();
  else if (command === 'keygen') keygen();
  else {
    console.error('команды: run, keygen');
    process.exit(2);
  }
} catch (error) {
  if (command === 'run') report(false, String(error.message).slice(0, 200));
  console.error(`ОШИБКА: ${error.message}`);
  process.exit(1);
}
