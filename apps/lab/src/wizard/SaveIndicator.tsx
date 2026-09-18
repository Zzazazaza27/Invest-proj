import { useEffect, useState } from 'react';
import { Button } from '@unicorn/ui';
import { S } from '../strings';
import type { SaveState } from './useApplication';

/**
 * Состояние сохранения — всегда на виду. «Не сохранено» — красным и с кнопкой
 * повтора: набранное не должно пропасть молча (замечание владельца, этап 4).
 * Общий для профиля и раунда: у обоих одна дисциплина автосохранения.
 */
export function SaveIndicator({
  state,
  count,
  onRetry,
  scope = 'application',
}: {
  state: SaveState;
  count: number;
  onRetry: () => void;
  /** Что именно сохраняется — для проверок, у профиля и раунда свои индикаторы. */
  scope?: 'application' | 'round';
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (state.kind !== 'retrying') return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [state]);

  const problem = state.kind === 'retrying' || state.kind === 'failed';
  const text =
    state.kind === 'saving'
      ? S.wizard.save.saving
      : state.kind === 'pending'
        ? S.wizard.save.pending
        : state.kind === 'saved'
          ? S.wizard.save.saved(
              state.at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
            )
          : state.kind === 'retrying'
            ? `${S.wizard.save.retrying(Math.max(0, Math.ceil((state.at.getTime() - Date.now()) / 1000)))}: ${state.message}`
            : state.kind === 'failed'
              ? `${S.wizard.save.failed}: ${state.message}`
              : S.wizard.save.idle;
  return (
    <span
      role={problem ? 'alert' : 'status'}
      data-save-state={state.kind}
      data-save-count={count}
      data-save-scope={scope}
      style={{
        display: 'inline-flex',
        gap: 'var(--u-space-2)',
        alignItems: 'center',
        fontSize: 'var(--u-text-sm)',
        color: problem ? 'var(--u-danger)' : 'var(--u-text-muted)',
      }}
    >
      {text}
      {problem ? (
        <Button
          variant="secondary"
          style={{ minHeight: 32, padding: '0 var(--u-space-3)' }}
          onClick={onRetry}
        >
          {S.wizard.save.retryNow}
        </Button>
      ) : null}
    </span>
  );
}
