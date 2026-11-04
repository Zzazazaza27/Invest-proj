import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card } from '@fifth/ui';
import { api, setCsrf } from './api';
import { createNotebook, pluck } from './notebook';
import { GROUPS, TOTAL_OPERATIONS } from './operations';
import { OperationForm } from './components/OperationForm';
import { ResultPanel, describeError, type RunOutcome } from './components/ResultPanel';
import type { FormValues, Operation } from './types';
import './console.css';

interface SessionState {
  loading: boolean;
  user: { id?: string; displayName?: string; roles?: string[] } | null;
}

/**
 * Плоский список всех операций.
 *
 * Нужен и для выбора по идентификатору, и чтобы первая операция бралась без
 * обращения к `GROUPS[0].operations[0]`: строгая проверка индексов справедливо
 * считает такое обращение возможно пустым, а пустой список групп означал бы
 * сломанную сборку, а не состояние, которое надо обрабатывать.
 */
const ALL_OPERATIONS: Operation[] = GROUPS.flatMap((group) => group.operations);

// Проверка вынесена в функцию с объявленным типом возврата: сужение типа,
// сделанное на верхнем уровне модуля, внутрь замыканий (useMemo, обработчики)
// не переносится, и там значение снова считалось бы возможно пустым.
function firstOperation(): Operation {
  const first = ALL_OPERATIONS[0];
  if (!first) throw new Error('Список операций пуст: сборка консоли неполна');
  return first;
}

const FIRST_OPERATION: Operation = firstOperation();

export default function App() {
  const notebook = useMemo(() => createNotebook(), []);
  const [selectedId, setSelectedId] = useState(FIRST_OPERATION.id);
  const [session, setSession] = useState<SessionState>({ loading: true, user: null });
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [notebookVersion, setNotebookVersion] = useState(0);

  const operation = useMemo<Operation>(
    () => ALL_OPERATIONS.find((op) => op.id === selectedId) ?? FIRST_OPERATION,
    [selectedId],
  );

  /**
   * Кто вошёл. 401 здесь — не ошибка приложения, а законный ответ «никто»:
   * консоль обязана оставаться работоспособной без входа, иначе публичный
   * контур ею не проверить.
   */
  const refreshSession = useCallback(async () => {
    setSession((prev) => ({ ...prev, loading: true }));
    try {
      const user = await api.auth.me();
      setSession({ loading: false, user: user as SessionState['user'] });
    } catch {
      setSession({ loading: false, user: null });
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  async function run(values: FormValues): Promise<void> {
    setBusy(true);
    const startedAt = new Date();
    const started = performance.now();
    try {
      const payload = await operation.run(values, { api, notebook, refreshSession, setCsrf });

      // Идентификаторы из ответа — в блокнот: следующая операция подставит их
      // сама. Без этого сквозной сценарий превращается в перенос UUID руками.
      const remembered: [string, string][] = [];
      for (const [key, path] of Object.entries(operation.remembers ?? {})) {
        const value = pluck(payload, path);
        if (value !== undefined) {
          notebook.set(key, value);
          remembered.push([key, value]);
        }
      }
      if (remembered.length > 0) setNotebookVersion((v) => v + 1);

      setOutcome({
        operationTitle: operation.title,
        method: operation.method,
        path: operation.path,
        startedAt: startedAt.toLocaleTimeString('ru-RU'),
        durationMs: Math.round(performance.now() - started),
        ok: true,
        status: 200,
        payload,
        remembered,
      });
    } catch (error) {
      setOutcome({
        operationTitle: operation.title,
        method: operation.method,
        path: operation.path,
        startedAt: startedAt.toLocaleTimeString('ru-RU'),
        durationMs: Math.round(performance.now() - started),
        ok: false,
        ...describeError(error),
      });
    } finally {
      setBusy(false);
    }
  }

  const notebookEntries = useMemo(() => notebook.entries(), [notebook, notebookVersion]);

  return (
    <div className="console-layout">
      <aside className="console-sidebar">
        <h1 className="console-title">Консоль API</h1>
        <p className="console-subtitle">
          {TOTAL_OPERATIONS} операций · {GROUPS.length} групп
        </p>

        <div className="console-session">
          {session.loading ? (
            <Badge tone="neutral">сессия проверяется…</Badge>
          ) : session.user ? (
            <>
              <Badge tone="success">вход выполнен</Badge>
              <p className="console-session-name">{session.user.displayName ?? session.user.id}</p>
              <p className="console-session-roles">
                {(session.user.roles ?? []).join(', ') || 'без ролей'}
              </p>
            </>
          ) : (
            <Badge tone="neutral">не выполнен вход</Badge>
          )}
        </div>

        <nav>
          {GROUPS.map((group) => (
            <section key={group.id} className="console-group">
              <h2 className="console-group-title">{group.title}</h2>
              {group.note ? <p className="console-group-note">{group.note}</p> : null}
              <ul className="console-op-list">
                {group.operations.map((op) => (
                  <li key={op.id}>
                    <button
                      type="button"
                      className={`console-op${op.id === selectedId ? ' console-op--active' : ''}`}
                      onClick={() => setSelectedId(op.id)}
                      aria-current={op.id === selectedId ? 'true' : undefined}
                    >
                      <span className={`console-method console-method--${op.method.toLowerCase()}`}>
                        {op.method}
                      </span>
                      {op.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
      </aside>

      <main className="console-main">
        <Card>
          <h2 style={{ marginTop: 0 }}>{operation.title}</h2>
          <p className="console-path">
            {operation.method} {operation.path}
            {operation.needsAuth ? ' · требуется вход' : ' · без входа'}
          </p>
          <p className="console-summary">{operation.summary}</p>
          {operation.needsAuth && !session.user && !session.loading ? (
            <p className="console-warning">
              Вход не выполнен — ожидается 401. Это законный ответ, а не поломка.
            </p>
          ) : null}
          <OperationForm operation={operation} notebook={notebook} busy={busy} onSubmit={run} />
        </Card>

        <Card>
          <h2 style={{ marginTop: 0 }}>Результат</h2>
          <ResultPanel outcome={outcome} />
        </Card>

        <Card>
          <h2 style={{ marginTop: 0 }}>Блокнот прогона</h2>
          <p className="console-summary">
            Идентификаторы, полученные в этом прогоне. Подставляются в поля с тем же именем
            автоматически.
          </p>
          {notebookEntries.length === 0 ? (
            <p style={{ color: 'var(--u-text-muted)' }}>
              Пусто — ни одна операция ещё не вернула идентификатор.
            </p>
          ) : (
            <table className="console-table">
              <tbody>
                {notebookEntries.map(([key, value]) => (
                  <tr key={key}>
                    <th scope="row">{key}</th>
                    <td>
                      <code>{value}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              notebook.clear();
              setNotebookVersion((v) => v + 1);
            }}
            disabled={notebookEntries.length === 0}
          >
            Очистить блокнот
          </Button>
        </Card>
      </main>
    </div>
  );
}
