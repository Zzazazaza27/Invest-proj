/**
 * Ограничение служебной учётки мониторинга (требование 2.5: только чтение
 * контрольных данных; 2.1-W08a — замечание Тэнка при приёмке).
 *
 * Роль investor учётке нужна, чтобы читать контрольный проект ОБЫЧНЫМ путём —
 * через выданное разрешение и RLS. Но роль сама по себе действий не
 * ограничивает. Поэтому для учётки с происхождением `monitoring` действует
 * перечень разрешённого: сессия и чтение проекта с тем же происхождением.
 * Всё остальное — отказ, даже если учётке по ошибке выдали разрешение на
 * обычный проект. Обычные проверки доступа при этом остаются: перечень их
 * только сужает.
 */
/** Причина отказа в ответе: её видит только сама служебная учётка. */
export const MONITORING_DENIED = 'Служебная учётка мониторинга: действие не разрешено';

const UUID = '[0-9a-fA-F-]{36}';
const PROJECT_READS = [
  new RegExp(`^/v1/projects/(${UUID})/investor-view$`),
  new RegExp(`^/v1/projects/(${UUID})/materials/${UUID}/content$`),
];
const SESSION = new Set(['GET /v1/auth/me', 'POST /v1/auth/logout']);

export type MonitoringDecision =
  { allowed: true; projectId: string | null } | { allowed: false; reason: string };

/** Что разрешено учётке мониторинга: решение по методу и пути, без БД. */
export function monitoringAccountRoute(method: string, url: string): MonitoringDecision {
  const path = url.split('?')[0] ?? '';
  const m = method.toUpperCase();
  if (SESSION.has(`${m} ${path}`)) return { allowed: true, projectId: null };
  if (m === 'GET') {
    for (const re of PROJECT_READS) {
      const match = path.match(re);
      if (match) return { allowed: true, projectId: match[1]!.toLowerCase() };
    }
  }
  return { allowed: false, reason: 'служебная учётка мониторинга: действие не разрешено' };
}

/** Кеш признаков на минуту: проверка на каждом запросе не идёт в БД заново. */
export class TtlFlags {
  private readonly cache = new Map<string, { value: boolean; until: number }>();
  constructor(private readonly ttlMs = 60_000) {}
  async get(key: string, load: () => Promise<boolean>): Promise<boolean> {
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = await load();
    this.cache.set(key, { value, until: Date.now() + this.ttlMs });
    return value;
  }
}
