import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Stack } from '@unicorn/ui';
import type { CommissionAccrual, Invoice } from '@unicorn/contracts';
import { ApiError, api } from '../api';

/**
 * Счета и начисления вознаграждения.
 *
 * До этого экрана денежная сторона кабинета была доступна только через
 * служебную консоль: подписка оформлялась в интерфейсе, а что за неё выставлено
 * и сколько платформа удержала со сделки — нигде.
 *
 * Два свойства, которые здесь важнее вёрстки:
 *
 *  * **Начисление показывается ПОЛНОСТЬЮ, с базой.** База — полная сумма
 *    договора, а не размер полученного транша, и начисляется однократно
 *    (ADR-005). Показать одну итоговую цифру значило бы скрыть ровно то, из-за
 *    чего у людей возникают вопросы к платформе.
 *  * **Оплата не изображается.** Платёжный провайдер не подключён, и сервер
 *    отвечает `feature_disabled`. Кнопка «Оплатить», ведущая в отказ, — хуже
 *    честной строки о том, что счёт оплачивается по реквизитам.
 */
export function BillingPage() {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; invoices: Invoice[]; accruals: CommissionAccrual[] }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
  const [payNotice, setPayNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [invoices, accruals] = await Promise.all([
        api.billing.invoices(),
        api.billing.accruals(),
      ]);
      setState({ status: 'ready', invoices, accruals });
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

  if (state.status === 'loading') return <LoadingState label="Загружаем счета" />;
  if (state.status === 'error') {
    return (
      <ErrorState description={state.message} traceId={state.traceId} onRetry={() => void load()} />
    );
  }

  return (
    <Stack gap="var(--u-space-5)">
      <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>Счета и вознаграждение</h1>

      {payNotice ? (
        <div
          role="status"
          style={{
            padding: 'var(--u-space-3) var(--u-space-4)',
            borderRadius: 'var(--u-radius-md)',
            background: 'var(--u-warning-subtle)',
            color: 'var(--u-warning)',
          }}
        >
          {payNotice}
        </div>
      ) : null}

      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Счета</h2>
          {state.invoices.length === 0 ? (
            <EmptyState
              title="Счетов нет"
              description="Счёт появляется после оформления подписки или начисления вознаграждения по сделке."
            />
          ) : (
            <ul style={LIST_STYLE}>
              {state.invoices.map((invoice) => (
                <li key={invoice.id} style={ROW_STYLE}>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      № {invoice.number}{' '}
                      <Badge tone={invoiceTone(invoice.status)}>{invoice.status}</Badge>
                    </div>
                    <div style={MUTED_STYLE}>
                      {invoice.amountDue} {invoice.currency} · выставлен{' '}
                      {new Date(invoice.issuedAt).toLocaleDateString('ru-RU')} · оплатить до{' '}
                      {new Date(invoice.dueAt).toLocaleDateString('ru-RU')}
                    </div>
                  </div>
                  {invoice.status === 'paid' || invoice.status === 'void' ? null : (
                    <Button
                      variant="secondary"
                      loading={busy === invoice.id}
                      onClick={async () => {
                        setBusy(invoice.id);
                        setPayNotice(null);
                        try {
                          const payment = await api.billing.pay({
                            invoiceId: invoice.id,
                            amount: invoice.amountDue,
                            currency: invoice.currency,
                            idempotencyKey: crypto.randomUUID(),
                          });
                          // Провайдер подключат позже; когда это случится,
                          // ответ принесёт адрес его страницы оплаты.
                          if (payment.confirmationUrl) {
                            window.location.assign(payment.confirmationUrl);
                            return;
                          }
                          setPayNotice('Платёж создан, подтверждение придёт от провайдера.');
                        } catch (error) {
                          // Отказ показывается словами сервера: он один знает,
                          // подключён ли приём платежей и по какой причине нет.
                          setPayNotice(
                            error instanceof ApiError
                              ? (error.problem?.detail ?? error.message)
                              : 'Сервис недоступен',
                          );
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      Оплатить
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <span style={MUTED_STYLE}>
            Приём платежей картой пока не подключён — счёт оплачивается по реквизитам, поступление
            сверяет оператор.
          </span>
        </Stack>
      </Card>

      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Вознаграждение платформы</h2>
          {state.accruals.length === 0 ? (
            <EmptyState
              title="Начислений нет"
              description="Вознаграждение начисляется один раз — после обеих подписей и подтверждённого банком первого транша."
            />
          ) : (
            <ul style={LIST_STYLE}>
              {state.accruals.map((accrual) => (
                <li key={accrual.id} style={{ ...ROW_STYLE, display: 'block' }}>
                  <div style={{ fontWeight: 600 }}>
                    {accrual.investorFeeAmount} {accrual.currency}{' '}
                    <Badge tone={accrual.status === 'paid' ? 'success' : 'warning'}>
                      {accrual.status}
                    </Badge>
                  </div>
                  {/*
                    База и ставка показаны рядом с суммой намеренно: вопрос «за
                    что списали столько» возникает именно тогда, когда видна
                    одна итоговая цифра.
                  */}
                  <div style={MUTED_STYLE}>
                    {accrual.investorFeePct}% от {accrual.baseAmount} {accrual.currency} — полной
                    суммы договора, однократно
                  </div>
                  <div style={MUTED_STYLE}>
                    начислено {new Date(accrual.accruedAt).toLocaleDateString('ru-RU')}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}

const LIST_STYLE = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gap: 'var(--u-space-3)',
} as const;

const ROW_STYLE = {
  display: 'flex',
  gap: 'var(--u-space-3)',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  borderTop: '1px solid var(--u-border)',
  paddingTop: 'var(--u-space-3)',
} as const;

const MUTED_STYLE = {
  color: 'var(--u-text-muted)',
  fontSize: 'var(--u-text-sm)',
} as const;

function invoiceTone(status: Invoice['status']): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'paid') return 'success';
  if (status === 'overdue') return 'danger';
  if (status === 'void' || status === 'adjusted') return 'neutral';
  return 'warning';
}
