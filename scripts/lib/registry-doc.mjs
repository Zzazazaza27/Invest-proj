/**
 * Читаемое представление реестра проверок.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Текст строит одна функция, и пользуются ею двое:
 * генератор (`npm run docs:registry`) пишет файл, а самопроверка
 * (`npm run check:registry`) сравнивает написанное с тем, что получилось бы
 * сейчас. Поэтому документ не может разойтись с реестром: расхождение —
 * красный прогон, а не чьё-то открытие через полгода.
 *
 * Единый источник — `docs/testing/registry.yaml`. Этот текст из него
 * выводится и руками не правится.
 */

const KIND_TITLE = {
  check: 'Проверки поведения (`check-*`)',
  render: 'Браузерные проходы (`render-check-*`)',
  scenario: 'Связанные сценарии (`scenario-*`)',
  smoke: 'Дымовые проходы (`smoke-*`)',
  probe: 'Пробы (`probe-*`)',
  gate: 'Гейты и статические проверки',
  'db-test': 'Тесты схемы базы',
  'ci-step': 'Задания CI',
  tool: 'Инструменты (не проверки)',
};

const RUNNER_TITLE = {
  ci: 'CI',
  manual: 'вручную',
  'manual-tool': 'вручную, по поводу',
};

const CONFIRM_TITLE = {
  'confirmed-by-run': 'запущено',
  'reviewed-in-code': 'прочитано в коде',
  'needs-study': 'нужен разбор',
  blocked: 'заблокировано',
  'not-run': 'не запускалось',
};

