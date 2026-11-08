import type { GroupMode, GroupReason, GroupStatus, RestrictionMode } from '@fifth/contracts';

/**
 * Правила доступности групп функций (блок 4, 4.11) — без ввода-вывода, чтобы проверять их
 * модульно.
 *
 * Наблюдение — результат служебной проверки зависимости одним экземпляром в одном режиме
 * (чтение или запись) с пределом актуальности. Сведение по экземплярам:
 *
 *   * учитываются только свежие наблюдения работающих экземпляров: остановленный и
 *     просроченный не дают ни доступности, ни отказа;
 *   * свежих нет — «неизвестно», а не «доступна»;
 *   * хоть один свежий исправен — зависимость работает (обслуживать есть кому);
 *   * отказ — только если свежий отказ у всех обслуживающих; просроченный, но не исключённый
 *     экземпляр (см. `isRetired`) делает итог «неизвестно».
 *
 * Итог для действия = продуктовый допуск ∧ ручное ограничение ∧ исправность зависимости.
 * Ручной запрет автоматическим восстановлением не снимается. Изменение при «неизвестно» не
 * разрешается вслепую; чтение при «неизвестно» разрешено — проверит само себя.
 */
export interface Observation {
  instance: string;
  mode: GroupMode;
  ok: boolean;
  reason: GroupReason;
  observedAt: Date;
  validUntil: Date;
  stopped: boolean;
}

export type Health = 'ok' | 'fail' | 'unknown';

export interface DependencyState {
  health: Health;
  reason: GroupReason;
  observedAt: Date | null;
}

const latest = (items: Observation[]): Date | null =>
  items.reduce<Date | null>((m, o) => (m === null || o.observedAt > m ? o.observedAt : m), null);

export function isFresh(o: Observation, now: Date): boolean {
  return !o.stopped && o.validUntil > now;
}

/**
 * Экземпляр исключён из обслуживания: остановлен штатно или молчит дольше горизонта
 * `retireAfterMs`. Работающий экземпляр проверяет зависимость каждые 30 с, поэтому молчание
 * дольше горизонта (по умолчанию 10 мин) значит, что он не обслуживает запросы — например,
 * упал без штатной остановки. До горизонта такой экземпляр может ещё обслуживать.
 */
export function isRetired(o: Observation, now: Date, retireAfterMs: number): boolean {
  return o.stopped || now.getTime() - o.observedAt.getTime() > retireAfterMs;
}

/**
 * Сведение наблюдений одного режима по всем экземплярам.
 *
 * Отказ объявляется, только когда он подтверждён у ВСЕХ обслуживающих: свежий отказ одного
 * при просроченном наблюдении другого, ещё не исключённого, — «неизвестно», а не «отказ».
 */
export function dependencyState(
  all: Observation[],
  mode: GroupMode,
  now: Date,
  retireAfterMs = Number.POSITIVE_INFINITY,
): DependencyState {
  const ofMode = all.filter((o) => o.mode === mode);
  const serving = ofMode.filter((o) => !isRetired(o, now, retireAfterMs));
  const fresh = serving.filter((o) => isFresh(o, now));
  const ok = fresh.filter((o) => o.ok);
  if (ok.length > 0) return { health: 'ok', reason: 'ok', observedAt: latest(ok) };
  if (fresh.length === 0 || fresh.length < serving.length) {
    return { health: 'unknown', reason: 'observations_stale', observedAt: latest(ofMode) };
  }
  const reason = fresh.find((o) => o.reason !== 'ok')?.reason ?? 'dependency_failure';
  return { health: 'fail', reason, observedAt: latest(fresh) };
}

export interface Restriction {
  mode: RestrictionMode;
}

/** Итоговое состояние группы для действий и показа. */
export function groupStatus(input: {
  read: DependencyState;
  write: DependencyState;
  restriction: Restriction | null;
  productEnabled?: boolean;
}): GroupStatus {
  const { read, write, restriction } = input;
  const enabled = input.productEnabled ?? true;
  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  const manualWrite = restriction !== null; // и «только чтение», и «недоступна» закрывают запись
  const manualRead = restriction?.mode === 'unavailable';

  const writeAllowed = enabled && !manualWrite && write.health === 'ok';
  const readAllowed = enabled && !manualRead && read.health !== 'fail';

  const writeReason: GroupReason = manualWrite
    ? 'manual_restriction'
    : write.health === 'ok'
      ? 'ok'
      : write.reason;
  const readReason: GroupReason = manualRead
    ? 'manual_restriction'
    : read.health === 'fail'
      ? read.reason
      : read.health === 'unknown'
        ? 'observations_stale'
        : 'ok';

  let state: GroupStatus['state'];
  if (!readAllowed) state = 'unavailable';
  else if (writeAllowed) state = read.health === 'ok' ? 'available' : 'unknown';
  else if (!manualWrite && write.health === 'unknown') state = 'unknown';
  else state = 'read_only';

  return {
    state,
    read: { allowed: readAllowed, reason: readReason, observedAt: iso(read.observedAt) },
    write: { allowed: writeAllowed, reason: writeReason, observedAt: iso(write.observedAt) },
  };
}

/**
 * Размыкатель в экземпляре, отдельно для чтения и записи: после `failures` технических
 * отказов за `windowMs` режим закрывается на `openMs`; дальше решает следующая служебная
 * проверка (контролируемая проба восстановления). Ошибки ввода и бизнес-правил сюда не
 * попадают — их не сообщают.
 */
export class Breaker {
  private readonly failuresAt: Record<GroupMode, number[]> = { read: [], write: [] };
  private readonly openUntil: Record<GroupMode, number> = { read: 0, write: 0 };

  constructor(
    private readonly options: { failures: number; windowMs: number; openMs: number },
    private readonly clock: () => number = Date.now,
  ) {}

  record(mode: GroupMode, ok: boolean): void {
    const now = this.clock();
    if (ok) {
      this.failuresAt[mode] = [];
      return;
    }
    const recent = this.failuresAt[mode].filter((t) => now - t < this.options.windowMs);
    recent.push(now);
    this.failuresAt[mode] = recent;
    if (recent.length >= this.options.failures) this.openUntil[mode] = now + this.options.openMs;
  }

  /** Проба восстановления: успешная служебная проверка закрывает размыкатель досрочно. */
  probe(mode: GroupMode, ok: boolean): void {
    if (ok) {
      this.openUntil[mode] = 0;
      this.failuresAt[mode] = [];
    } else {
      this.record(mode, false);
    }
  }

  isOpen(mode: GroupMode): boolean {
    return this.clock() < this.openUntil[mode];
  }
}
