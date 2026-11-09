#!/usr/bin/env node
/**
 * Применение учёта удалений после восстановления (2.1.5; согласовано Тэнком 09.11.2026).
 *
 *   node scripts/deletions-apply.mjs apply  --db <URL владельца восстановленной базы>
 *        --restore-id <метка> (--source-db <URL> | --source-export <каталог серии>
 *        --secret-key <файл> --passphrase-file <файл>) [--report <файл>]
 *   node scripts/deletions-apply.mjs verify …те же аргументы…
 *   node scripts/deletions-apply.mjs open   …те же аргументы… --coverage-ack <покрыто до>
 *
 * Восстановленная база закрыта сама (ворота M167 привязаны к отпечатку базы). Граница —
 * последнее общее звено цепочки аудита восстановленной базы и источника: так база
 * узнаётся как та же самая, на какой бы машине её ни восстановили. События источника
 * после границы сводятся к итоговому состоянию каждой идентичности
 * (scripts/lib/deletions-replay.mjs) и применяются; применение и отметка в
 * ops.deletions_applied — одной транзакцией, повтор ничего не меняет.
 *
 * Источник — копия текущей базы, база, восстановленная до последнего WAL, или
 * независимая выгрузка (подпись, продолжение серии, цепочка событий). Полнота — по
 * реальному покрытию источника, а не по наличию файла: открытие требует явного
 * подтверждения конца покрытия (--coverage-ack).
 *
 * open — только после итоговой проверки: все события после границы учтены, повтор ничего
 * не меняет, неустранимых нет. Тогда ворота открываются для текущего отпечатка базы, а
 * токены, выданные до открытия, перестают действовать (отозванные после копии иначе
 * ожили бы). Ничего не удаляется физически.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { acceptPortion, checkEventChain, sha256Hex } from './lib/audit-export.mjs';
import { applyItem, planReplay } from './lib/deletions-replay.mjs';
import { s3Object, storageFromEnv } from './lib/s3.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
};
const PUBLIC_KEY =
  process.env.AUDIT_EXPORT_PUBLIC_KEY || join(ROOT, 'infra/audit/export-signing.pub');

const EVENT_SQL = `
  SELECT id::text, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
         verb, actor_id::text, actor_role, subject_type, subject_id::text,
         context_jsonb AS context, trace_id,
         encode(prev_hash, 'hex') AS prev_hash, encode(row_hash, 'hex') AS row_hash
    FROM audit.events`;

// ------------------------------------------------------------ источник событий

async function sourceFromDb(url) {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const coveredUntil = (
      await db.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`)
    ).rows[0].t;
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const databaseId = (await db.query('SELECT id::text FROM ops.database_identity')).rows[0]?.id;
    const { rows: events } = await db.query(`${EVENT_SQL} ORDER BY ts, id`);
    const broken = (await db.query('SELECT count(*)::int AS n FROM audit.verify_event_chain(NULL)'))
      .rows[0].n;
    await db.query('COMMIT');
    if (broken) throw new Error(`цепочка аудита источника нарушена: ${broken}`);
    const problem = checkEventChain(events, null, events.at(-1)?.row_hash ?? null);
    if (problem) throw new Error(`источник: ${problem}`);
    return { kind: 'база', databaseId, events, coveredUntil };
  } finally {
    await db.end().catch(() => undefined);
  }
}

function decryptor(secretKey, passFile) {
  const home = mkdtempSync(join(tmpdir(), 'deletions-gpg-'));
  const gpg = (args, input) =>
    spawnSync('gpg', ['--homedir', home, '--batch', '-q', '--pinentry-mode', 'loopback', ...args], {
      input,
      maxBuffer: 1 << 30,
    });
  if (gpg(['--passphrase-file', passFile, '--import', secretKey]).status !== 0) {
    rmSync(home, { recursive: true, force: true });
    throw new Error('закрытый ключ не принят');
  }
  return {
    open: (cipher) => {
      const r = gpg(['--passphrase-file', passFile, '--decrypt'], cipher);
      if (r.status !== 0) throw new Error('порция не расшифрована');
      return r.stdout;
    },
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** Серия выгрузки: каталог series/ выноса или out/ сервера. */
function sourceFromExport(dir) {
  const pub = readFileSync(PUBLIC_KEY, 'utf8');
  const d = decryptor(arg('--secret-key'), arg('--passphrase-file'));
  try {
    const seqs = [
      ...new Set(
        readdirSync(dir)
          .filter((n) => /^[0-9]{6}\.manifest\.json$/.test(n))
          .map((n) => Number(n.slice(0, 6))),
      ),
    ].sort((a, b) => a - b);
    let point = null;
    const events = [];
    for (const seq of seqs) {
      const name = String(seq).padStart(6, '0');
      const cipher = readFileSync(join(dir, `${name}.jsonl.gpg`));
      const { point: next, manifest } = acceptPortion(
        point,
        readFileSync(join(dir, `${name}.manifest.json`)),
        readFileSync(join(dir, `${name}.manifest.sig`), 'utf8'),
        cipher,
        pub,
      );
      const plain = d.open(cipher);
      if (sha256Hex(plain) !== manifest.plainSha256)
        throw new Error(`порция ${seq}: содержимое не по описи`);
      const portion = plain
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const problem = checkEventChain(portion, manifest.from.afterRowHash, manifest.to.rowHash);
      if (problem) throw new Error(`порция ${seq}: ${problem}`);
      events.push(...portion);
      point = next;
    }
    if (!point) throw new Error('в серии нет порций');
    return {
      kind: 'выгрузка',
      databaseId: point.databaseId,
      events,
      coveredUntil: point.checkedAt,
    };
  } finally {
    d.close();
  }
}

