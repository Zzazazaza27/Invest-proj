/**
 * Плановая смена версии ключа в Transit (блок 5, задание 5).
 *
 * Новая версия не трогает данные: новые записи пишутся ею, старые читаются своей. Переупаковка
 * меняет только `wrapped_dek` и прямые поля, содержимое не шифруется заново. Ключ поиска здесь не
 * меняется: новая версия означала бы пересчёт всех индексов, это отдельная работа.
 *
 * `call(method, path, { body })` — запрос к OpenBao с токеном, `db` — клиент PostgreSQL.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { MIGRATE_TARGETS } from './crypto-migrate.mjs';

const ident = (name) => {
  if (!/^[a-z_]+(\.[a-z_]+)?$/.test(name)) throw new Error('неверное имя');
  return name;
};

export function targetsOf(domain) {
  if (domain === 'search_index') {
    throw new Error('ключ поиска так не меняется: новая версия требует пересчёта всех индексов');
  }
  const key = domain.replaceAll('_', '-');
  const found = MIGRATE_TARGETS.filter((t) => t.key === key);
  if (found.length === 0) throw new Error(`домен ${domain} не обслуживается`);
  return found;
}

function answer(what, r) {
  if (r.status >= 300) {
    throw Object.assign(new Error(`${what}: код ${r.status}`), { unavailable: r.status !== 400 });
  }
  return r.json.data ?? {};
}

export async function latestVersion(call, name) {
  return Number(answer('чтение ключа', await call('GET', `transit/keys/${name}`)).latest_version);
}

/** Новая версия и контроль: запись ею и чтение обратно. */
export async function rotateKey(call, name) {
  const before = await latestVersion(call, name);
  answer('новая версия', await call('POST', `transit/keys/${name}/rotate`));
  const after = await latestVersion(call, name);
  if (after !== before + 1) throw new Error('версия ключа не изменилась');
  const probe = randomBytes(32);
  const aad = Buffer.from(`rotate-check:${name}`).toString('base64');
  const written = answer(
    'контрольная запись',
    await call('POST', `transit/encrypt/${name}`, {
      body: { plaintext: probe.toString('base64'), associated_data: aad },
    }),
  );
  if (!String(written.ciphertext).startsWith(`vault:v${after}:`)) {
    throw new Error('контрольная запись сделана не новой версией');
  }
  const read = answer(
    'контрольное чтение',
    await call('POST', `transit/decrypt/${name}`, {
      body: { ciphertext: written.ciphertext, associated_data: aad },
    }),
  );
  if (!timingSafeEqual(Buffer.from(String(read.plaintext), 'base64'), probe)) {
    throw new Error('контрольное чтение не совпало');
  }
  return after;
}

/**
 * Запись на последнюю версию. Встроенный `transit/rewrap` не принимает AAD, а наши записи без него
 * не открываются, поэтому значение на миг проходит через этот процесс и сразу обнуляется.
 */
export async function repack(call, name, text, aad) {
  const opened = await call('POST', `transit/decrypt/${name}`, {
    body: { ciphertext: text, associated_data: aad },
  });
  if (opened.status === 400) return null;
  const plain = Buffer.from(String(answer('чтение записи', opened).plaintext), 'base64');
  try {
    const sealed = answer(
      'запись новой версией',
      await call('POST', `transit/encrypt/${name}`, {
        body: { plaintext: plain.toString('base64'), associated_data: aad },
      }),
    );
    return Buffer.from(String(sealed.ciphertext), 'ascii');
  } finally {
    plain.fill(0);
  }
}

/** Переупаковка порциями, строка меняется только если значение не менялось. */
export async function rewrapTarget(db, call, target, { name, version, batch, afterSelect }) {
  const stats = { rewrapped: 0, skipped: 0, failed: 0 };
  const mark = Buffer.from(`vault:v${version}:`, 'ascii');
  const aad = Buffer.from(target.aad).toString('base64');
  let position = null;
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, ${ident(target.column)} AS value FROM ${ident(target.table)}
        WHERE ${ident(target.column)} IS NOT NULL
          AND substring(${ident(target.column)} from 1 for $1) <> $2
          AND ($3::uuid IS NULL OR id > $3::uuid)
        ORDER BY id LIMIT $4`,
      [mark.length, mark, position, batch],
    );
    if (rows.length === 0) return stats;
    await afterSelect?.(rows);
    for (const row of rows) {
      position = row.id;
      const text = row.value.toString('latin1');
      if (!text.startsWith('vault:v')) {
        throw new Error('есть записи прежнего формата: сначала перенос crypto-migrate');
      }
      const next = await repack(call, name, text, aad);
      if (next === null) {
        stats.failed += 1;
        continue;
      }
      const { rowCount } = await db.query(
        `UPDATE ${ident(target.table)} SET ${ident(target.column)} = $2
          WHERE id = $1 AND ${ident(target.column)} = $3`,
        [row.id, next, row.value],
      );
      if (rowCount === 1) stats.rewrapped += 1;
      else stats.skipped += 1;
    }
  }
}

/** Сверка всей таблицы: сколько записей ещё не на нужной версии. */
export async function behindVersion(db, target, version) {
  const mark = Buffer.from(`vault:v${version}:`, 'ascii');
  const { rows } = await db.query(
    `SELECT count(*)::int AS behind FROM ${ident(target.table)}
      WHERE ${ident(target.column)} IS NOT NULL
        AND substring(${ident(target.column)} from 1 for $1) <> $2`,
    [mark.length, mark],
  );
  return rows[0].behind;
}
