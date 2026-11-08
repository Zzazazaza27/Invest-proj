import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@fifth/ui';

/**
 * Уход со страницы (блок 2, 2.2/2.3).
 *
 * Общий блок сам не знает, что в форме несохранено, — признаки сообщает форма
 * (`useLeaveGuard`). Три вида, потому что и теряется при уходе разное:
 *
 *   * `dirty` — несохранённые поля. Черновиков нет: при переходе внутри кабинета, повторном
 *     входе и перезагрузке значения теряются;
 *   * `guarded` — защищённая отправка 2.6 ещё не завершена (результат неизвестен,
 *     проверяется). Ключ и снимок живут в памяти страницы вне компонента — переход внутри
 *     кабинета их не теряет; перезагрузка и вход оставляют только метку (ключ, владелец,
 *     время) в хранилище вкладки, закрытие вкладки — ничего;
 *   * `request` — обычный запрос без ключа повтора ещё выполняется: при уходе его результат
 *     может остаться неизвестным, и выяснить его по ключу нельзя.
 *
 * Возможности разные: переход внутри кабинета останавливает наш диалог (`LeaveDialog` +
 * блокировка маршрутизатора приложения), закрытие и перезагрузку вкладки — только
 * стандартный запрос браузера (`beforeunload`), его текст задаёт браузер.
 */
export interface LeaveSignals {
  dirty?: boolean;
  guarded?: boolean;
  request?: boolean;
}

const sources = new Map<string, LeaveSignals>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version += 1;
  listeners.forEach((fn) => fn());
};

/** Форма сообщает свои признаки; при размонтировании они снимаются. */
export function useLeaveGuard(name: string, signals: LeaveSignals): void {
  const { dirty = false, guarded = false, request = false } = signals;
  useEffect(() => {
    if (dirty || guarded || request) sources.set(name, { dirty, guarded, request });
    else sources.delete(name);
    notify();
    return () => {
      sources.delete(name);
      notify();
    };
  }, [name, dirty, guarded, request]);
}

export interface LeaveState {
  dirty: boolean;
  guarded: boolean;
  request: boolean;
}

export function leaveState(): LeaveState {
  const all = [...sources.values()];
  return {
    dirty: all.some((s) => s.dirty),
    guarded: all.some((s) => s.guarded),
    request: all.some((s) => s.request),
  };
}

/** Разовый пропуск перехода, который кабинет делает сам по итогу операции. */
let allowUntil = 0;

/**
 * Следующий переход внутри кабинета — итог операции, а не уход человека (открыть созданный
 * проект): не останавливать. Действует один раз и не дольше секунды.
 */
export function allowNextLeave(now = Date.now()): void {
  allowUntil = now + 1_000;
}

/** Остановить ли переход ВНУТРИ кабинета: теряются поля или результат обычного запроса. */
export function shouldBlockInApp(now = Date.now()): boolean {
  if (allowUntil > now) {
    allowUntil = 0;
    return false;
  }
  const s = leaveState();
  return s.dirty || s.request;
}

/** Предупредить ли при закрытии и перезагрузке вкладки: теряется что-либо из трёх. */
export function shouldWarnOnUnload(): boolean {
  const s = leaveState();
  return s.dirty || s.guarded || s.request;
}

/** Для проверок без браузера. */
export function resetLeaveGuard(): void {
  sources.clear();
  notify();
}

export function useLeaveState(): LeaveState {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
  );
  return leaveState();
}

/** Закрытие и перезагрузка вкладки: стандартный запрос браузера. */
export function useBeforeUnloadGuard(): void {
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!shouldWarnOnUnload()) return;
      event.preventDefault();
      // Старые браузеры требуют непустое значение; текст они всё равно не показывают.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}

/** Диалог перехода внутри кабинета — что именно потеряется. */
export function LeaveDialog({
  open,
  onStay,
  onLeave,
}: {
  open: boolean;
  onStay: () => void;
  onLeave: () => void;
}): React.ReactElement | null {
  const state = useLeaveState();
  const [, force] = useState(0);
  useEffect(() => {
    if (!open) return undefined;
    force((n) => n + 1);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onStay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onStay]);
  if (!open) return null;
  const lines: string[] = [];
  if (state.dirty) lines.push('Введённое в форме не сохранено и пропадёт.');
  if (state.request) {
    lines.push('Запрос ещё выполняется: его результат может остаться неизвестным.');
  }
  return (
    <div
      data-leave-dialog
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--u-space-4)',
        background: 'rgba(0, 0, 0, 0.45)',
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onStay();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Уйти со страницы?"
        style={{
          width: 'min(32rem, 100%)',
          display: 'grid',
          gap: 'var(--u-space-4)',
          padding: 'var(--u-space-5)',
          borderRadius: 'var(--u-radius-lg)',
          border: '1px solid var(--u-border)',
          background: 'var(--u-surface)',
          boxShadow: 'var(--u-shadow-lg, 0 24px 60px rgba(0,0,0,0.35))',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Уйти со страницы?</h2>
        {lines.map((line) => (
          <p key={line} style={{ margin: 0, color: 'var(--u-text-muted)' }}>
            {line}
          </p>
        ))}
        <div style={{ display: 'flex', gap: 'var(--u-space-2)', justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onLeave} data-leave-confirm>
            Уйти
          </Button>
          <Button type="button" variant="brand" onClick={onStay} data-leave-stay>
            Остаться
          </Button>
        </div>
      </div>
    </div>
  );
}
