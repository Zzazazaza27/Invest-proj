import { ApiError } from '@fifth/api-client';
import { Badge } from '@fifth/ui';

export interface RunOutcome {
  operationTitle: string;
  method: string;
  path: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  status?: number;
  code?: string;
  message?: string;
  payload?: unknown;
  /** Что попало в блокнот из этого ответа. */
  remembered?: [string, string][];
}

/**
 * Показ результата вызова.
 *
 * Отказ здесь такой же полноценный результат, как успех: половина проверок в
 * этом проекте — про то, что сервер ОТКАЗЫВАЕТ (чужой проект, роль себе,
 * подпись без второго фактора). Поэтому 403 и 422 показываются спокойно и
 * подробно, а не как «что-то пошло не так».
 */
export function ResultPanel({ outcome }: { outcome: RunOutcome | null }) {
  if (!outcome) {
    return (
      <p style={{ color: 'var(--u-text-muted)' }}>
        Результат появится здесь. Отказ сервера — тоже результат: коды 401, 403 и 422 в этом проекте
        чаще подтверждают работу защиты, чем поломку.
      </p>
    );
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: 12,
        }}
      >
        <Badge tone={outcome.ok ? 'success' : 'danger'}>
          {outcome.ok ? 'успех' : 'отказ'}
          {outcome.status !== undefined ? ` · HTTP ${outcome.status}` : ''}
        </Badge>
        <span style={{ fontSize: 'var(--u-text-xs)', color: 'var(--u-text-muted)' }}>
          {outcome.method} {outcome.path} · {outcome.durationMs} мс · {outcome.startedAt}
        </span>
      </div>

      {outcome.message ? (
        <p style={{ margin: '0 0 12px' }}>
          {outcome.code ? (
            <code style={{ marginRight: 8, color: 'var(--u-danger)' }}>{outcome.code}</code>
          ) : null}
          {outcome.message}
        </p>
      ) : null}

      {outcome.remembered && outcome.remembered.length > 0 ? (
        <p style={{ margin: '0 0 12px', fontSize: 'var(--u-text-sm)' }}>
          В блокнот записано:{' '}
          {outcome.remembered.map(([key, value]) => (
            <code key={key} style={{ marginRight: 8 }}>
              {key}={value.slice(0, 8)}…
            </code>
          ))}
        </p>
      ) : null}

      <pre className="console-json">{format(outcome.payload)}</pre>
    </div>
  );
}

function format(payload: unknown): string {
  if (payload === undefined) return '(тело ответа пустое)';
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/** Разбирает исключение вызова в человекочитаемый исход. */
export function describeError(
  error: unknown,
): Pick<RunOutcome, 'status' | 'code' | 'message' | 'payload'> {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      // Тело problem+json важнее текста: в нём перечислены поля, по которым
      // сервер отказал, и traceId — по нему отказ находится в журнале сервера.
      payload: error.problem ?? undefined,
    };
  }
  if (error instanceof Error) return { message: error.message };
  return { message: String(error) };
}
