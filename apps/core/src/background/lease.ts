import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/unit-of-work';

/**
 * Общая аренда строк работы (блок 1, 1.2).
 *
 * Таблица, работающая через аренду, имеет колонки `id`, `lease_id uuid` и
 * `lease_until timestamptz`. Прикладное состояние — в той же записи: загрузка
 * в записи загрузки, доставка в записи доставки.
 *
 * Главное отличие от прежней аренды публикатора и вебхуков: идентификатор
 * НОВЫЙ на каждый захват, а не постоянное имя экземпляра. Иначе прежняя
 * попытка того же процесса могла подтвердить строку, которую уже взял новый
 * захват. Публикатор и вебхуки переходят сюда при своей доработке (1.3.6).
 *
 * Аренда не гарантирует однократного выполнения: действие вне БД после потери
 * аренды условием в UPDATE не отменить. Прикладная операция повторяема и
 * проверяет результат перед повторным действием.
 *
 * `where` и `set` — фрагменты SQL из кода задачи, не из запроса пользователя.
 * Их параметры — `$1…$n`; параметры аренды добавляются после них.
 */

const IDENTIFIER = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

function table(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`недопустимое имя таблицы аренды: ${name}`);
  return name;
}

export interface Lease {
  readonly id: string;
  readonly leaseId: string;
}

/**
 * Захватить до `limit` свободных строк одним выражением: выбор и отметка
 * аренды не разделены окном, в которое ту же строку взял бы второй экземпляр.
 * Просроченная аренда считается свободной — упавший исполнитель не держит
 * работу вечно.
 */
export async function claimLeases(
  tx: Tx,
  options: {
    table: string;
    where: string;
    params?: readonly unknown[];
    orderBy?: string;
    limit: number;
    seconds: number;
  },
): Promise<Lease[]> {
  const params = [...(options.params ?? [])];
  const leaseId = randomUUID();
  const n = params.length;
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE ${table(options.table)} t
        SET lease_id = $${n + 1}::uuid,
            lease_until = now() + make_interval(secs => $${n + 2})
      WHERE t.id IN (
        SELECT id FROM ${table(options.table)}
         WHERE (${options.where})
           AND (lease_until IS NULL OR lease_until < now())
         ${options.orderBy ? `ORDER BY ${options.orderBy}` : ''}
         FOR UPDATE SKIP LOCKED
         LIMIT $${n + 3})
    RETURNING t.id`,
    [...params, leaseId, options.seconds, options.limit],
  );
  return rows.map((row) => ({ id: row.id, leaseId }));
}

/**
 * Продлить аренду, оставаясь её владельцем. `false` — аренда уже не наша:
 * истекла или перехвачена; дальнейшие действия по строке не начинать.
 */
export async function renewLease(
  tx: Tx,
  options: { table: string; lease: Lease; seconds: number },
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE ${table(options.table)}
        SET lease_until = now() + make_interval(secs => $3)
      WHERE id = $1 AND lease_id = $2::uuid AND lease_until > now()`,
    [options.lease.id, options.lease.leaseId, options.seconds],
  );
  return (rowCount ?? 0) === 1;
}

/**
 * Завершающая запись под арендой: проверка захвата и изменение — одно
 * выражение. Аренда снимается тем же UPDATE. `false` — захват не текущий или
 * срок истёк; результат прежнего исполнителя не подтверждается.
 */
export async function completeUnderLease(
  tx: Tx,
  options: { table: string; lease: Lease; set: string; params?: readonly unknown[] },
): Promise<boolean> {
  const params = [...(options.params ?? [])];
  const n = params.length;
  const { rowCount } = await tx.query(
    `UPDATE ${table(options.table)}
        SET ${options.set}, lease_id = NULL, lease_until = NULL
      WHERE id = $${n + 1} AND lease_id = $${n + 2}::uuid AND lease_until > now()`,
    [...params, options.lease.id, options.lease.leaseId],
  );
  return (rowCount ?? 0) === 1;
}
