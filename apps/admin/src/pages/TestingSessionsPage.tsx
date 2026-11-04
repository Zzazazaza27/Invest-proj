import { useCallback, useEffect, useState } from 'react';
import type {
  CleanupPlanSchema,
  TestingSession,
  TestingSessionCard,
  TestingSessionStatus,
} from '@fifth/contracts';
import { TESTING_RESULT_LABEL, TESTING_STATUS_LABEL } from '@fifth/contracts';
import type { z } from 'zod';
import { api } from '../api';
import { backHere } from './users-shared';

/**
 * Тестовые сессии.
 *
 * ЧТО ЭТО ТАКОЕ. Набор участников, от лица которых можно пройти платформу без
 * ввода чужих логинов, плюс запись прогона: шаги, итог и перечень созданного.
 * Автоматический прогон — такая же сессия, просто заведённая не человеком.
 *
 * ЧТО ЗДЕСЬ РАЗДЕЛЕНО НАМЕРЕННО.
 *
 *  * **Состояние и итог** — разные столбцы. Завершённая сессия бывает и
 *    успешной, и упавшей; идущая итога ещё не имеет. Один столбец «статус»
 *    заставлял бы гадать, что означает «завершена».
 *
 *  * **Завершение и уборка** — разные действия. Завершение закрывает выданные
 *    кабинеты, но данные оставляет: к упавшему прогону возвращаются именно за
 *    данными. Уборка удаляет, и потому спрашивает подтверждение с показом
 *    состава.
 *
 *  * **Открыть кабинет** ведёт в ДРУГУЮ вкладку. Админка остаётся
 *    администраторской: личность подставляется заголовком, который шлёт
 *    только та вкладка.
 */

type CleanupPlan = z.infer<typeof CleanupPlanSchema>['plan'];

const STATUS_TONE: Record<TestingSessionStatus, string> = {
  active: 'var(--u-ok, #1a7f37)',
  finished: 'var(--text-muted)',
  cleaning: 'var(--u-warn, #9a6700)',
  cleaned: 'var(--text-muted)',
  clean_failed: 'var(--u-danger, #b42318)',
};

/** Куда ведёт кабинет участника: у каждой роли своё приложение. */
const CABINET_BY_ROLE: Record<string, string> = {
  founder: '/lab/',
  investor: '/investor/',
  corporate: '/lab/',
};

