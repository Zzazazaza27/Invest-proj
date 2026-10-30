import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Всплывающее сообщение — карточка справа сверху (вариант A, решение Томаса
 * 30.10.2026; работа 2.1-W04, блок 1 1.5).
 *
 * Для чего. Окончательная ошибка длительной операции, которой нужно действие
 * пользователя: файл не принят — загрузите другой. Промежуточные состояния и
 * внутренние повторы сюда не попадают — они показываются в своей функции.
 *
 * Сообщение НЕ исчезает само: с необходимым действием его нельзя пропустить,
 * отвернувшись. Закрывается крестиком или кнопкой. Несколько сообщений
 * встают стопкой (`ToastStack`); на телефоне — во всю ширину сверху.
 *
 * `onShown` — «сообщение действительно появилось перед пользователем»: зовётся
 * один раз, когда карточка смонтирована И вкладка видима. Скрытая вкладка
 * ничего не подтверждает — вызов ждёт её возвращения. По этому сигналу
 * приложение ставит серверную отметку показа, после которой сообщение не
 * повторяется ни на этом, ни на другом устройстве.
 */
export type ToastTone = 'danger' | 'warning' | 'info' | 'success';

export interface ToastProps {
  tone?: ToastTone;
  title: ReactNode;
  children?: ReactNode;
  /** Кнопки действия; закрытие крестиком есть всегда. */
  actions?: ReactNode;
  onClose: () => void;
  onShown?: () => void;
  closeLabel?: string;
  'data-toast'?: string;
}

export function Toast({
  tone = 'danger',
  title,
  children,
  actions,
  onClose,
  onShown,
  closeLabel = 'Закрыть',
  ...rest
}: ToastProps) {
  const shown = useRef(false);
  const callback = useRef(onShown);
  callback.current = onShown;

  useEffect(() => {
    const mark = () => {
      if (shown.current || document.visibilityState !== 'visible') return;
      shown.current = true;
      callback.current?.();
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, []);

  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={`u-toast u-toast--${tone}`}
      data-toast={rest['data-toast']}
      data-toast-tone={tone}
    >
      <div className="u-toast__head">
        <strong className="u-toast__title">{title}</strong>
        <button type="button" className="u-toast__close" aria-label={closeLabel} onClick={onClose}>
          ×
        </button>
      </div>
      {children ? <div className="u-toast__body">{children}</div> : null}
      {actions ? <div className="u-toast__actions">{actions}</div> : null}
    </div>
  );
}

/** Место стопки сообщений: фиксировано справа сверху, на телефоне — сверху во всю ширину. */
export function ToastStack({ children }: { children: ReactNode }) {
  return (
    <div className="u-toast-stack" aria-live="assertive">
      {children}
    </div>
  );
}
