import { useCallback, useEffect, useState } from 'react';
import { SEASON_TRANSITIONS, type Season } from '@unicorn/contracts';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Сезон — метроном воронки: пока приём заявок не открыт, основатели не могут
 * подать проект. Статусная машина односторонняя, поэтому доступные переходы
 * показываются явно, а не выбираются из полного списка статусов.
 */
export function SeasonPage() {
  const [season, setSeason] = useState<Season | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSeason(await api.currentSeason());
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить сезон'));
      setSeason(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function move(status: Season['status']) {
    if (!season) return;
    setError(null);
    setNotice(null);
    try {
      await api.changeSeasonStatus(season.id, status);
      setNotice(`Сезон переведён в состояние «${STATUS_TEXT[status]}».`);
      await load();
    } catch (err) {
      setError(problemText(err, 'Переход не выполнен'));
    }
  }

  return (
    <>
      <h1>Сезон</h1>
      <p className="page-hint">
        Приём заявок открывается и закрывается здесь. Вернуть сезон назад нельзя: эксперты работают
        по зафиксированному составу участников, и дозаявка сломала бы сопоставимость оценок.
      </p>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      {season === undefined && <div className="spinner">Загрузка…</div>}
      {season === null && <div className="card empty">Активного сезона нет.</div>}

      {season && (
        <div className="card">
          <h2>
            Сезон {season.number}
            {season.title ? ` — ${season.title}` : ''}
          </h2>
          <table>
            <tbody>
              <tr>
                <th style={{ width: 220 }}>Состояние</th>
                <td>
                  <span
                    className={`badge ${season.status === 'applications_open' ? 'badge--ok' : 'badge--muted'}`}
                  >
                    {STATUS_TEXT[season.status]}
                  </span>
                </td>
              </tr>
              <tr>
                <th>Период</th>
                <td className="small">
                  {formatDate(season.startsAt)} — {formatDate(season.endsAt)}
                </td>
              </tr>
            </tbody>
          </table>

          <div className="toolbar" style={{ marginTop: 16, marginBottom: 0 }}>
            {SEASON_TRANSITIONS[season.status].length === 0 && (
              <span className="muted small">Сезон закрыт: переходов больше нет.</span>
            )}
            {SEASON_TRANSITIONS[season.status].map((next) => (
              <button
                key={next}
                type="button"
                className={next === 'closed' ? 'btn--danger' : ''}
                onClick={() => void move(next)}
              >
                {STATUS_ACTION[next]}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

const STATUS_TEXT: Record<Season['status'], string> = {
  draft: 'черновик',
  applications_open: 'приём заявок открыт',
  review: 'экспертиза',
  bootcamp: 'буткемп',
  final: 'финал',
  closed: 'закрыт',
};

const STATUS_ACTION: Record<Season['status'], string> = {
  draft: 'Вернуть в черновик',
  applications_open: 'Открыть приём заявок',
  review: 'Начать экспертизу',
  bootcamp: 'Перейти к буткемпу',
  final: 'Перейти к финалу',
  closed: 'Закрыть сезон',
};
