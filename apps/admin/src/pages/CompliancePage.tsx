import { useCallback, useEffect, useState } from 'react';
import type { KycVerification } from '@unicorn/contracts';
import { PromptDialog } from '@unicorn/ui';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

const KYC_KIND_TITLES: Record<string, string> = {
  identity: 'личность',
  investor_status: 'статус инвестора',
  accredited: 'квалифицированный инвестор',
};

/**
 * Очередь комплаенса.
 *
 * Документы верификации сюда НЕ приходят и приходить не должны: они шифруются
 * и живут в хранилище, доступ к ним — отдельный процесс. Здесь принимается
 * решение по заявке, и оно необратимо: повторное решение сервер отклонит.
 *
 * Свою собственную заявку одобрить нельзя — это запрещено триггером в базе,
 * а не только проверкой в коде.
 */
export function CompliancePage() {
  const [queue, setQueue] = useState<KycVerification[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Перезагрузка с начала: после решения список сбрасывается, чтобы курсор не
  // дублировал и не пропускал строки относительно изменившейся очереди.
  const load = useCallback(async () => {
    try {
      const page = await api.kycQueue();
      setQueue(page.items);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить очередь'));
    }
  }, []);

  // Следующая страница ДОПИСЫВАЕТСЯ к списку: раньше `nextCursor`
  // выбрасывался клиентом, и заявки после первых 50 были недостижимы для
  // оператора вовсе (CODE-MED-01).
  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api.kycQueue(nextCursor);
      setQueue((current) => {
        const seen = new Set((current ?? []).map((item) => item.id));
        return [...(current ?? []), ...page.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить продолжение очереди'));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Отказ требует причины: диалог вместо системного `window.prompt`. */
  const [rejecting, setRejecting] = useState<KycVerification | null>(null);

  async function decide(item: KycVerification, decision: 'approved' | 'rejected', reason?: string) {
    setError(null);
    setNotice(null);
    try {
      await api.decideKyc(item.id, decision, reason);
      setNotice(decision === 'approved' ? 'Верификация одобрена.' : 'Заявка отклонена.');
      await load();
    } catch (err) {
      setError(problemText(err, 'Решение не сохранено'));
    }
  }

  return (
    <>
      <h1>Комплаенс</h1>
      <p className="page-hint">
        Заявки на верификацию личности. Решение принимается однократно и записывается в журнал
        вместе с автором.
      </p>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      {queue === null && <div className="spinner">Загрузка…</div>}

      {queue !== null && queue.length === 0 && (
        <div className="card empty">Очередь пуста — необработанных заявок нет.</div>
      )}

      {queue !== null && queue.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Заявитель</th>
                <th>Вид</th>
                <th>Статус</th>
                <th>Подана</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {queue.map((item) => (
                <tr key={item.id}>
                  <td>
                    {/*
                      Имя заявителя вместо восьми знаков идентификатора:
                      одобрять неизвестно кого — не решение, а нажатие кнопки.
                      Идентификатор остаётся рядом мелким шрифтом, он нужен для
                      сверки с журналом.
                    */}
                    <div>{item.subjectName ?? 'имя не указано'}</div>
                    <div className="small muted">{item.id.slice(0, 8)}</div>
                  </td>
                  <td>{KYC_KIND_TITLES[item.kind] ?? item.kind}</td>
                  <td>
                    <span className="badge badge--warn">
                      {item.status === 'pending' ? 'ожидает' : 'на проверке'}
                    </span>
                  </td>
                  <td className="small">{formatDate(item.createdAt)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn--sm"
                        onClick={() => void decide(item, 'approved')}
                      >
                        Одобрить
                      </button>
                      <button
                        type="button"
                        className="btn--danger btn--sm"
                        onClick={() => setRejecting(item)}
                      >
                        Отклонить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextCursor !== null && (
            <button
              type="button"
              className="btn--sm"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? 'Загружаем…' : 'Показать ещё'}
            </button>
          )}
        </div>
      )}

      <PromptDialog
        open={rejecting !== null}
        title="Отказ в верификации"
        description="Причина уходит во внутренний контур и пользователю не показывается: ему приходит обобщённая формулировка."
        label="Причина отказа"
        confirmText="Отклонить"
        onCancel={() => setRejecting(null)}
        onConfirm={(reason) => {
          const item = rejecting;
          setRejecting(null);
          if (item) void decide(item, 'rejected', reason);
        }}
      />
    </>
  );
}