export function TestingSessionsPage() {
  const [sessions, setSessions] = useState<TestingSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const page = await api.testing.list();
      setSessions(page.sessions);
      setError(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'не удалось загрузить');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(async () => {
    const name = title.trim();
    if (!name) return;
    setBusy(true);
    try {
      const { id } = await api.testing.create({ title: name });
      setTitle('');
      await reload();
      setOpenId(id);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'не удалось создать');
    } finally {
      setBusy(false);
    }
  }, [title, reload]);

  return (
    <div data-page="testing-sessions">
      <div className="page-head">
        <h1>Тестовые сессии</h1>
      </div>
      <p className="page-hint">
        Пройти платформу от лица основателя или инвестора без ввода их логинов. Автоматический
        прогон заводит такую же сессию — по ней потом разбирают падение. Участники сессии —
        отдельные учётные записи; рабочие аккаунты в сессию не попадают.
      </p>

      <div className="card card--flat">
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <input
            aria-label="Название сессии"
            data-session-title
            value={title}
            placeholder="Например, проверка раунда"
            onChange={(event) => setTitle(event.target.value)}
            style={{ width: 'min(360px, 100%)' }}
          />
          <button
            type="submit"
            className="btn--sm"
            data-session-create
            disabled={busy || !title.trim()}
          >
            {busy ? 'Создаю…' : 'Начать сессию'}
          </button>
        </form>
        <p className="hint">
          Система подготовит основателя и инвестора. Пароли не нужны и не выдаются: кабинет
          открывается контекстом, который живёт только в вашей административной сессии.
        </p>
      </div>

      {error ? (
        <div className="card card--flat" data-sessions-error>
          {error}
        </div>
      ) : null}

      <div className="card">
        {sessions === null ? (
          <p>Загружаю…</p>
        ) : sessions.length === 0 ? (
          <p data-sessions-empty>Сессий пока нет — начните первую.</p>
        ) : (
          <table className="table" data-sessions-table>
            <thead>
              <tr>
                <th>Название</th>
                <th>Откуда</th>
                <th>Состояние</th>
                <th>Итог</th>
                <th>Активность</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id} data-session-row={session.id}>
                  <td>{session.title}</td>
                  <td>{session.source === 'manual' ? 'вручную' : 'прогон'}</td>
                  <td>
                    <span style={{ color: STATUS_TONE[session.status] }} data-session-status>
                      {TESTING_STATUS_LABEL[session.status]}
                    </span>
                  </td>
                  <td data-session-result>{TESTING_RESULT_LABEL[session.result]}</td>
                  <td>{new Date(session.lastActiveAt).toLocaleString('ru-RU')}</td>
                  <td>
                    <button
                      type="button"
                      className="btn--ghost btn--sm"
                      data-session-open
                      onClick={() => setOpenId(session.id === openId ? null : session.id)}
                    >
                      {session.id === openId ? 'Скрыть' : 'Подробности'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {openId ? <SessionCard id={openId} onChanged={reload} /> : null}
    </div>
  );
}

function SessionCard({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const [card, setCard] = useState<TestingSessionCard | null>(null);
  const [plan, setPlan] = useState<CleanupPlan | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setCard(await api.testing.card(id));
    } catch (problem) {
      setMessage(problem instanceof Error ? problem.message : 'не удалось загрузить карточку');
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Открыть кабинет участника.
   *
   * Контекст создаётся здесь, а идентификатор уезжает в ЯКОРЕ адреса: на
   * сервер якорь не уходит и в журналы доступа не попадает. Вкладка сразу
   * переложит его в своё состояние и вычистит адрес.
   */
  const openCabinet = useCallback(
    async (userId: string, role: string) => {
      setBusy(true);
      try {
        const { contextId } = await api.testing.openParticipant(id, userId);
        const base = CABINET_BY_ROLE[role] ?? '/lab/';
        window.open(`${base}#ctx=${contextId}&back=${backHere()}`, '_blank', 'noopener');
      } catch (problem) {
        setMessage(problem instanceof Error ? problem.message : 'не удалось открыть кабинет');
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  const openGuest = useCallback(async () => {
    setBusy(true);
    try {
      const { contextId } = await api.testing.openGuest(id);
      window.open(`/#ctx=${contextId}&back=${backHere()}`, '_blank', 'noopener');
    } catch (problem) {
      setMessage(problem instanceof Error ? problem.message : 'не удалось открыть витрину');
    } finally {
      setBusy(false);
    }
  }, [id]);

  const act = useCallback(
    async (what: 'finish' | 'resume' | 'cleanup') => {
      setBusy(true);
      setMessage(null);
      try {
        if (what === 'finish') await api.testing.finish(id);
        if (what === 'resume') await api.testing.resume(id);
        if (what === 'cleanup') {
          const result = await api.testing.cleanup(id);
          setMessage(`Убрано: удалено ${result.deleted}, помечено ${result.marked}`);
          setPlan(null);
        }
        await reload();
        await onChanged();
      } catch (problem) {
        setMessage(problem instanceof Error ? problem.message : 'не получилось');
      } finally {
        setBusy(false);
      }
    },
    [id, reload, onChanged],
  );

  if (!card) return <div className="card">Загружаю карточку…</div>;

  const { session, participants, steps, objects } = card;
  const cleaned = session.status === 'cleaned';

  return (
    <div className="card" data-session-card={session.id}>
      <h2>{session.title}</h2>
      <p className="hint">
        {TESTING_STATUS_LABEL[session.status]} · итог: {TESTING_RESULT_LABEL[session.result]} ·
        окружение: {session.environment}
        {session.scenarioId ? ` · сценарий: ${session.scenarioId}` : ''}
        {session.codeVersion ? ` · версия: ${session.codeVersion}` : ''}
      </p>
      {session.cleanupError ? (
        <p data-session-cleanup-error style={{ color: 'var(--u-danger, #b42318)' }}>
          Уборка остановлена: {session.cleanupError}
        </p>
      ) : null}

      <h3>Участники</h3>
      {cleaned ? (
        <p data-participants-gone>Данные сессии убраны — кабинетов больше нет.</p>
      ) : (
        <ul data-participants>
          {participants.map((person) => (
            <li key={person.userId} style={{ marginBottom: 6 }}>
              <strong>{person.label}</strong> · {person.displayName}{' '}
              <button
                type="button"
                className="btn--ghost btn--sm"
                data-open-cabinet={person.role}
                disabled={busy}
                onClick={() => void openCabinet(person.userId, person.role)}
              >
                Открыть кабинет
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="btn--ghost btn--sm"
              data-open-guest
              disabled={busy}
              onClick={() => void openGuest()}
            >
              Открыть витрину как гость
            </button>
          </li>
        </ul>
      )}

      {steps.length > 0 ? (
        <>
          <h3>Шаги прогона</h3>
          <table className="table" data-session-steps>
            <thead>
              <tr>
                <th>#</th>
                <th>Шаг</th>
                <th>Итог</th>
                <th>Ожидалось</th>
                <th>Получилось</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step) => (
                <tr key={step.ordinal}>
                  <td>{step.ordinal}</td>
                  <td>{step.name}</td>
                  <td>
                    {step.status === 'passed'
                      ? 'успех'
                      : step.status === 'failed'
                        ? 'падение'
                        : 'пропущен'}
                  </td>
                  <td>{step.expected ?? '—'}</td>
                  <td>{step.actual ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      <h3>Созданные записи</h3>
      {objects.length === 0 ? (
        <p>Сессия ничего не создала.</p>
      ) : (
        <ul data-session-objects>
          {objects.map((row) => (
            <li key={row.table}>
              {row.table}: {row.count}
            </li>
          ))}
        </ul>
      )}

      <div className="toolbar" style={{ marginTop: 16 }}>
        {session.status === 'active' ? (
          <button
            type="button"
            className="btn--sm"
            data-session-finish
            disabled={busy}
            onClick={() => void act('finish')}
          >
            Завершить
          </button>
        ) : null}
        {session.status === 'finished' ? (
          <button
            type="button"
            className="btn--sm"
            data-session-resume
            disabled={busy}
            onClick={() => void act('resume')}
          >
            Продолжить
          </button>
        ) : null}
        {!cleaned ? (
          <button
            type="button"
            className="btn--ghost btn--sm"
            data-session-cleanup-plan
            disabled={busy}
            onClick={async () => {
              const { plan: rows } = await api.testing.cleanupPlan(id);
              setPlan(rows);
            }}
          >
            Что уберёт очистка
          </button>
        ) : null}
      </div>

      {plan ? (
        <div className="card card--flat" data-cleanup-plan style={{ marginTop: 12 }}>
          <p>
            <strong>Будет убрано:</strong>
          </p>
          <ul>
            {plan.map((row) => (
              <li key={row.table}>
                {row.table}: {row.count} — {row.mode === 'mark' ? 'пометка удалёнными' : 'удаление'}
              </li>
            ))}
          </ul>
          <p className="hint">
            Учётные записи помечаются удалёнными, а не стираются: акцепты согласий неизменяемы и
            ссылаются на пользователя. Общие справочники и подготовленное содержимое уборка не
            трогает — она ходит по перечню созданного этой сессией.
          </p>
          <button
            type="button"
            className="btn--sm"
            data-session-cleanup
            disabled={busy}
            onClick={() => void act('cleanup')}
          >
            Убрать данные сессии
          </button>
        </div>
      ) : null}

      {message ? <p data-session-message>{message}</p> : null}
    </div>
  );
}
