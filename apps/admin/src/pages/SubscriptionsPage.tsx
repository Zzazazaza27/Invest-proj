import { useCallback, useEffect, useState } from 'react';
import type { AdminSubscription } from '@unicorn/contracts';
import { api } from '../api';
import { formatDate, formatMoney, problemText } from '../lib/format';

/**
 * Подписки.
 *
 * Здесь же живут персональные цены. Правило «четырёх глаз» соблюдается на
 * уровне БД: тот, кто назначил цену, физически не может её утвердить —
 * ограничение таблицы не даст сохранить такую запись. Интерфейс лишь честно
 * показывает, на каком шаге находится согласование.
 *
 * Активация подписки вручную — временная мера: платёжного провайдера пока нет,
 * поэтому оплату подтверждает человек, и каждое такое действие попадает
 * в журнал вместе с причиной.
 */
export function SubscriptionsPage({ adminId }: { adminId: string }) {
  const [items, setItems] = useState<AdminSubscription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.subscriptions());
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить подписки'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<unknown>, successText: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successText);
      await load();
    } catch (err) {
      setError(problemText(err, 'Операция не выполнена'));
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Подписки</h1>
          <p className="page-hint">
            Цена подписки фиксируется в момент оформления и не меняется при пересмотре тарифной
            сетки. Персональная цена назначается одним администратором и утверждается другим.
          </p>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      {items === null && <div className="spinner">Загрузка…</div>}

      {items !== null && items.length === 0 && <div className="card empty">Подписок пока нет.</div>}

      {items !== null && items.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Пользователь</th>
                <th>Тариф</th>
                <th>Проект</th>
                <th>Цена</th>
                <th>Статус</th>
                <th>Оформлена</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((sub) => (
                <tr key={sub.id}>
                  <td>{sub.userDisplayName}</td>
                  <td className="small">{sub.planCode}</td>
                  <td className="small">{sub.projectTitle ?? <span className="muted">—</span>}</td>
                  <td className="num">
                    {formatMoney(sub.priceSnapshot)}
                    {sub.customPrice && (
                      <div className="small muted">
                        персональная: {formatMoney(sub.customPrice)}
                        {!sub.customPriceApprovedBy && ' · ждёт утверждения'}
                      </div>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={sub.status} />
                  </td>
                  <td className="small">{formatDate(sub.createdAt)}</td>
                  <td>
                    <div className="row-actions">
                      {(sub.status === 'pending_payment' || sub.status === 'past_due') && (
                        <button
                          type="button"
                          className="btn--sm"
                          onClick={() => {
                            const reason = window.prompt(
                              'Основание активации (например, номер платёжного поручения):',
                            );
                            if (!reason) return;
                            void act(
                              () => api.activateSubscription(sub.id, reason),
                              'Подписка активирована.',
                            );
                          }}
                        >
                          Активировать
                        </button>
                      )}

                      {sub.customPrice && !sub.customPriceApprovedBy && (
                        <button
                          type="button"
                          className="btn--ghost btn--sm"
                          disabled={sub.customPriceSetBy === adminId}
                          title={
                            sub.customPriceSetBy === adminId
                              ? 'Назначивший цену не может утвердить её сам'
                              : undefined
                          }
                          onClick={() =>
                            void act(
                              () => api.approveCustomPrice(sub.id),
                              'Персональная цена утверждена.',
                            )
                          }
                        >
                          Утвердить цену
                        </button>
                      )}

                      <button
                        type="button"
                        className="btn--ghost btn--sm"
                        onClick={() => {
                          const price = window.prompt('Персональная цена, ₽ (например 149990.00):');
                          if (!price) return;
                          const reason = window.prompt('Основание (попадёт в журнал):');
                          if (!reason) return;
                          void act(
                            () => api.proposeCustomPrice(sub.id, { price, reason }),
                            'Цена назначена. Требуется утверждение вторым администратором.',
                          );
                        }}
                      >
                        Персональная цена
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

function StatusBadge({ status }: { status: AdminSubscription['status'] }) {
  const map: Record<AdminSubscription['status'], { cls: string; text: string }> = {
    active: { cls: 'badge--ok', text: 'активна' },
    pending_payment: { cls: 'badge--warn', text: 'ждёт оплаты' },
    past_due: { cls: 'badge--danger', text: 'просрочена' },
    canceled: { cls: 'badge--muted', text: 'отменена' },
    expired: { cls: 'badge--muted', text: 'истекла' },
  };
  const item = map[status];
  return <span className={`badge ${item.cls}`}>{item.text}</span>;
}
