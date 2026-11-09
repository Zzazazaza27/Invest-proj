/**
 * Состояние выпуска для наблюдения (блок 09, задание 4; уточнения Тэнка 09.11).
 *
 * Чистая функция: вход — что прочитано из реестра установок, журнала шагов и состояния
 * слотов; выход — вывод для Zabbix: `ok` | `problem` | `unknown` и список причин.
 *
 *  - Зависание — нет продвижения (новой записи журнала) дольше порога сверх ожидаемого срока
 *    текущего этапа. Ожидание окна наблюдения или завершения старого ядра — не зависание,
 *    пока не вышел его объявленный срок. Работающий процесс продвижения не доказывает.
 *  - Сосуществование версий во время выпуска — норма. Ошибка — нарушение ожидаемого
 *    состояния этапа: фон в двух слотах, фон не у владельца разрешения, после выпуска маршрут
 *    и ответ через nginx расходятся.
 *  - Источник не прочитан (база, журнал, слоты) — `unknown`, а не «проблем нет».
 */

export const STALL_MS = 30 * 60_000;

/** Ожидаемый срок этапа по записи его начала: `expectMs` объявляет сам установщик. */
const expectedOf = (event) => (Number.isFinite(event?.expectMs) ? event.expectMs : 0);

/**
 * @param input {
 *   db: { ok, error?, running: [{ id, env, build, startedAt }], last: { id, status, kind, detail, finishedAt } | null },
 *   journal: { ok, error?, events: [{ at, op, stage, status, detail?, expectMs? }] },
 *   slots: null | { ok, error?, route: { slot, build } | null, grant: { owner } | null,
 *                   background: { 'core-a': mode, 'core-b': mode }, via: { slot, build } | null },
 * }
 */
export function releaseState(input, now = Date.now(), { stallMs = STALL_MS } = {}) {
  const problems = [];
  const unknown = [];
  const { db, journal, slots } = input;

  if (!db?.ok) unknown.push(`реестр установок не прочитан: ${db?.error ?? 'нет ответа'}`);
  if (!journal?.ok) unknown.push(`журнал выпуска не прочитан: ${journal?.error ?? 'нет ответа'}`);
  if (slots && !slots.ok)
    unknown.push(`состояние слотов не прочитано: ${slots.error ?? 'нет ответа'}`);

  const running = db?.ok ? db.running : [];
  const inRelease = running.length > 0;

  // 1. Зависание: последняя запись журнала операции и ожидаемый срок её этапа.
  if (db?.ok && journal?.ok) {
    for (const op of running) {
      const events = journal.events.filter((e) => e.op === op.id);
      const last = events.at(-1);
      const since = Date.parse(last?.at ?? op.startedAt);
      const allowed = stallMs + expectedOf(last);
      if (Number.isFinite(since) && now - since > allowed) {
        problems.push({
          code: 'stalled',
          text: `выпуск ${op.build} без продвижения ${Math.round((now - since) / 60_000)} мин (этап ${last?.stage ?? 'начало'}, допустимо ${Math.round(allowed / 60_000)})`,
        });
      }
    }
  }

  // 2. Последний исход: неудача или возврат держат проблему до следующей успешной установки.
  if (db?.ok && db.last && !inRelease) {
    if (db.last.status === 'failed') {
      problems.push({
        code: 'failed',
        text: `выпуск ${db.last.id} не удался: ${db.last.detail ?? ''}`.trim(),
      });
    } else if (db.last.kind === 'rollback') {
      problems.push({ code: 'rolled-back', text: `последняя установка — возврат (${db.last.id})` });
    }
  }

  // 3. Отказ в наблюдении без разрешённого возврата — решение за человеком.
  // Только последняя операция журнала: следующий удачный выпуск снимает проблему.
  if (journal?.ok && journal.events.length) {
    const lastOp = journal.events.at(-1).op;
    const last = journal.events.filter((e) => e.op === lastOp).at(-1);
    if (last.stage === 'observe' && last.status === 'fail') {
      problems.push({
        code: 'observe-failed',
        text: `выпуск ${lastOp}: отказ в наблюдении, решение за Томасом`,
      });
    }
  }

  // 4. Слоты: ожидаемое состояние по этапу.
  if (slots?.ok) {
    const bg = slots.background ?? {};
    const runningBg = Object.entries(bg)
      .filter(([, m]) => m === 'running')
      .map(([s]) => s);
    const silent = Object.entries(bg)
      .filter(([, m]) => m === 'нет ответа')
      .map(([s]) => s);
    if (runningBg.length > 1) {
      problems.push({
        code: 'two-backgrounds',
        text: `фон идёт в двух слотах: ${runningBg.join(', ')}`,
      });
    }
    const owner = slots.grant?.owner ?? null;
    if (runningBg.length === 1 && runningBg[0] !== owner) {
      problems.push({
        code: 'background-owner',
        text: `фон у ${runningBg[0]}, разрешение у ${owner ?? 'никого'}`,
      });
    }
    if (!inRelease) {
      // Вне выпуска: у владельца фон идёт, маршрут и ответ через nginx совпадают.
      if (owner && bg[owner] !== 'running') {
        if (silent.includes(owner)) unknown.push(`фон активного слота ${owner} не ответил`);
        else
          problems.push({
            code: 'background-stopped',
            text: `фон активного слота ${owner}: ${bg[owner] ?? 'нет'}`,
          });
      }
      if (!slots.via) unknown.push('ответ через nginx не получен');
      else if (
        slots.route &&
        (slots.via.slot !== slots.route.slot || slots.via.build !== slots.route.build)
      ) {
        problems.push({
          code: 'route-mismatch',
          text: `маршрут ${slots.route.slot}/${slots.route.build}, через nginx отвечает ${slots.via.slot}/${slots.via.build}`,
        });
      }
    }
  }

  const verdict = problems.length ? 'problem' : unknown.length ? 'unknown' : 'ok';
  return {
    at: new Date(now).toISOString(),
    verdict,
    // Zabbix: 0 — ok, 1 — проблема, 2 — неизвестно.
    code: verdict === 'ok' ? 0 : verdict === 'problem' ? 1 : 2,
    inRelease,
    problems,
    unknown,
  };
}
