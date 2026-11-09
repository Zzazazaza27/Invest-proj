/**
 * Единое правило допустимости возврата (блок 09, 9.2–9.3; Тэнк, 09.11).
 *
 * Возврат с комплекта `currentKit` на `targetKit` при схеме, в которой есть миграции
 * `unknown`, незнакомые целевому комплекту:
 *  - среди них contract-миграция — запрет: прежний код опирается на удалённое, только
 *    исправление вперёд. Пройденный прогон совместимости запрет не снимает;
 *  - иначе нужен пройденный отчёт совместимости этой пары комплектов (`report`, уже сверенный
 *    по хешам вызывающим), покрывающий все незнакомые миграции. Отсутствие признака contract
 *    совместимости не доказывает.
 *
 * Одно правило и для отметки точки возврата при установке, и для самого возврата
 * (scripts/release.mjs): отметка «проверена» означает ровно то, что возврат будет разрешён.
 * Без побочных эффектов — проверяется scripts/check-rollback-policy.mjs.
 */
export function rollbackVerdict(currentKit, unknown, report) {
  if (unknown.length === 0) return { allowed: true, reason: 'миграций нет' };
  const contract = currentKit.migrations.filter((m) => unknown.includes(m.id) && m.contract);
  if (contract.length > 0) {
    return {
      allowed: false,
      forbidden: true,
      reason: `contract-миграции ${contract.map((m) => m.id).join(', ')} — только исправление вперёд (9.3)`,
    };
  }
  const covered = new Set(report?.newMigrations ?? []);
  if (report?.result !== 'ok' || !unknown.every((m) => covered.has(m))) {
    const list = `${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}`;
    const state = report
      ? report.result === 'ok'
        ? 'не покрывает все'
        : `«${report.result}»`
      : 'отсутствует';
    return {
      allowed: false,
      reason: `${unknown.length} незнакомых миграций (${list}), отчёт совместимости ${state}`,
    };
  }
  return { allowed: true, reason: 'прогон совместимости: ok' };
}
