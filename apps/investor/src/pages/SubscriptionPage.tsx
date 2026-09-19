import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Stack } from '@unicorn/ui';
import type { Pricing, Subscription } from '@unicorn/contracts';
import { ApiError, api } from '../api';

/**
 * Подписка инвестора.
 *
 * Показывает и текущее состояние, и цену — включая объявленные изменения
 * тарифов. Цена, о которой пользователь узнаёт в момент списания, противоречит
 * заявленной прозрачности, поэтому будущая цена видна заранее.
 */
export function SubscriptionPage() {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; subscriptions: Subscription[]; pricing: Pricing }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [subscriptions, pricing] = await Promise.all([
        api.billing.subscriptions(),
        api.pricing(),
      ]);
      setState({ status: 'ready', subscriptions, pricing });
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : 'Сервис недоступен',
        traceId: error instanceof ApiError ? error.traceId : null,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') return <LoadingState label="Загружаем подписку" />;
  if (state.status === 'error') {
    return (
      <ErrorState description={state.message} traceId={state.traceId} onRetry={() => void load()} />
    );
  }

  // Все тарифы теперь инвесторские (M094): подписка основателя отменена.
  const investorPlan = state.pricing.plans[0];
  const active = state.subscriptions.filter((item) => item.status === 'active');

  return (
    <Stack gap="var(--u-space-5)">
      <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>Подписка</h1>

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

      {state.subscriptions.length === 0 ? (
        <EmptyState
          title="Подписки нет"
          description="Подписка инвестора открывает полные карточки проектов и участие в предложениях."
        />
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: 'var(--u-space-3)',
          }}
        >
          {state.subscriptions.map((item) => (
            <li key={item.id}>
              <Card style={{ display: 'grid', gap: 'var(--u-space-2)' }}>
                <Badge tone={item.status === 'active' ? 'success' : 'warning'}>{item.status}</Badge>
                <strong>{item.planCode}</strong>
                <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                  {item.currentPeriodEnd
                    ? `Действует до ${new Date(item.currentPeriodEnd).toLocaleDateString('ru-RU')}`
                    : 'Период не начат: активацию подтверждает оператор'}
                </span>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {investorPlan && active.length === 0 ? (
        <Card>
          <Stack>
            <strong>{investorPlan.name}</strong>
            <span style={{ fontSize: 'var(--u-text-lg)', fontWeight: 700 }}>
              {investorPlan.price === null
                ? 'Индивидуально'
                : `${investorPlan.price} ${investorPlan.currency}`}
            </span>
            <Button
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setNotice(null);
                try {
                  await api.billing.subscribe({
                    // План не передаётся: его выбирает сервер. Возможность
                    // назвать план в запросе означала бы «выберу подешевле».
                    // Ключ идемпотентности обязателен: повтор отправки формы
                    // не должен создавать вторую подписку.
                    idempotencyKey: crypto.randomUUID(),
                  });
                  setNotice({ tone: 'ok', text: 'Подписка оформлена' });
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
                  setBusy(false);
                }
              }}
            >
              Оформить подписку
            </Button>
            <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
              Активацию подтверждает оператор: платёжного провайдера в контуре пока нет, и подписка
              не начинает действовать автоматически.
            </span>
          </Stack>
        </Card>
      ) : null}

      {state.pricing.announcedPlans.length > 0 ? (
        <Card style={{ borderColor: 'var(--u-warning)' }}>
          <Stack gap="var(--u-space-2)">
            <strong>Объявленные изменения тарифов</strong>
            <ul style={{ margin: 0, paddingLeft: 'var(--u-space-5)' }}>
              {state.pricing.announcedPlans.map((plan) => (
                <li key={plan.id} style={{ color: 'var(--u-text-muted)' }}>
                  {plan.name}: {plan.price ?? 'индивидуально'} — с{' '}
                  {new Date(plan.validFrom).toLocaleDateString('ru-RU')}
                </li>
              ))}
            </ul>
          </Stack>
        </Card>
      ) : null}
    </Stack>
  );
}
