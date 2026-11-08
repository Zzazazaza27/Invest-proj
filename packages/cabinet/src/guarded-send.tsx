import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button } from '@fifth/ui';
import type { GuardedOperationName, RequestKeyState } from '@fifth/contracts';
import { hrefFor } from './access';

/**
 * Защищённая отправка формы (блок 2, 2.2 и 2.6).
 *
 * Ключ повтора создаётся до первой отправки вместе со снимком отправленного содержимого.
 * Если ответ не получен или не прочитан, результат неизвестен: сервер мог успеть записать.
 * Пока он не выяснен:
 *
 *   * ни успеха, ни окончательной неудачи не показываем, новой отправки нет — форма заперта
 *     на отправленном, правка полей не превращает проверку во второй объект;
 *   * ошибка самой проверки (нужен вход, сервер недоступен, срок истёк) операцию не
 *     завершает: ключ остаётся, причина показывается отдельно;
 *   * закрытие формы ничего не сбрасывает: ключ и снимок живут вне компонента, в памяти
 *     страницы;
 *   * уход на вход и перезагрузка тоже: во вкладке (sessionStorage) остаётся МЕТКА —
 *     операция, ключ, владелец, время. Ввода в ней нет. После возвращения исход
 *     выясняется по ключу маршрутом состояния, без повтора работы.
 *
 * «Не найдена» по ключу не доказывает, что исходный запрос не выполнится позже: он мог
 * ждать соединения с базой. Поэтому ключ после этого ответа НЕ снимается: следующая
 * отправка идёт с ним же. Выполнится ровно одна из двух — поздняя исходная получит
 * конфликт ключа, а если она успела первой, конфликт получит новая, и кабинет по ключу
 * откроет выполненное.
 *
 * Память и метки разделены по владельцу и области: операция одного пользователя не
 * выясняется, не отправляется и не завершается от имени другого.
 *
 * Завершают операцию только ответ с результатом, ответ-отказ на первую отправку с новым
 * ключом (ничего не записано) и явный отказ человека от проверки.
 */
export type GuardedPhase =
  'idle' | 'sending' | 'checking' | 'unknown' | 'login' | 'unavailable' | 'unreadable' | 'expired';

/** Чей ключ: операция другого пользователя в этой вкладке не трогается и не выясняется. */
let owner: string | null = null;
export function setGuardOwner(id: string | null): void {
  owner = id;
}

interface Pending {
  owner: string | null;
  key: string;
  /** Отправленное. `null` — страница перезагружена или исход «не найдена». */
  payload: unknown;
  at: number;
  /** Ответ на запись пришёл, но не прочитан: повтор вернёт его же — выяснять по ключу. */
  unreadable?: boolean;
  /** По ключу «не найдена»: форма открыта, следующая отправка — с этим же ключом. */
  carried?: boolean;
}

/** Ключ и снимок вне компонента, по владельцу и области: закрытие формы их не теряет. */
const memory = new Map<string, Pending>();
const MARK = 'fifth.pending.';
const slot = (who: string | null, scope: string) => `${who ?? '-'}|${scope}`;

interface Mark {
  key: string;
  owner: string | null;
  at: number;
  carried?: boolean;
}
function readMark(name: string): Mark | null {
  try {
    const raw = window.sessionStorage.getItem(MARK + name);
    return raw ? (JSON.parse(raw) as Mark) : null;
  } catch {
    return null;
  }
}
function writeMark(name: string, p: Pending): void {
  try {
    const mark: Mark = { key: p.key, owner: p.owner, at: p.at, carried: p.carried };
    window.sessionStorage.setItem(MARK + name, JSON.stringify(mark));
  } catch {
    // Без хранилища вкладки остаётся память страницы: закрытие формы всё равно не теряет ключ.
  }
}
function clearMark(name: string): void {
  try {
    window.sessionStorage.removeItem(MARK + name);
  } catch {
    // нечего убирать
  }
}

type Outcome = { kind: 'final' } | { kind: 'keep'; phase: GuardedPhase };

/** Признаки неизвестного результата: обрыв, нечитаемый 2xx, «ещё выполняется». */
export function isOutcomeUnknown(error: unknown): boolean {
  const e = error as { outcomeUnknown?: boolean; code?: string } | null;
  return Boolean(e?.outcomeUnknown) || e?.code === 'operation_in_progress';
}