/** Первая фраза назначения: таблице нужна строка, а не абзац. */
function shortPurpose(entry) {
  const text = String(entry.purpose ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const dot = text.indexOf('. ');
  const first = dot > 0 ? text.slice(0, dot + 1) : text;
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/** Одна клетка «где запускается»: набор, CI или ничто. */
function whereRun(id, suiteOf, runner) {
  const names = suiteOf.get(id) ?? [];
  if (names.length > 0) return names.map((s) => `\`suite:${s}\``).join(', ');
  if (runner === 'ci') return 'CI';
  return '—';
}

export function renderRegistryDoc(registry) {
  const checks = registry.checks ?? [];
  const requirements = registry.requirements ?? [];
  const suites = registry.suites ?? {};
  const manual = registry.manualByDesign ?? [];
  const manualById = new Map(manual.map((m) => [m.id, m.reason]));

  const suiteOf = new Map();
  for (const [name, suite] of Object.entries(suites)) {
    for (const id of suite.members ?? []) {
      if (!suiteOf.has(id)) suiteOf.set(id, []);
      suiteOf.get(id).push(name);
    }
  }

  const L = [];
  L.push('# Реестр проверок — читаемое представление');
  L.push('');
  L.push('> Файл СГЕНЕРИРОВАН из `docs/testing/registry.yaml` командой');
  L.push('> `npm run docs:registry`. Править руками бессмысленно:');
  L.push('> `npm run check:registry` сравнивает его с реестром и краснеет при расхождении.');
  L.push('');
  L.push(
    `- Версия реестра: ${registry.version}, дата ${registry.date}, код \`${registry.commit}\``,
  );
  L.push(`- Обстановка: ${registry.environment}`);
  L.push(`- Проверок: ${checks.length}; требований: ${requirements.length}`);
  L.push('');

  // ------------------------------------------------------------- автоматика
  L.push('## Что защищено без участия человека');
  L.push('');
  L.push(`Задания CI: ${(registry.automation?.ci?.jobs ?? []).map((j) => `\`${j}\``).join(', ')}.`);
  L.push('');
  for (const line of registry.automation?.ci?.covers ?? []) L.push(`- ${line}`);
  L.push('');
  if (registry.automation?.ci?.note) L.push(registry.automation.ci.note.trim(), '');
  if (registry.automation?.manual?.note) L.push(registry.automation.manual.note.trim(), '');

  // ----------------------------------------------------------------- наборы
  L.push('## Наборы');
  L.push('');
  for (const [name, suite] of Object.entries(suites)) {
    L.push(`### \`${suite.command ?? `npm run suite:${name}`}\` — ${suite.title}`);
    L.push('');
    L.push(`Кто запускает: ${suite.runBy ?? 'не указано'}. Позиций: ${suite.members.length}.`);
    L.push('');
    for (const id of suite.members) {
      const entry = checks.find((c) => c.id === id);
      L.push(`- **${id}** — ${entry ? shortPurpose(entry) : 'собирательная позиция'}`);
    }
    L.push('');
    if (suite.note) L.push(`> ${suite.note.trim()}`, '');
  }

  // ------------------------------------------------------------- требования
  L.push('## Требования: что именно защищено');
  L.push('');
  // Два РАЗНЫХ утверждения в двух столбцах. Их путают постоянно, поэтому
  // сказано прямо: «не подтверждено» относится к чувствительности, а не к
  // тому, запускалась ли проверка и с каким итогом.
  L.push('«Подтверждение» — запускалась ли проверка и когда; её итог хранится в');
  L.push('отчёте запуска (`out/suites/`). «Чувствительность» — отдельное');
  L.push('утверждение: наблюдалась ли проверка КРАСНОЙ без починки.');
  L.push('«Не подтверждено» в последнем столбце не отменяет запуска и не делает');
  L.push('проверку бесполезной — оно значит, что неизвестно, что именно она ловит.');
  L.push('');
  const areas = [...new Set(requirements.map((q) => q.area))];
  for (const area of areas) {
    L.push(`### ${area[0].toUpperCase()}${area.slice(1)}`);
    L.push('');
    L.push('| Требование | Важность | Чем проверено | Подтверждение запуска | Чувствительность |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const q of requirements.filter((x) => x.area === area)) {
      const covered =
        (q.checks ?? []).length > 0 ? q.checks.map((c) => `\`${c}\``).join(', ') : '**НИЧЕМ**';
      const conf = CONFIRM_TITLE[q.confirmation] ?? q.confirmation ?? '—';
      const sens =
        q.sensitivity?.status === 'verified'
          ? `да (${q.sensitivity.date ?? 'без даты'}, ${q.sensitivity.commit ?? 'без версии'})`
          : // Не «бесполезна»: неизвестно, что она ловит, — это другое утверждение.
            'не подтверждено';
      L.push(
        `| **${q.id}** ${q.title} | ${q.severity} | ${covered} | ${conf}${
          q.confirmedOn ? ` ${q.confirmedOn}` : ''
        } | ${sens} |`,
      );
    }
    L.push('');
  }

  // -------------------------------------------------------- три честных списка
  L.push('## Разделение честности');
  L.push('');
  const gaps = requirements.filter((q) => (q.checks ?? []).length === 0);
  L.push(`### Требования без единой проверки — ${gaps.length}`);
  L.push('');
  for (const q of gaps) {
    L.push(`- **${q.id}** (${q.severity}) — ${q.title}`);
    if (q.rationale) L.push(`  - почему важно: ${q.rationale}`);
    if (q.limits) L.push(`  - что есть рядом: ${q.limits}`);
  }
  L.push('');

  const notInSuites = checks.filter(
    (c) =>
      c.runner !== 'ci' &&
      c.kind !== 'tool' &&
      c.kind !== 'ci-step' &&
      !suiteOf.has(c.id) &&
      !manualById.has(c.id),
  );
  L.push(`### Зарегистрированы, но ни в наборе, ни в CI — ${notInSuites.length}`);
  L.push('');
  L.push('Эти прогоны существуют и работают, но их никто не запускает ни по набору,');
  L.push('ни по расписанию. Зелёный набор о них ничего не говорит.');
  L.push('');
  for (const c of notInSuites) L.push(`- \`${c.id}\` — ${shortPurpose(c)}`);
  L.push('');

  L.push(`### Намеренно вручную — ${manual.length}`);
  L.push('');
  for (const m of manual) L.push(`- **${m.id}** — ${m.reason}`);
  L.push('');

  // --------------------------------------------------------------- перечень
  L.push('## Полный перечень проверок');
  L.push('');
  const kinds = [...new Set(checks.map((c) => c.kind))];
  for (const kind of kinds) {
    L.push(`### ${KIND_TITLE[kind] ?? kind}`);
    L.push('');
    L.push('| Идентификатор | Команда | Утверждений | Кто запускает | Где запускается |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const c of checks.filter((x) => x.kind === kind)) {
      /*
       * Прогон временного контура запускается НЕ объявленной командой, а
       * обёрткой: прямой запуск ушёл бы в рабочую базу и создал там
       * неудаляемые записи. В читаемом представлении показывается то, что
       * человек действительно наберёт.
       */
      const command = c.circuit === 'temp' ? `npm run temp:run -- ${c.file}` : c.command;
      const where =
        c.circuit === 'temp'
          ? `временный контур · ${whereRun(c.id, suiteOf, c.runner)}`
          : whereRun(c.id, suiteOf, c.runner);
      L.push(
        `| ${c.id} | \`${command}\` | ${c.asserts ?? 0} | ${RUNNER_TITLE[c.runner] ?? c.runner} | ${where} |`,
      );
    }
    L.push('');
  }

  return `${L.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
