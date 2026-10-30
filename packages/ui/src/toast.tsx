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
 * встают стопкой (`ToastStack`); на телефоне — во всю ширину сверху. Сколько
 * карточек показывать одновременно, решает приложение: остальные ждут в его
 * очереди, а не монтируются.
 *
 * `onShown` — «сообщение действительно появилось перед пользователем»: зовётся
 * один раз, когда вкладка видима И карточка в поле зрения — видна не меньше
 * чем на три четверти или занимает больше половины экрана. Карточка, ушедшая
 * за край экрана или за предел стопки, ничего не подтверждает, как и скрытая
 * вкладка: вызов ждёт, пока её действительно увидят. По этому сигналу
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

/** Доля карточки в поле зрения, с которой показ считается состоявшимся. */
const SEEN_RATIO = 0.75;

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
  const element = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  const callback = useRef(onShown);
  callback.current = onShown;

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    // Без IntersectionObserver проверить положение нечем — тогда отмечает
    // только видимость вкладки, как раньше. В поддерживаемых браузерах он есть.
    let inView = typeof IntersectionObserver === 'undefined';

    const mark = () => {
      if (shown.current || !inView || document.visibilityState !== 'visible') return;
      shown.current = true;
      callback.current?.();
    };

    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            ([entry]) => {
              if (!entry) return;
              const viewport = entry.rootBounds?.height ?? window.innerHeight;
              inView =
                entry.isIntersecting &&
                (entry.intersectionRatio >= SEEN_RATIO ||
                  entry.intersectionRect.height >= viewport / 2);
              mark();
            },
            { threshold: [0, 0.25, 0.5, SEEN_RATIO, 1] },
          );
    observer?.observe(node);
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', mark);
    };
  }, []);

  return (
    <div
      ref={element}
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

/**
 * Место стопки сообщений: фиксировано справа сверху, на телефоне — сверху во
 * всю ширину. Высота ограничена экраном: то, что не поместилось, прокручивается
 * внутри стопки и до прокрутки показанным не считается.
 */
export function ToastStack({ children, more }: { children: ReactNode; more?: ReactNode }) {
  return (
    <div className="u-toast-stack" aria-live="assertive">
      {children}
      {more ? <div className="u-toast-stack__more">{more}</div> : null}
    </div>
  );
}
