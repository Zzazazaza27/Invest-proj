import type { Tx } from '../db/unit-of-work';

/**
 * Сезонный контур отложен (решение владельца 2026-09-18, M088). Одна точка
 * чтения флага `seasons.enabled` для ядра: `lab.seasons_enabled()` доступна
 * любой роли БД, поэтому её можно звать и из публичной, и из интеграционной
 * транзакции. Пока флаг выключен: роль organizer вырезается из сессии,
 * публичные сезонные выдачи и подача «в сезон» отвечают «функция недоступна».
 */
export const SEASONS_FLAG = 'seasons.enabled';

export async function seasonsEnabled(tx: Tx): Promise<boolean> {
  const { rows } = await tx.query<{ enabled: boolean }>('SELECT lab.seasons_enabled() AS enabled');
  return rows[0]?.enabled === true;
}
