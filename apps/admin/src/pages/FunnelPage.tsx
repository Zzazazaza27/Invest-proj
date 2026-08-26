import { useCallback, useEffect, useState } from 'react';
import type { Season, SeasonStageOccupancy } from '@unicorn/contracts';
import { api } from '../api';
import { problemText } from '../lib/format';

const STAGE_TITLES: Record<string, string> = {
  ai_review: 'AI-оценка',
  expert_review: 'Экспертиза',
  bootcamp: 'Буткемп',
  finalist: 'Финал',
  graduated: 'Выпуск',
};

/**
 * Воронка сезона: квоты этапов, расписание их открытия и перевод проектов.
 *
 * Экран не решает, кто проходит — он показывает занятость и передаёт решение
 * серверу. Квота, расписание и допустимость перехода проверяются там же, и
 * отказ выводится словами сервера: дублировать эти правила в браузере значило
 * бы завести второй источник правды об отборе.
 */
/**
 * Состояния сезона по-человечески: оператор читает «приём заявок открыт», а не
 * `applications_open`.
 */
const SEASON_STATUS_TITLES: Record<string, string> = {
  draft: 'черновик',
  applications_open: 'приём заявок открыт',
  review: 'экспертиза',
  bootcamp: 'буткемп',
  final: 'финал',
  closed: 'закрыт',
};

export function FunnelPage() {
  const [season, setSeason] = useState<Season | null | undefined>(undefined);
  const [stages, setStages] = useState<SeasonStageOccupancy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quotas, setQuotas] = useState<Record<string, string>>({});
  const [projectId, setProjectId] = useState('');
  const [targetStage, setTargetStage] = useState('bootcamp');
  const [reason, setReason] = useState('');
  const [useTicket, setUseTicket] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const current = await api.currentSeason();
      setSeason(current);
      setError(null);
      if (!current) return;
      const items = await api.funnel(current.id);
      setStages(items);
      setQuotas(
        Object.fromEntries(items.map((item) => [item.stage, item.quota ? String(item.quota) : ''])),
      );
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить воронку'));
      setSeason(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveQuotas() {
    if (!season) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Пустое поле означает «без ограничения», а не ноль: квота 0 закрыла бы
      // этап настройкой, а не решением.
      const parsed = Object.fromEntries(
        Object.entries(quotas)
          .filter(([, value]) => value.trim() !== '')
          .map(([stage, value]) => [stage, Number(value)]),
      );
      await api.setFunnel(season.id, { quotas: parsed, schedule: {} });
      setNotice('Квоты сохранены.');
      await load();
    } catch (err) {
      setError(problemText(err, 'Квоты не сохранены'));
    } finally {
      setBusy(false);
    }
  }

  async function advance() {
    if (!season) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.advanceStage(season.id, projectId.trim(), {
        status: targetStage as 'bootcamp',
        reason: reason.trim(),
        useGoldenTicket: useTicket,
      });
      setNotice(
        `Проект переведён: ${result.from} → ${result.to}` +
          (result.goldenTicketRedeemed ? ', золотой билет погашен' : ''),
      );
      setProjectId('');
      setReason('');
      setUseTicket(false);
      await load();
    } catch (err) {
      setError(problemText(err, 'Перевод не выполнен'));
    } finally {
      setBusy(false);
    }
  }

  if (season === undefined) return <p>Загружаем воронку…</p>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Воронка сезона</h1>
          <p className="page-hint">
            Квота — верхняя граница числа проектов НА этапе. Допустимость перехода, расписание и
            наличие свободного места проверяет сервер: здесь показывается его ответ.
          </p>
        </div>
      </div>

      {error ? (
        <div className="alert alert--error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="alert alert--ok" role="status">
          {notice}
        </div>
      ) : null}

      {!season ? (
        <p className="muted">
          Активного сезона нет. Воронка появится вместе с сезоном — она описывает отбор внутри него.
        </p>
      ) : (
        <>
          <p className="muted">
            Сезон №{season.number}, состояние «
            {SEASON_STATUS_TITLES[season.status] ?? season.status}». Квота — верхняя граница числа
            проектов НА этапе. Уменьшение квоты не выводит тех, кто прошёл раньше, но добрать до
            прежнего числа больше не позволит.
          </p>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Этап</th>
                  <th>Занято</th>
                  <th>Квота</th>
                </tr>
              </thead>
              <tbody>
                {stages.map((stage) => (
                  <tr key={stage.stage}>
                    <td>{STAGE_TITLES[stage.stage] ?? stage.stage}</td>
                    <td>{stage.occupied}</td>
                    <td>
                      <input
                        className="num"
                        aria-label={`Квота этапа ${STAGE_TITLES[stage.stage] ?? stage.stage}`}
                        inputMode="numeric"
                        value={quotas[stage.stage] ?? ''}
                        placeholder="без ограничения"
                        onChange={(event) =>
                          setQuotas((current) => ({
                            ...current,
                            [stage.stage]: event.target.value,
                          }))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button className="btn--sm" onClick={() => void saveQuotas()} disabled={busy}>
            Сохранить квоты
          </button>

          <h2>Перевести проект</h2>
          <div className="grid-2">
            <label className="field" htmlFor="funnel-project">
              <span>Идентификатор проекта</span>
              <input
                id="funnel-project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                placeholder="UUID проекта"
              />
            </label>
            <label className="field">
              <span>Этап</span>
              <select value={targetStage} onChange={(event) => setTargetStage(event.target.value)}>
                {Object.entries(STAGE_TITLES).map(([value, title]) => (
                  <option key={value} value={value}>
                    {title}
                  </option>
                ))}
                <option value="rejected">Отказ</option>
              </select>
            </label>
            <label className="field" htmlFor="funnel-reason">
              <span>Основание</span>
              <input
                id="funnel-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="почему принято это решение"
              />
            </label>
            <label className="field" htmlFor="funnel-ticket">
              <input
                id="funnel-ticket"
                type="checkbox"
                checked={useTicket}
                onChange={(event) => setUseTicket(event.target.checked)}
              />
              <span>Провести по золотому билету (он будет погашен)</span>
            </label>
          </div>
          <button
            className="btn--sm"
            onClick={() => void advance()}
            disabled={busy || projectId.trim() === '' || reason.trim().length < 3}
          >
            Перевести
          </button>
        </>
      )}
    </>
  );
}
