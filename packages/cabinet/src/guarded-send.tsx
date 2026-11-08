import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button } from '@fifth/ui';

/**
 * Защищённая отправка формы (блок 2, 2.2 и 2.6).
 *
 * Ключ повтора создаётся до первой отправки вместе со снимком отправленного содержимого.
 * Если ответ не получен, результат неизвестен: сервер мог успеть записать. Тогда:
 *
 *   * ни успеха, ни окончательной неудачи не показываем;
 *   * выясняем повтором ТОГО ЖЕ снимка с ТЕМ ЖЕ ключом — сервер вернёт прежний результат
 *     или выполнит работу один раз; одна проверка — сама, дальше по кнопке;
 *   * пока не выяснено, новой отправки нет: правка полей не превращает «проверить» в
 *     создание второго объекта с новым ключом — форма заперта на отправленном.
 *
 * Ключ и снимок живут только в памяти страницы: чувствительный ввод в хранилище браузера
 * не пишется. Повторный вход в той же вкладке их не сбрасывает и сам ничего не отправляет;
 * перезагрузка страницы — явное действие человека.
 *
 * Только для маршрутов, где сервер принимает ключ (M159). Остальные изменяющие запросы
 * не повторяются.
 */
export type GuardedPhase = 'idle' | 'sending' | 'checking' | 'unknown';

/** Признаки неизвестного результата: обрыв ответа или «ещё выполняется». */
export function isOutcomeUnknown(error: unknown): boolean {
  const e = error as { outcomeUnknown?: boolean; code?: string } | null;
  return Boolean(e?.outcomeUnknown) || e?.code === 'operation_in_progress';
}

const AUTO_CHECK_MS = 1500;

export function useGuardedSend<P, R>(options: {
  send: (payload: P, key: string) => Promise<R>;
  /** Результат получен — при первой отправке или при выяснении. */
  onDone: (result: R, payload: P) => void;
  /** Сервер ответил отказом: ввод остаётся на странице, новая попытка — с новым ключом. */
  onFail: (error: unknown) => void;
}) {
  const opts = useRef(options);
  opts.current = options;
  const pending = useRef<{ key: string; payload: P } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phase, setPhase] = useState<GuardedPhase>('idle');
  const [snapshot, setSnapshot] = useState<P | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const finish = useCallback(() => {
    pending.current = null;
    setSnapshot(null);
    setPhase('idle');
  }, []);

  const attempt = useCallback(
    async (mode: 'first' | 'check' | 'auto'): Promise<void> => {
      const current = pending.current;
      if (!current) return;
      setPhase(mode === 'first' ? 'sending' : 'checking');
      try {
        const result = await opts.current.send(current.payload, current.key);
        finish();
        opts.current.onDone(result, current.payload);
      } catch (error) {
        if (!isOutcomeUnknown(error)) {
          finish();
          opts.current.onFail(error);
          return;
        }
        setPhase('unknown');
        // Одна проверка сама, после первой отправки: короткий обрыв обычно выясняется сразу.
        if (mode === 'first' && timer.current === null) {
          timer.current = setTimeout(() => {
            timer.current = null;
            void attempt('auto');
          }, AUTO_CHECK_MS);
        }
      }
    },
    [finish],
  );

  /** Отправить. Пока прежняя отправка не выяснена — только её проверка, без новой работы. */
  const submit = useCallback(
    (payload: P): Promise<void> => {
      if (pending.current) return attempt('check');
      pending.current = { key: crypto.randomUUID(), payload };
      setSnapshot(payload);
      return attempt('first');
    },
    [attempt],
  );

  /** Проверить неизвестный результат: тот же снимок, тот же ключ. */
  const check = useCallback(() => attempt('check'), [attempt]);

  return {
    submit,
    check,
    phase,
    busy: phase !== 'idle' && phase !== 'unknown',
    /** Результат прежней отправки не выяснен: форма заперта на отправленном. */
    unresolved: phase === 'unknown' || (phase === 'checking' && snapshot !== null),
    /** Отправленное содержимое, пока результат не выяснен. */
    snapshot,
  };
}

/** Сообщение о неизвестном результате с кнопкой проверки. Показывать рядом с формой. */
export function GuardedNotice({
  phase,
  onCheck,
}: {
  phase: GuardedPhase;
  onCheck: () => void;
}): React.ReactElement | null {
  if (phase !== 'unknown' && phase !== 'checking') return null;
  return (
    <Alert tone="warning" data-guarded={phase}>
      <p>
        {phase === 'checking'
          ? 'Проверяем, дошла ли отправка…'
          : 'Не удалось получить ответ сервера. Возможно, данные уже сохранены. Отправленное осталось на странице — проверьте его, прежде чем отправлять снова.'}
      </p>
      <Button size="sm" onClick={onCheck} loading={phase === 'checking'} data-guarded-check>
        Проверить отправку
      </Button>
    </Alert>
  );
}
