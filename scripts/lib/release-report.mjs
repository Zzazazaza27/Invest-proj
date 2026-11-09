/**
 * Протокол выпуска (блок 09, задание 4; постановка 9.6): ID, среда, исполнитель и
 * разрешивший, комплекты до и после, миграции, этапы, маршрут, время, результаты проверок,
 * точка возврата. Источник — реестр установок и журналы, второго списка нет. Секретов нет:
 * в журналах их не бывает, но строки всё равно проходят фильтр на всякий случай.
 */

const SECRET = /(password|secret|token|key)=\S+/gi;
const clean = (s) => String(s ?? '').replace(SECRET, (m) => `${m.split('=')[0]}=***`);
const t = (iso) =>
  iso
    ? String(iso)
        .replace('T', ' ')
        .replace(/\.\d+Z?$/, '')
        .replace(/Z$/, '')
    : '—';
const dur = (a, b) => {
  const ms = Date.parse(b) - Date.parse(a);
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} с` : `${Math.round(s / 60)} мин`;
};

/**
 * @param d {
 *   installation: { id, env, build, commit_sha, expected_build, actor, approved_by, kind, status, detail, started_at, finished_at },
 *   events: [{ at, stage, result, detail }],            реестр (этапы установщика)
 *   slotEvents: [{ at, stage, status, detail }],         журнал слотов (если выпуск шёл слотами)
 *   migrations: [{ id, contract }],                      новые миграции комплекта
 *   rollbackPoint: { build, checked, reason } | null,
 *   route: { slot, build } | null,                       маршрут после выпуска
 *   incident: string | null,
 * }
 */
export function formatProtocol(d) {
  const i = d.installation;
  const lines = [];
  lines.push(`# Протокол выпуска ${i.id}`);
  lines.push('');
  lines.push(
    `Среда: ${i.env}. Вид: ${i.kind === 'rollback' ? 'возврат' : 'установка'}. Итог: ${i.status}${i.detail ? ` — ${clean(i.detail)}` : ''}.`,
  );
  lines.push(`Исполнитель: ${clean(i.actor)}. Разрешил: ${clean(i.approved_by)}.`);
  lines.push(
    `Время: ${t(i.started_at)} — ${t(i.finished_at)} UTC (${dur(i.started_at, i.finished_at)}).`,
  );
  lines.push('');
  lines.push('## Комплекты');
  lines.push(`- до: ${i.expected_build ?? 'нет'}`);
  lines.push(`- после: ${i.build} (коммит ${String(i.commit_sha ?? '').slice(0, 12)})`);
  if (d.rollbackPoint) {
    lines.push(
      `- точка возврата: ${d.rollbackPoint.build} — ${d.rollbackPoint.checked ? 'проверена' : 'НЕ проверена'} (${clean(d.rollbackPoint.reason)})`,
    );
  }
  lines.push('');
  lines.push('## Миграции');
  if (!d.migrations?.length) lines.push('- новых нет');
  for (const m of d.migrations ?? [])
    lines.push(`- ${m.id}${m.contract ? ' — contract (возврат за неё запрещён)' : ''}`);
  lines.push('');
  lines.push('## Этапы');
  for (const e of d.events ?? [])
    lines.push(`- ${t(e.at)} ${e.stage}: ${e.result}${e.detail ? ` — ${clean(e.detail)}` : ''}`);
  if (d.slotEvents?.length) {
    lines.push('');
    lines.push('## Переключение слотов');
    for (const e of d.slotEvents)
      lines.push(`- ${t(e.at)} ${e.stage}: ${e.status}${e.detail ? ` — ${clean(e.detail)}` : ''}`);
  }
  lines.push('');
  lines.push('## Маршрут и проверки');
  lines.push(
    `- маршрут после выпуска: ${d.route ? `${d.route.slot}, сборка ${d.route.build}` : 'одно ядро (без слотов)'}`,
  );
  const verify = (d.events ?? []).filter((e) => e.stage === 'verify');
  lines.push(
    `- сверка экземпляров: ${verify.length ? verify.map((e) => `${e.result} (${clean(e.detail)})`).join('; ') : 'не выполнялась'}`,
  );
  const confirm = (d.slotEvents ?? []).find((e) => e.stage === 'confirm');
  if (confirm) lines.push(`- подтверждение через nginx: ${confirm.status}`);
  const observe = (d.slotEvents ?? []).filter((e) => e.stage === 'observe').at(-1);
  if (observe)
    lines.push(
      `- наблюдение: ${observe.status}${observe.detail ? ` — ${clean(observe.detail)}` : ''}`,
    );
  lines.push('');
  lines.push(`Инцидент: ${d.incident ?? 'нет'}.`);
  return `${lines.join('\n')}\n`;
}