async function loadSource() {
  if (arg('--source-db')) return sourceFromDb(arg('--source-db'));
  if (arg('--source-export')) return sourceFromExport(arg('--source-export'));
  throw new Error('нужен --source-db или --source-export');
}

// ------------------------------------------------------------ восстановленная база

/** Последнее общее звено: идём назад по восстановленной цепочке до события источника. */
async function findBase(db, source) {
  const byId = new Map(source.events.map((e, i) => [e.id, i]));
  let offset = 0;
  for (;;) {
    const { rows } = await db.query(
      `SELECT id::text, encode(row_hash, 'hex') AS row_hash FROM audit.events
        ORDER BY ts DESC, id DESC LIMIT 500 OFFSET $1`,
      [offset],
    );
    if (!rows.length) return null;
    for (const r of rows) {
      const i = byId.get(r.id);
      if (i !== undefined) {
        if (source.events[i].row_hash !== r.row_hash) {
          throw new Error('общее событие с другим хешем — источник не от этой базы');
        }
        return { index: i, eventId: r.id, rowHash: r.row_hash };
      }
    }
    offset += rows.length;
  }
}

function storageChecker() {
  const storage = storageFromEnv();
  return {
    configured: Boolean(storage),
    exists: async (key, sha) => {
      if (!storage) return false;
      const r = await s3Object(storage, 'GET', key);
      if (r.status !== 200) return false;
      return sha256Hex(Buffer.from(await r.arrayBuffer())) === sha;
    },
  };
}

async function prepare() {
  const restoreId = arg('--restore-id');
  if (!/^[A-Za-z0-9._:-]{3,80}$/.test(restoreId ?? '')) throw new Error('нужен --restore-id');
  const db = new pg.Client({ connectionString: arg('--db') });
  await db.connect();
  const gate = (await db.query('SELECT ops.restore_gate_state() AS s')).rows[0].s;
  if (gate !== 'closed') {
    await db.end();
    throw new Error('ворота базы открыты — применять к открытой среде нельзя');
  }
  const databaseId = (await db.query('SELECT id::text FROM ops.database_identity')).rows[0]?.id;
  const source = await loadSource();
  if (source.databaseId !== databaseId) {
    await db.end();
    throw new Error('источник от другой базы (идентификатор базы не совпал)');
  }
  const base = await findBase(db, source);
  if (!base) {
    await db.end();
    throw new Error('нет общего звена цепочки с источником — источник не покрывает копию');
  }
  const after = source.events.slice(base.index + 1);
  const plan = planReplay(after);
  return { db, restoreId, source, base, after, plan };
}

