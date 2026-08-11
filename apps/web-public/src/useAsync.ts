import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

/**
 * Состояние загруженных данных.
 *
 * Четыре состояния вместо булева `loading` — не педантизм: интерфейс, который
 * знает только «грузится / не грузится», не отличает пустоту от ошибки и
 * показывает пустой экран там, где нужно объяснение (GLOBAL-CLAUDE §5).
 */
export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string; traceId: string | null };

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): {
  state: AsyncState<T>;
  reload: () => void;
} {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Ответ отменённого запроса не должен перезаписывать состояние: иначе быстрый
  // повтор показывает данные предыдущего, уже неактуального обращения.
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setState({ status: 'loading' });

    load()
      .then((data) => {
        if (generation.current === current) setState({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (generation.current !== current) return;
        setState({
          status: 'error',
          // Наружу показываем текст сервера, если он есть: он написан для
          // человека. Технические детали остаются в консоли и в traceId.
          message:
            error instanceof ApiError
              ? (error.problem?.detail ?? error.message)
              : 'Сервис временно недоступен',
          traceId: error instanceof ApiError ? error.traceId : null,
        });
      });

    return () => {
      // Размонтирование тоже обесценивает ответ.
      generation.current += 1;
    };
    // Зависимости раскрываются, а не передаются массивом: массив — новая ссылка
    // на каждый рендер, и эффект запускался бы бесконечно. По той же причине
    // здесь нет `load`: стрелка вызывающего тоже пересоздаётся каждый раз.
  }, [...deps, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
