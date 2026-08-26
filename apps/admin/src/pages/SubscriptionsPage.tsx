import { useCallback, useEffect, useState } from 'react';
import { PromptDialog } from '@unicorn/ui';
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
  /**
   * Диалоги вместо `window.prompt`.
   *
   * Основание действия уходит в неизменяемый журнал, и терять его из-за
   * настройки браузера, отключающей системные подсказки, нельзя.
   */
  const [activating, setActivating] = useState<string | null>(null);
  const [pricing, setPricing] = useState<{ id: string; price: string } | null>(null);
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
                          onClick={() => setActivating(sub.id)}
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
                        onClick={() => setPricing({ id: sub.id, price: '' })}
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

      <PromptDialog
        open={pricing !== null && pricing.price === ''}
        title="Персональная цена"
        description="Цену назначает один администратор, утверждает другой — так требует ограничение таблицы."
        label="Цена, ₽"
        placeholder="149990.00"
        confirmText="Дальше"
        onCancel={() => setPricing(null)}
        onConfirm={(price) => setPricing(pricing ? { ...pricing, price } : null)}
      />

      <PromptDialog
        open={pricing !== null && pricing.price !== ''}
        title="Основание персональной цены"
        description="Попадёт в журнал вместе с автором."
        label="Основание"
        confirmText="Назначить цену"
        onCancel={() => setPricing(null)}
        onConfirm={(reason) => {
          const current = pricing;
          setPricing(null);
          if (current)
            void act(
              () => api.proposeCustomPrice(current.id, { price: current.price, reason }),
              'Цена назначена. Требуется утверждение вторым администратором.',
            );
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