function classify(error: unknown, first: boolean): Outcome {
  const e = (error ?? {}) as { outcomeUnknown?: boolean; code?: string; status?: number };
  if (e.outcomeUnknown) {
    return { kind: 'keep', phase: e.code === 'internal_error' ? 'unreadable' : 'unknown' };
  }
  if (e.code === 'operation_in_progress') return { kind: 'keep', phase: 'unknown' };
  // Первая отправка получила ответ-отказ: сервер ничего не записал, ввод на странице.
  if (first) return { kind: 'final' };
  // Проверка тем же ключом: окончательны только ответы о самой операции.
  if (e.status === 401 || e.code === 'unauthenticated' || e.code === 'token_expired') {
    return { kind: 'keep', phase: 'login' };
  }
  if (e.code === 'idempotency_key_expired') return { kind: 'keep', phase: 'expired' };
  if (
    e.status === 400 ||
    e.status === 404 ||
    e.status === 422 ||
    e.code === 'conflict' ||
    e.code === 'idempotency_key_reused' ||
    e.code === 'state_transition_not_allowed'
  ) {
    return { kind: 'final' };
  }
  return { kind: 'keep', phase: 'unavailable' };
}

const AUTO_CHECK_MS = 1500;

export function useGuardedSend<P, R>(options: {
  /** Где живёт операция: имя и, если нужно, объект — `lab.material.link:<проект>`. */
  scope: string;
  operation: GuardedOperationName;
  send: (payload: P, key: string) => Promise<R>;
  /** Исход по ключу без повтора работы (после перезагрузки снимка нет). */
  state: (key: string) => Promise<RequestKeyState>;
  /** Результат получен ответом. */
  onDone: (result: R, payload: P) => void;
  /** Результат выяснен по ключу: показать его обычным путём, с проверкой прав. */
  onResolved: (resultId: string, objectId: string | null) => void;
  /** Ответ-отказ: ввод остаётся на странице. */
  onFail: (error: unknown) => void;
}) {
  const opts = useRef(options);
  opts.current = options;
  // Владелец берётся при каждом показе: после входа другого человека — его область.
  const name = slot(owner, options.scope);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phase, setPhase] = useState<GuardedPhase>('idle');
  const [pending, setPending] = useState<Pending | null>(() => memory.get(name) ?? null);
  /** «Не найдена» по ключу: форма открыта, ключ сохранён для следующей отправки. */
  const [note, setNote] = useState<'not_found' | 'earlier_done' | null>(null);

  const finish = useCallback(
    (slotName: string) => {
      memory.delete(slotName);
      clearMark(slotName);
      if (slotName === name) {
        setPending(null);
        setPhase('idle');
      }
    },
    [name],
  );

  const run = useCallback(
    async (mode: 'first' | 'check' | 'auto'): Promise<void> => {
      const slotName = name;
      const current = memory.get(slotName);
      if (!current) return;
      // Ответ пришёл уже другому пользователю вкладки: чужую операцию не трогаем.
      const stillMine = () => current.owner === owner && memory.get(slotName) === current;
      setPhase(mode === 'first' ? 'sending' : 'checking');
      setNote(null);
      try {
        // Снимок есть и ответ не «нечитаемый» — запрос тем же ключом: сервер вернёт прежний
        // результат либо выполнит работу один раз. Иначе — только исход по ключу.
        if (current.payload !== null && !current.unreadable) {
          const result = await opts.current.send(current.payload as P, current.key);
          if (!stillMine()) return;
          finish(slotName);
          opts.current.onDone(result, current.payload as P);
          return;
        }
        const answer = await opts.current.state(current.key);
        if (!stillMine()) return;
        if (answer.state === 'done') {
          finish(slotName);
          opts.current.onResolved(answer.resultId, answer.objectId);
          return;
        }
        // «Не найдена» — не «не выполнится»: ключ остаётся для следующей отправки.
        current.payload = null;
        current.carried = true;
        current.unreadable = false;
        writeMark(slotName, current);
        setPending({ ...current });
        setPhase('idle');
        setNote('not_found');
      } catch (error) {
        if (!stillMine()) return;
        // Новая отправка с перенесённым ключом получила «ключ занят другим содержимым»:
        // поздняя исходная успела выполниться — показываем её результат.
        if (current.carried && (error as { code?: string }).code === 'idempotency_key_reused') {
          try {
            const answer = await opts.current.state(current.key);
            if (stillMine() && answer.state === 'done') {
              finish(slotName);
              setNote('earlier_done');
              opts.current.onResolved(answer.resultId, answer.objectId);
              return;
            }
          } catch {
            // выясним позже кнопкой
          }
          setPhase('unknown');
          return;
        }
        const outcome = classify(error, mode === 'first');
        if (outcome.kind === 'final') {
          if (current.carried) {
            // Отказ новой отправке, но поздняя исходная ещё может прийти: ключ не снимаем.
            current.payload = null;
            writeMark(slotName, current);
            setPending({ ...current });
            setPhase('idle');
          } else {
            finish(slotName);
          }
          opts.current.onFail(error);
          return;
        }
        if (outcome.phase === 'unreadable') current.unreadable = true;
        setPhase(outcome.phase);
        if (mode === 'first' && outcome.phase === 'unknown' && timer.current === null) {
          // Одна проверка сама: короткий обрыв обычно выясняется сразу.
          timer.current = setTimeout(() => {
            timer.current = null;
            if (memory.get(slotName) === current) void run('auto');
          }, AUTO_CHECK_MS);
        }
      }
    },
    [name, finish],
  );

  // Возвращение к незавершённой операции этого владельца: после закрытия формы (память
  // страницы) или после входа и перезагрузки (метка вкладки). Исход выясняется сам.
  useEffect(() => {
    let current = memory.get(name);
    if (!current) {
      const mark = readMark(name);
      if (!mark || mark.owner !== owner) {
        setPending(null);
        setPhase('idle');
        setNote(null);
        return;
      }
      current = {
        owner: mark.owner,
        key: mark.key,
        payload: null,
        at: mark.at,
        carried: mark.carried,
      };
      memory.set(name, current);
    }
    setPending({ ...current });
    if (current.carried && current.payload === null) {
      // Уже «не найдена»: форма открыта, ключ ждёт следующей отправки.
      setPhase('idle');
      setNote('not_found');
    } else {
      setPhase('unknown');
      void run('auto');
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [name, run]);

  /** Отправить. Незавершённая — только проверка; «не найдена» — тем же ключом. */
  const submit = useCallback(
    (payload: P): Promise<void> => {
      const current = memory.get(name);
      if (current && current.carried && current.payload === null) {
        current.payload = payload;
        setPending({ ...current });
        return run('first');
      }
      if (current) return run('check');
      const created: Pending = { owner, key: crypto.randomUUID(), payload, at: Date.now() };
      memory.set(name, created);
      writeMark(name, created);
      setPending(created);
      return run('first');
    },
    [name, run],
  );

  const check = useCallback(() => run('check'), [run]);

  /** Явный отказ человека от проверки: дальше — новая отправка с новым ключом. */
  const abandon = useCallback(() => {
    finish(name);
    setNote(null);
  }, [finish, name]);

  const unresolved =
    pending !== null && !(pending.carried && pending.payload === null) && phase !== 'sending';
  return {
    submit,
    check,
    abandon,
    phase,
    note,
    busy: phase === 'sending' || phase === 'checking',
    unresolved,
    /** Отправленное, пока результат не выяснен; `null` — снимка нет. */
    snapshot: (unresolved ? (pending?.payload ?? null) : null) as P | null,
    pendingSince: pending?.at ?? null,
  };
}

const TEXT: Partial<Record<GuardedPhase, string>> = {
  checking: 'Проверяем, дошла ли отправка…',
  unknown:
    'Не удалось получить ответ сервера. Возможно, данные уже сохранены — сначала проверьте отправку.',
  login:
    'Чтобы проверить отправку, нужно войти снова. После входа она проверится сама и второй раз не выполнится.',
  unavailable:
    'Сейчас не удаётся проверить отправку: сервер недоступен. Отправка не потеряна — проверьте чуть позже.',
  unreadable:
    'Сервер принял отправку, но ответ не удалось прочитать. Проверьте результат, прежде чем отправлять снова.',
  expired:
    'Срок проверки этой отправки истёк. Посмотрите, появился ли результат, прежде чем отправлять снова.',
};

/** Сообщение о незавершённой отправке: проверка, вход, явный отказ. Показывать у формы. */
export function GuardedNotice({
  guard,
}: {
  guard: Pick<
    ReturnType<typeof useGuardedSend>,
    'phase' | 'note' | 'unresolved' | 'check' | 'abandon' | 'snapshot' | 'pendingSince'
  >;
}): React.ReactElement | null {
  if (guard.note === 'not_found') {
    return (
      <Alert tone="info" data-guarded="not_found">
        Прошлая отправка пока не найдена на сервере. Заполните форму и отправьте снова: если прошлая
        всё же дойдёт, второго экземпляра не будет.
      </Alert>
    );
  }
  if (guard.note === 'earlier_done') {
    return (
      <Alert tone="info" data-guarded="earlier_done">
        Прошлая отправка всё-таки дошла — открыт её результат. Новая не выполнялась.
      </Alert>
    );
  }
  if (!guard.unresolved) return null;
  const since =
    guard.pendingSince !== null
      ? new Date(guard.pendingSince).toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
  return (
    <Alert tone="warning" data-guarded={guard.phase}>
      <p>
        {TEXT[guard.phase] ?? TEXT.unknown}
        {guard.snapshot === null ? ` Отправка от ${since}.` : ''}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--u-space-2)' }}>
        {guard.phase === 'login' ? (
          <Button
            size="sm"
            onClick={() => window.location.assign(hrefFor('login'))}
            data-guarded-login
          >
            Войти
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void guard.check()}
            loading={guard.phase === 'checking'}
            data-guarded-check
          >
            Проверить отправку
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={guard.abandon} data-guarded-abandon>
          Отказаться и заполнить заново
        </Button>
      </div>
      <p style={{ margin: 0, fontSize: 'var(--u-text-sm)', color: 'var(--u-text-muted)' }}>
        Если отказаться, а отправка всё же дошла, появится второй экземпляр.
      </p>
    </Alert>
  );
}
