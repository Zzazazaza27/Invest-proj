/**
 * Класс операций защищённого установщика. Чистые функции: все входы переданы явно.
 *
 * Автоматически меняются только образы core и web. Всё, что затрагивает данные, ключи или
 * права на узле, выходит за класс и идёт своим сценарием. Признак совместимости в манифесте
 * разрешением не считается: сверяется фактическое состояние среды.
 */
const buildParts = (build) => {
  const m = /^(\d+)\.(\d+)-b(\d+)\.(\d+)$/.exec(build ?? '');
  return m ? m.slice(1).map(Number) : null;
};

/** Отрицательное, если `a` старше `b`. Неверный номер — `null`. */
export function compareBuilds(a, b) {
  const [x, y] = [buildParts(a), buildParts(b)];
  if (!x || !y) return null;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sorted = (o) => Object.fromEntries(Object.entries(o ?? {}).sort());

/**
 * Причины отказа. Пустой список — сборка в классе.
 * `applied` — применённые миграции `{ id, checksum }`, `installed` — манифест текущей сборки.
 */
export function classProblems({ kit, installed, applied, policy }) {
  const problems = [];
  const order = compareBuilds(kit.build, installed.build);
  if (order === null) problems.push('неверный номер сборки');
  else if (order <= 0) problems.push(`сборка ${kit.build} не новее текущей ${installed.build}`);
  const floor = compareBuilds(installed.build, policy.rollbackFloor);
  if (floor === null || floor < 0) {
    problems.push(`текущая сборка ${installed.build} ниже порога возврата ${policy.rollbackFloor}`);
  }
  const known = new Map(applied.map((m) => [m.id, m.checksum]));
  const unapplied = kit.migrations.filter((m) => !known.has(m.id)).map((m) => m.id);
  if (unapplied.length) problems.push(`неприменённые миграции: ${unapplied.join(', ')}`);
  const changed = kit.migrations
    .filter((m) => known.has(m.id) && known.get(m.id) !== m.sha256)
    .map((m) => m.id);
  if (changed.length) problems.push(`изменённые миграции: ${changed.join(', ')}`);
  const inKit = new Set(kit.migrations.map((m) => m.id));
  const extra = applied.filter((m) => !inKit.has(m.id)).map((m) => m.id);
  if (extra.length) problems.push(`схема новее комплекта: ${extra.join(', ')}`);
  if (kit.postgresSource !== policy.postgresSource) problems.push('другой образ базы');
  if (!same(kit.compose?.sha256, installed.compose?.sha256)) problems.push('другой файл запуска');
  if (!same(sorted(kit.prodCompose), sorted(installed.prodCompose))) {
    problems.push('другие файлы рабочей среды');
  }
  if (kit.settingsVersion !== installed.settingsVersion) problems.push('другая версия настроек');
  return problems;
}

/** Хранимый комплект и подписанный манифест описывают одну сборку. */
export function sameKit(signed, stored) {
  const fields = (k) => ({
    build: k.build,
    commit: k.commit,
    digests: Object.fromEntries(Object.entries(k.images).map(([c, i]) => [c, i.digest])),
    migrations: k.migrations,
    compose: k.compose?.sha256,
    prodCompose: sorted(k.prodCompose),
    postgresSource: k.postgresSource,
  });
  return same(fields(signed), fields(stored));
}
