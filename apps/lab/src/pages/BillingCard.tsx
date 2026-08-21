import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Stack } from '@unicorn/ui';
import type { Invoice, Pricing, Subscription } from '@unicorn/contracts';
import { ApiError, api } from '../api';

/**
 * Подписка проекта и счета.
 *
 * До этой карточки основатель видел в кабинете отказ «публикация требует
 * активной подписки» — и не имел в интерфейсе НИ ОДНОГО способа её оформить:
 * подписка существовала только в служебной консоли. Отказ, не ведущий к
 * действию, которое его снимает, — это тупик, а не защита.
 *
 * Тариф здесь не выбирается: его резолвит сервер из суммы запроса проекта.
 * Выбор плана на стороне клиента означал бы, что цену можно занизить, подставив
 * чужой идентификатор, — поэтому в запрос уходит ПРОЕКТ, а не план.
 */
export function BillingCard({
  projectId,
  requiredPlanId,
}: {
  projectId: string;
  requiredPlanId: string | null;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; subscriptions: Subscription[]; invoices: Invoice[]; pricing: Pricing }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [subscriptions, invoices, pricing] = await Promise.all([
        api.billing.subscriptions(),
        api.billing.invoices(),
        api.pricing(),
      ]);
      setState({ status: 'ready', subscriptions, invoices, pricing });
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : 'Сервис недоступен',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, action: () => Promise<unknown>, okText: string): Promise<void> {
    setBusy(key);
    setNotice(null);
    try {
      await action();
      setNotice({ tone: 'ok', text: okText });
      await load();
    } catch (error) {
      setNotice({
        tone: 'error',
        text:
          error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : 'Сервис недоступен',
      });
    } finally {
      setBusy(null);
    }
  }

  if (state.status === 'loading') return <LoadingState label="Загружаем подписку" />;
  if (state.status === 'error') {
    return <ErrorState description={state.message} onRetry={() => void load()} />;
  }

  // Подписки и счета кабинета — общие для человека; к этому проекту относятся
  // только те, что на него оформлены. Показывать чужие здесь незачем: они
  // видны в карточках своих проектов.
  const own = state.subscriptions.filter((item) => item.projectId === projectId);
  // Статусы подписки — из контракта: active | pending_payment | past_due |
  // canceled | expired. «Действующей» считается только active: оформлять
  // вторую поверх ожидающей оплаты незачем, но и публикацию она не открывает.
  const active = own.find((item) => item.status === 'active');
  const pending = own.find((item) => item.status === 'pending_payment');
  const plan = requiredPlanId
    ? state.pricing.plans.find((item) => item.id === requiredPlanId)
    : undefined;
  const invoices = state.invoices.filter((invoice) =>
    own.some((subscription) => subscription.id === invoice.subscriptionId),
  );

  return (
    <Card>
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Подписка и счета</h2>

        {notice ? (
          <div
            role={notice.tone === 'error' ? 'alert' : 'status'}
            style={{
              padding: 'var(--u-space-3) var(--u-space-4)',
              borderRadius: 'var(--u-radius-md)',
              background:
                notice.tone === 'error' ? 'var(--u-danger-subtle)' : 'var(--u-success-subtle)',
              color: notice.tone === 'error' ? 'var(--u-danger)' : 'var(--u-success)',
            }}
          >
            {notice.text}
          </div>
        ) : null}

        {own.length === 0 ? (
          <EmptyState
            title="Подписки на проект нет"
            description="Публикация листинга открывается активной подпиской. Тариф определяется суммой запроса — выбирать его не нужно."
          />
        ) : (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: 'var(--u-space-2)',
            }}
          >
            {own.map((item) => (
              <li
                key={item.id}
                style={{
                  display: 'flex',
                  gap: 'var(--u-space-3)',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {item.planCode}{' '}
                    <Badge tone={item.status === 'active' ? 'success' : 'warning'}>
                      {item.status}
                    </Badge>
                  </div>
                  <div style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                    {item.priceSnapshot} {item.currency}
                    {item.currentPeriodEnd
                      ? ` · до ${new Date(item.currentPeriodEnd).toLocaleDateString('ru-RU')}`
                      : ' · период не начат: активацию подтверждает оператор'}
                  </div>
                </div>
                {item.status === 'active' || item.status === 'pending_payment' ? (
                  <Button
                    variant="danger"
                    loading={busy === `cancel:${item.id}`}
                    onClick={() =>
                      void run(
                        `cancel:${item.id}`,
                        () => api.billing.cancel(item.id),
                        'Подписка отменена',
                      )
                    }
                  >
                    Отменить
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {!active && !pending ? (
          <div style={{ display: 'grid', gap: 'var(--u-space-2)' }}>
            {plan ? (
              <span>
                Тариф проекта: <strong>{plan.name}</strong>{' '}
                {plan.individualPricing || plan.price === null
                  ? '— цена индивидуальная, назначает оператор'
                  : `— ${plan.price} ${plan.currency} в месяц`}
              </span>
            ) : (
              <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                Тариф определится сервером по сумме запроса при оформлении.
              </span>
            )}
            <Button
              loading={busy === 'subscribe'}
              onClick={() =>
                void run(
                  'subscribe',
                  () =>
                    api.billing.subscribe({
                      audience: 'founder',
                      projectId,
                      // Ключ идемпотентности обязателен: повторное нажатие на
                      // медленном канале не должно оформлять вторую подписку.
                      idempotencyKey: crypto.randomUUID(),
                    }),
                  'Подписка оформлена',
                )
              }
            >
              Оформить подписку
            </Button>
          </div>
        ) : null}

        <div style={{ borderTop: '1px solid var(--u-border)', paddingTop: 'var(--u-space-3)' }}>
          <strong>Счета по проекту</strong>
          {invoices.length === 0 ? (
            <p
              style={{
                color: 'var(--u-text-muted)',
                fontSize: 'var(--u-text-sm)',
                margin: 'var(--u-space-2) 0 0',
              }}
            >
              Счетов нет. Счёт выставляется на оформленную подписку.
            </p>
          ) : (
            <ul style={{ margin: 'var(--u-space-2) 0 0', paddingLeft: 'var(--u-space-5)' }}>
              {invoices.map((invoice) => (
                <li key={invoice.id}>
                  № {invoice.number} — {invoice.amountDue} {invoice.currency}, {invoice.status}, до{' '}
                  {new Date(invoice.dueAt).toLocaleDateString('ru-RU')}
                </li>
              ))}
            </ul>
          )}
          <p
            style={{
              color: 'var(--u-text-muted)',
              fontSize: 'var(--u-text-sm)',
              margin: 'var(--u-space-2) 0 0',
            }}
          >
            Приём платежей картой пока не подключён — счёт оплачивается по реквизитам.
          </p>
        </div>
      </Stack>
    </Card>
  );
}
