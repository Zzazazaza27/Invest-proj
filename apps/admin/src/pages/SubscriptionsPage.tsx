import { useCallback, useEffect, useState } from 'react';
import { PromptDialog } from '@unicorn/ui';
import type { AdminSubscription } from '@unicorn/contracts';
import { api } from '../api';
import { formatDate, formatMoney, problemText } from '../lib/format';

/**
 * Подписки инвесторов.
 *
 * Подписка основателя по сумме привлечения отменена (M094): запуск раунда
 * оплачивается разово покупкой пакета (5.9), поэтому здесь только подписки
 * аккаунта инвестора. Персональная цена удалена вместе с тарифом, ради
 * которого она существовала.
 *
 * Активация подписки вручную — временная мера: платёжного провайдера пока нет,
 * поэтому оплату подтверждает человек, и каждое такое действие попадает
 * в журнал вместе с причиной.
 */
export function SubscriptionsPage() {
  /**
   * Диалоги вместо `window.prompt`.
   *
   * Основание действия уходит в неизменяемый журнал, и терять его из-за
   * настройки браузера, отключающей системные подсказки, нельзя.
   */
  const [activating, setActivating] = useState<string | null>(null);
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
            Ежемесячные подписки инвесторов. Цена фиксируется в момент оформления и не меняется при
            пересмотре тарифной сетки.
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
                  <td className="num">{formatMoney(sub.priceSnapshot)}</td>
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
                          onClick={() => setActivating(sub.id)}
                        >
                          Активировать
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PromptDialog
        open={activating !== null}
        title="Активация подписки"
        description="Платёжный провайдер не подключён: активацию подтверждает оператор, а основание попадает в неизменяемый журнал."
        label="Основание активации"
        placeholder="Например, номер платёжного поручения"
        confirmText="Активировать"
        onCancel={() => setActivating(null)}
        onConfirm={(reason) => {
          const id = activating;
          setActivating(null);
          if (id) void act(() => api.activateSubscription(id, reason), 'Подписка активирована.');
        }}
      />
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
  // Значение по умолчанию, а не «!»: статус приходит с сервера, и контракт
  // может расшириться раньше, чем этот файл — падать из-за этого нельзя.
  const item = map[status] ?? { cls: 'badge--muted', text: status };
  return <span className={`badge ${item.cls}`}>{item.text}</span>;
}
