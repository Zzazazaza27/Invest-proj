import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Stack,
} from '@unicorn/ui';
import type { KycVerification } from '@unicorn/contracts';
import { ApiError, api } from '../api';

const KIND_TITLES: Record<string, string> = {
  identity: 'Личность',
  investor_status: 'Статус инвестора',
  accredited: 'Квалифицированный инвестор',
};

const STATUS_TITLES: Record<string, string> = {
  pending: 'подана',
  in_review: 'на проверке',
  approved: 'подтверждена',
  rejected: 'отклонена',
  verification_pending: 'ждёт подтверждения',
};

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning'> = {
  pending: 'neutral',
  in_review: 'accent',
  approved: 'success',
  rejected: 'warning',
  verification_pending: 'accent',
};

const DOC_TYPES = [
  { value: 'passport', title: 'Паспорт РФ' },
  { value: 'foreign_passport', title: 'Загранпаспорт' },
  { value: 'id_card', title: 'ID-карта' },
  { value: 'driver_license', title: 'Водительское удостоверение' },
] as const;

/**
 * Верификация инвестора.
 *
 * Экран НЕ принимает документы и не хранит их: он открывает проверку и
 * показывает её состояние. Сами документы уходят провайдеру верификации, и
 * платформа получает от него результат — поэтому здесь нет ни поля для скана,
 * ни номера документа.
 *
 * Причина отказа показывается ровно так, как её отдаёт сервер: обобщённой
 * формулировкой. Внутренние основания комплаенса наружу не выходят.
 */
export function VerificationPage() {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: KycVerification[] }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
  const [kind, setKind] = useState<'identity' | 'investor_status' | 'accredited'>('identity');
  const [docType, setDocType] = useState<(typeof DOC_TYPES)[number]['value']>('passport');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', items: await api.kyc.status() });
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

  const start = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      await api.kyc.start({ kind, docType, docCountry: 'RU' });
      setNotice({ tone: 'ok', text: 'Проверка открыта. Результат появится в списке ниже.' });
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
  }, [kind, docType, load]);

  return (
    <Stack gap="var(--u-space-5)">
      <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>Верификация</h1>

      <Card>
        <Stack>
          <p style={{ margin: 0, color: 'var(--u-text-muted)' }}>
            Подтверждённая личность нужна для участия в предложениях регулируемого контура.
            Документы платформа не хранит: проверку проводит провайдер верификации, сюда приходит
            только её результат.
          </p>

          <Field label="Что подтверждаем" htmlFor="kyc-kind">
            <select
              id="kyc-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as typeof kind)}
              style={selectStyle}
            >
              {Object.entries(KIND_TITLES).map(([value, title]) => (
                <option key={value} value={value}>
                  {title}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Документ" htmlFor="kyc-doc">
            <select
              id="kyc-doc"
              value={docType}
              onChange={(event) => setDocType(event.target.value as typeof docType)}
              style={selectStyle}
            >
              {DOC_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.title}
                </option>
              ))}
            </select>
          </Field>

          <Button onClick={() => void start()} loading={busy}>
            Открыть проверку
          </Button>

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
        </Stack>
      </Card>

      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Мои проверки</h2>

          {state.status === 'loading' ? <LoadingState label="Загружаем проверки" /> : null}
          {state.status === 'error' ? (
            <ErrorState
              description={state.message}
              traceId={state.traceId}
              onRetry={() => void load()}
            />
          ) : null}
          {state.status === 'ready' && state.items.length === 0 ? (
            <EmptyState
              title="Проверок ещё не было"
              description="Откройте проверку личности — без неё регулируемый контур недоступен."
            />
          ) : null}
          {state.status === 'ready' && state.items.length > 0 ? (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: 'var(--u-space-3)',
              }}
            >
              {state.items.map((item) => (
                <li key={item.id} style={{ display: 'grid', gap: 'var(--u-space-2)' }}>
                  <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
                    <Badge tone={STATUS_TONE[item.status] ?? 'neutral'}>
                      {STATUS_TITLES[item.status] ?? item.status}
                    </Badge>
                    <strong>{KIND_TITLES[item.kind] ?? item.kind}</strong>
                    {item.expiresAt ? (
                      <Badge>
                        действует до {new Date(item.expiresAt).toLocaleDateString('ru-RU')}
                      </Badge>
                    ) : null}
                  </div>
                  {item.rejectionSummary ? (
                    <span style={{ color: 'var(--u-text-muted)' }}>{item.rejectionSummary}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Stack>
      </Card>

      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Подтверждение операций</h2>
          <p style={{ margin: 0, color: 'var(--u-text-muted)' }}>
            Приём предложения и подпись договора требуют подтверждения вторым фактором. В этой
            сборке второй фактор недоступен: локальный адаптер входа его не выдаёт, и сервер
            отвечает на такие операции отказом <code>step_up_required</code>. Это ожидаемое
            поведение, а не сбой — путь откроется вместе с подключением внешнего провайдера входа.
          </p>
        </Stack>
      </Card>
    </Stack>
  );
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: 'var(--u-space-3)',
  borderRadius: 'var(--u-radius-md)',
  border: '1px solid var(--u-border)',
  background: 'var(--u-surface)',
  color: 'var(--u-text)',
  font: 'inherit',
};
