import { useCallback, useEffect, useState } from 'react';
import type { KycVerification } from '@unicorn/contracts';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setQueue(await api.kycQueue());
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить очередь'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(item: KycVerification, decision: 'approved' | 'rejected') {
    let reason: string | undefined;
    if (decision === 'rejected') {
      const input = window.prompt('Причина отказа (во внутренний контур, пользователю не видна):');
      if (!input) return;
      reason = input;
    }
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
                <th>Заявка</th>
                <th>Вид</th>
                <th>Статус</th>
                <th>Подана</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {queue.map((item) => (
                <tr key={item.id}>
                  <td className="small muted">{item.id.slice(0, 8)}</td>
                  <td>{item.kind}</td>
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
                        onClick={() => void decide(item, 'rejected')}
                      >
                        Отклонить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