const short = (x) => `${x.category} ${x.identity}`;

async function apply() {
  const { db, restoreId, source, base, after, plan } = await prepare();
  const storage = storageChecker();
  const report = {
    restoreId,
    source: source.kind,
    coveredUntil: source.coveredUntil,
    base,
    items: [],
  };
  try {
    await db.query(
      `INSERT INTO ops.restore_gate (singleton, state, restore_id, base_event_id, base_row_hash, reason)
       VALUES (true, 'closed', $1, $2::uuid, decode($3, 'hex'), 'применение журнала удалений')
       ON CONFLICT (singleton) DO UPDATE
         SET state = 'closed', restore_id = EXCLUDED.restore_id,
             base_event_id = EXCLUDED.base_event_id, base_row_hash = EXCLUDED.base_row_hash,
             reason = EXCLUDED.reason, changed_at = now()`,
      [restoreId, base.eventId, base.rowHash],
    );
    for (const item of plan.items) {
      await db.query('BEGIN');
      try {
        const done = await db.query(
          'SELECT 1 FROM ops.deletions_applied WHERE event_id = $1::uuid',
          [item.final.eventId],
        );
        if (done.rows.length) {
          await db.query('ROLLBACK');
          report.items.push({ ...pick(item), result: 'уже применено' });
          continue;
        }
        const { result, note } = await applyItem(db, item, storage);
        for (const id of item.eventIds) {
          await db.query(
            `INSERT INTO ops.deletions_applied (event_id, restore_id, category, identity, result)
             VALUES ($1::uuid, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING`,
            [
              id,
              restoreId,
              item.category,
              item.identity,
              id === item.final.eventId ? result : 'superseded',
            ],
          );
        }
        await db.query(
          `SELECT audit.app_emit_event('ops.restore.reapplied', NULL, 'system', 'restore', NULL,
                                       $1::jsonb, NULL)`,
          [
            JSON.stringify({
              restoreId,
              category: item.category,
              identity: item.identity,
              result,
              sourceEventId: item.final.eventId,
            }),
          ],
        );
        await db.query('COMMIT');
        report.items.push({ ...pick(item), result, note: note ?? null });
      } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        report.items.push({
          ...pick(item),
          result: 'ошибка',
          note: String(error.message).slice(0, 200),
        });
      }
    }
    report.unresolved = plan.unresolved;
    finish(report, after.length);
  } finally {
    await db.end().catch(() => undefined);
  }
}

const pick = (item) => ({
  category: item.category,
  identity: item.identity,
  sourceEventId: item.final.eventId,
});

function finish(report, eventsAfter) {
  if (arg('--report')) writeFileSync(arg('--report'), `${JSON.stringify(report, null, 2)}\n`);
  const count = (r) => report.items.filter((i) => i.result === r).length;
  console.log(
    `источник: ${report.source}, покрыто до ${report.coveredUntil}; граница ${report.base.eventId}; ` +
      `событий после границы ${eventsAfter}, идентичностей ${report.items.length}`,
  );
  console.log(
    `применено ${count('applied')}, без изменений ${count('unchanged')}, закрыто ${count('closed')}, ` +
      `не воссоздано ${count('not-recreated')}, уже применено ${count('уже применено')}, ошибок ${count('ошибка')}`,
  );
  for (const i of report.items.filter((x) =>
    ['closed', 'not-recreated', 'ошибка'].includes(x.result),
  )) {
    console.log(`  ${i.result}: ${short(i)} — ${i.note}`);
  }
  for (const u of report.unresolved ?? []) {
    console.log(`  НЕУСТРАНИМО: событие ${u.eventId} (${u.verb}) — ${u.reason}`);
  }
  if (count('ошибка') || report.unresolved?.length) process.exitCode = 1;
}

