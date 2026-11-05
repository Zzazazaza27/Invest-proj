/**
 * Перенос записей в формат vault порциями (блок 5, задание 5).
 *
 * Прежняя запись и `vault:v1:` — одни и те же байты в другом порядке: импортированный ключ
 * остался версией 1. Поэтому шифровать заново нечего. Transit только подтверждает, что новая запись
 * открывается, открытое значение нигде не сохраняется.
 *
 * Запись идёт с условием «значение не менялось»: параллельно изменённая строка не перезаписывается.
 * Позиция ускоряет повтор, но завершения не доказывает: его доказывает только сверка всей таблицы.
 */
const IV = 12;
const TAG = 16;

export const MIGRATE_TARGETS = [
  {
    table: 'identity.users',
    column: 'contact_wrapped_dek',
    key: 'passport-sensitive',
    aad: 'wrap:passport_sensitive',
  },
  {
    table: 'kyc.business_entities',
    column: 'entity_wrapped_dek',
    key: 'kyb-documents',
    aad: 'wrap:kyb_documents',
  },
  {
    table: 'integration.webhook_endpoints',
    column: 'secret_ciphertext',
    key: 'webhook-secrets',
    aad: 'webhook:signing',
  },
];

const ident = (name) => {
  if (!/^[a-z_]+(\.[a-z_]+)?$/.test(name)) throw new Error('неверное имя');
  return name;
};
const OLD = (column) =>
  `${ident(column)} IS NOT NULL AND substring(${ident(column)} from 1 for 6) <> 'vault:'::bytea`;

export function legacyToVaultBytes(payload) {
  if (payload.length < IV + TAG) throw new Error('повреждённые данные: недостаточная длина');
  const iv = payload.subarray(0, IV);
  const tag = payload.subarray(IV, IV + TAG);
  const body = payload.subarray(IV + TAG);
  const raw = Buffer.concat([iv, body, tag]).toString('base64');
  return Buffer.from(`vault:v1:${raw}`, 'ascii');
}

/** Подтверждение через Transit. Открытое значение обнуляется сразу. */
async function opens(transit, target, prefix, value) {
  const plain = await transit(`${prefix}-${target.key}`, value.toString('ascii'), target.aad);
  plain.fill(0);
}

/** Одна таблица порциями. `afterSelect` — только для проверки гонки. */
export async function migrateTarget(
  db,
  transit,
  target,
  { prefix, batch, from, onPosition, afterSelect },
) {
  const stats = { converted: 0, skipped: 0, failed: 0 };
  let position = from ?? null;
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, ${ident(target.column)} AS value FROM ${ident(target.table)}
        WHERE ${OLD(target.column)} AND ($1::uuid IS NULL OR id > $1::uuid)
        ORDER BY id LIMIT $2`,
      [position, batch],
    );
    if (rows.length === 0) return stats;
    await afterSelect?.(rows);
    for (const row of rows) {
      position = row.id;
      let next;
      try {
        next = legacyToVaultBytes(row.value);
        await opens(transit, target, prefix, next);
      } catch (error) {
        // Отказ службы ключей останавливает перенос, а не помечает строки порчеными.
        if (error.unavailable) throw error;
        stats.failed += 1;
        continue;
      }
      const { rowCount } = await db.query(
        `UPDATE ${ident(target.table)} SET ${ident(target.column)} = $2
          WHERE id = $1 AND ${ident(target.column)} = $3`,
        [row.id, next, row.value],
      );
      if (rowCount === 1) stats.converted += 1;
      else stats.skipped += 1;
    }
    await onPosition?.(target, position);
  }
}

/** Сверка всей таблицы, независимо от позиции: старые значения и каждая новая запись. */
export async function verifyTarget(db, transit, target, { prefix }) {
  const { rows: count } = await db.query(
    `SELECT count(*) FILTER (WHERE ${OLD(target.column)})::int AS legacy,
            count(${ident(target.column)})::int AS total
       FROM ${ident(target.table)}`,
  );
  const { legacy, total } = count[0];
  let unreadable = 0;
  let position = null;
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, ${ident(target.column)} AS value FROM ${ident(target.table)}
        WHERE ${ident(target.column)} IS NOT NULL AND NOT (${OLD(target.column)})
          AND ($1::uuid IS NULL OR id > $1::uuid)
        ORDER BY id LIMIT 500`,
      [position],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      position = row.id;
      try {
        await opens(transit, target, prefix, row.value);
      } catch (error) {
        if (error.unavailable) throw error;
        unreadable += 1;
      }
    }
  }
  return { total, legacy, unreadable, complete: legacy === 0 && unreadable === 0 };
}
