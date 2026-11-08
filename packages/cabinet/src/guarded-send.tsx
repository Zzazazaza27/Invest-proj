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
 * Завершают операцию только ответ с результатом, явный отказ сервера на первую отправку
 * (ничего не записано) и явный отказ человека от проверки.
 */
export type GuardedPhase =
  'idle' | 'sending' | 'checking' | 'unknown' | 'login' | 'unavailable' | 'unreadable' | 'expired';

/** Чей ключ: метка другого пользователя в этой вкладке не трогается и не выясняется. */
let owner: string | null = null;
export function setGuardOwner(id: string | null): void {
  owner = id;
}

interface Pending {
  key: string;
  /** Отправленное. `null` — страница перезагружена, известен только ключ. */
  payload: unknown;
  at: number;
  /** Ответ на запись пришёл, но не прочитан: повтор вернёт его же — выяснять по ключу. */
  unreadable?: boolean;
}

/** Ключ и снимок вне компонента: закрытие формы их не теряет. */
const memory = new Map<string, Pending>();
const MARK = 'fifth.pending.';

function readMark(scope: string): { key: string; owner: string; at: number } | null {
  try {
    const raw = window.sessionStorage.getItem(MARK + scope);
    return raw ? (JSON.parse(raw) as { key: string; owner: string; at: number }) : null;
  } catch {
    return null;
  }
}
function writeMark(scope: string, p: Pending): void {
  try {
    window.sessionStorage.setItem(MARK + scope, JSON.stringify({ key: p.key, owner, at: p.at }));
  } catch {
    // Без хранилища вкладки остаётся память страницы: закрытие формы всё равно не теряет ключ.
  }
}
function clearMark(scope: string): void {
  try {
    window.sessionStorage.removeItem(MARK + scope);
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
  /** Ответ-отказ: ввод остаётся на странице, новая попытка — с новым ключом. */
  onFail: (error: unknown) => void;
}) {
  const opts = useRef(options);
  opts.current = options;
  const { scope } = options;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phase, setPhase] = useState<GuardedPhase>('idle');
  const [pending, setPending] = useState<Pending | null>(() => memory.get(scope) ?? null);
  /** Итог выяснения по ключу, когда показывать нечего: «не дошла». */
  const [note, setNote] = useState<'not_delivered' | null>(null);

  const finish = useCallback(() => {
    memory.delete(scope);
    clearMark(scope);
    setPending(null);
    setPhase('idle');
  }, [scope]);

  const run = useCallback(
    async (mode: 'first' | 'check' | 'auto'): Promise<void> => {
      const current = memory.get(scope);
      if (!current) return;
      setPhase(mode === 'first' ? 'sending' : 'checking');
      setNote(null);
      try {
        // Снимок есть и ответ не «нечитаемый» — повтор того же запроса тем же ключом:
        // сервер вернёт прежний результат либо выполнит работу один раз. Иначе — только
        // исход по ключу.
        if (current.payload !== null && !current.unreadable) {
          const result = await opts.current.send(current.payload as P, current.key);
          finish();
          opts.current.onDone(result, current.payload as P);
          return;
        }
        const answer = await opts.current.state(current.key);
        finish();
        if (answer.state === 'done') opts.current.onResolved(answer.resultId, answer.objectId);
        else setNote('not_delivered');
      } catch (error) {
        const outcome = classify(error, mode === 'first');
        if (outcome.kind === 'final') {
          finish();
          opts.current.onFail(error);
          return;
        }
        if (outcome.phase === 'unreadable') current.unreadable = true;
        setPhase(outcome.phase);
        if (mode === 'first' && outcome.phase === 'unknown' && timer.current === null) {
          // Одна проверка сама: короткий обрыв обычно выясняется сразу.
          timer.current = setTimeout(() => {
            timer.current = null;
            void run('auto');
          }, AUTO_CHECK_MS);
        }
      }
    },
    [scope, finish],
  );

  // Возвращение к незавершённой операции: после закрытия формы (память страницы) или после
  // входа и перезагрузки (метка вкладки этого же владельца). Исход выясняется сам.
  useEffect(() => {
    let current = memory.get(scope);
    if (!current) {
      const mark = readMark(scope);
      if (!mark || mark.owner !== owner) {
        // Другая область (например, другое обращение): незавершённой операции здесь нет.
        setPending(null);
        setPhase('idle');
        return;
      }
      current = { key: mark.key, payload: null, at: mark.at };
      memory.set(scope, current);
    }
    setPending(current);
    setPhase('unknown');
    void run('auto');
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    // Только при появлении формы или смене области; `run` зависит от неё же.
  }, [scope, run]);

  /** Отправить. Пока прежняя отправка не выяснена — только её проверка. */
  const submit = useCallback(
    (payload: P): Promise<void> => {
      if (memory.has(scope)) return run('check');
      const created: Pending = { key: crypto.randomUUID(), payload, at: Date.now() };
      memory.set(scope, created);
      writeMark(scope, created);
      setPending(created);
      return run('first');
    },
    [scope, run],
  );

  const check = useCallback(() => run('check'), [run]);

  /** Явный отказ человека от проверки: дальше — новая отправка с новым ключом. */
  const abandon = useCallback(() => {
    finish();
    setNote(null);
  }, [finish]);

  const unresolved = pending !== null && phase !== 'sending';
  return {
    submit,
    check,
    abandon,
    phase,
    note,
    busy: phase === 'sending' || phase === 'checking',
    unresolved,
    /** Отправленное, пока результат не выяснен; `null` — после перезагрузки снимка нет. */
    snapshot: (pending?.payload ?? null) as P | null,
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
  if (guard.note === 'not_delivered') {
    return (
      <Alert tone="info" data-guarded="not_delivered">
        Прошлая отправка не дошла до сервера — ничего не сохранено. Заполните форму заново.
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