/** Итоговая проверка: всё учтено и повтор ничего не меняет (пробное применение с откатом). */
async function verifyPlan(ctx) {
  const { db, plan } = ctx;
  const storage = storageChecker();
  const problems = [];
  for (const u of plan.unresolved) problems.push(`неустранимо: событие ${u.eventId} (${u.verb})`);
  for (const item of plan.items) {
    const done = await db.query(
      'SELECT result FROM ops.deletions_applied WHERE event_id = $1::uuid',
      [item.final.eventId],
    );
    if (!done.rows.length) {
      problems.push(`не применено: ${short(item)}`);
      continue;
    }
    await db.query('BEGIN');
    try {
      const { result } = await applyItem(db, item, storage);
      if (result === 'applied') problems.push(`повтор меняет состояние: ${short(item)}`);
    } finally {
      await db.query('ROLLBACK');
    }
  }
  return problems;
}

async function verify() {
  const ctx = await prepare();
  try {
    const problems = await verifyPlan(ctx);
    console.log(
      `проверка: событий после границы ${ctx.after.length}, идентичностей ${ctx.plan.items.length}, ` +
        `покрыто до ${ctx.source.coveredUntil}`,
    );
    for (const p of problems) console.log(`  FAIL  ${p}`);
    console.log(
      problems.length ? 'ИТОГ: открывать нельзя' : 'ИТОГ: учёт удалений применён полностью',
    );
    process.exitCode = problems.length ? 1 : 0;
  } finally {
    await ctx.db.end().catch(() => undefined);
  }
}

async function open() {
  const ack = arg('--coverage-ack');
  const ctx = await prepare();
  try {
    const problems = await verifyPlan(ctx);
    if (problems.length) {
      for (const p of problems) console.log(`  FAIL  ${p}`);
      throw new Error('итоговая проверка не пройдена — ворота закрыты');
    }
    if (ack !== ctx.source.coveredUntil) {
      throw new Error(
        `подтвердите конец покрытия источника: --coverage-ack ${ctx.source.coveredUntil} ` +
          '(события позже этого момента источник не содержит)',
      );
    }
    await ctx.db.query('BEGIN');
    await ctx.db.query(
      `UPDATE ops.restore_gate
          SET state = 'open', fingerprint = ops.database_fingerprint(), changed_at = now(),
              reason = $2
        WHERE restore_id = $1`,
      [ctx.restoreId, `открыто после проверки; покрыто до ${ack}`],
    );
    // Токены, выданные до открытия, недействительны: отзыв сессий после копии в ней не
    // сохранился, и без этого отозванные токены ожили бы.
    await ctx.db.query('UPDATE identity.users SET sessions_valid_from = now()');
    await ctx.db.query(
      `SELECT audit.app_emit_event('ops.restore.opened', NULL, 'system', 'restore', NULL,
                                   $1::jsonb, NULL)`,
      [
        JSON.stringify({
          restoreId: ctx.restoreId,
          coveredUntil: ack,
          items: ctx.plan.items.length,
        }),
      ],
    );
    await ctx.db.query('COMMIT');
    console.log(`ворота открыты; покрыто до ${ack}; все сессии требуют нового входа`);
  } finally {
    await ctx.db.end().catch(() => undefined);
  }
}

const commands = { apply, verify, open };
const command = process.argv[2];
if (!commands[command]) {
  console.error('команды: apply, verify, open');
  process.exit(2);
}
try {
  if (!arg('--db')) throw new Error('нужен --db');
  if (arg('--source-export') && !existsSync(PUBLIC_KEY))
    throw new Error('нет закреплённого ключа выгрузки');
  await commands[command]();
} catch (error) {
  console.error(`ОШИБКА: ${error.message}`);
  process.exit(1);
}
