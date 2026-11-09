import { readFileSync } from 'node:fs';

/**
 * Разрешение фоновой работы слоту (блок 09, задание 3; Тэнк 09.11).
 *
 * Файл пишет только установщик и только по подтверждённому состоянию:
 *  - перед паузой старого слота — `owner: null` (пауза переживает перезапуск);
 *  - после переключения, подтверждённого запросом через nginx, — `owner: <кандидат>`.
 * Файл маршрута nginx разрешением не является: между его записью и подтверждением он
 * уже указывает кандидата, а запросы ещё может обслуживать прежняя версия.
 *
 * Слот читает файл при старте процесса и перед продолжением по команде. Неоднозначное
 * состояние — нет файла, не JSON, неизвестный формат, владелец другой — фон не запускается.
 *
 *   { "format": 1, "owner": "core-a" | "core-b" | null, "at": "<ISO>", "op": "<id выпуска>" }
 */
export type GrantVerdict =
  { granted: true; op: string | null } | { granted: false; reason: string };

export function readGrant(file: string, slot: string): GrantVerdict {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { granted: false, reason: `файл разрешения не читается: ${(error as Error).message}` };
  }
  let grant: unknown;
  try {
    grant = JSON.parse(text);
  } catch {
    return { granted: false, reason: 'файл разрешения не JSON' };
  }
  const g = grant as { format?: unknown; owner?: unknown; op?: unknown };
  if (g.format !== 1) return { granted: false, reason: 'неизвестный формат разрешения' };
  if (g.owner !== null && typeof g.owner !== 'string') {
    return { granted: false, reason: 'владелец в разрешении не назван' };
  }
  if (g.owner !== slot) {
    return { granted: false, reason: g.owner ? `фон разрешён слоту ${g.owner}` : 'фон на паузе' };
  }
  return { granted: true, op: typeof g.op === 'string' ? g.op : null };
}
