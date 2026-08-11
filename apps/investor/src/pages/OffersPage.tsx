import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, EmptyState, ErrorState, LoadingState, Stack } from '@unicorn/ui';
import type { InvestmentOffer } from '@unicorn/contracts';
import { ApiError, api } from '../api';

/**
 * Инвестиционные предложения.
 *
 * Регулируемый контур выключен фичефлагом до включения оператора в реестр ОИП.
 * Это состояние ПРОДУКТА, а не сбой, и показывать его пустым списком нельзя:
 * из пустого списка читается «предложений сейчас нет», то есть неправда о
 * доступности функции. Сервер отвечает `feature_disabled` — кабинет так и
 * говорит.
 */
export function OffersPage() {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: InvestmentOffer[] }
    | { status: 'disabled'; message: string }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const page = await api.investments.offers({ limit: 24 });
      setState({ status: 'ready', items: page.items });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'feature_disabled') {
        setState({
          status: 'disabled',
          message: error.problem?.detail ?? 'Функция пока недоступна',
        });
        return;
      }
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

  return (
    <Stack gap="var(--u-space-5)">
      <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>Инвестиционные предложения</h1>

      {state.status === 'loading' ? <LoadingState label="Загружаем предложения" /> : null}

      {state.status === 'disabled' ? (
        <Card style={{ borderColor: 'var(--u-warning)' }}>
          <Stack gap="var(--u-space-2)">
            <Badge tone="warning">Контур выключен</Badge>
            <strong>Инвестиционный контур пока не работает</strong>
            <span style={{ color: 'var(--u-text-muted)' }}>
              {state.message} Функция включится после внесения оператора в реестр инвестиционных
              платформ Банка России и согласования Правил платформы. До этого момента договоры не
              заключаются — ни через кабинет, ни иным способом.
            </span>
          </Stack>
        </Card>
      ) : null}

      {state.status === 'error' ? (
        <ErrorState
          description={state.message}
          traceId={state.traceId}
          onRetry={() => void load()}
        />
      ) : null}

      {state.status === 'ready' && state.items.length === 0 ? (
        <EmptyState
          title="Открытых предложений нет"
          description="Здесь появятся предложения проектов, доступные вам по подписке и верификации."
        />
      ) : null}

      {state.status === 'ready' && state.items.length > 0 ? (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: 'var(--u-space-4)',
          }}
        >
          {state.items.map((offer) => (
            <li key={offer.id}>
              <Card style={{ display: 'grid', gap: 'var(--u-space-2)' }}>
                <Badge tone="accent">{offer.status}</Badge>
                <strong>{offer.instrumentType}</strong>
                <span>
                  Цель: {offer.targetAmount} {offer.currency} · минимум {offer.minInvestment}
                </span>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </Stack>
  );
}
