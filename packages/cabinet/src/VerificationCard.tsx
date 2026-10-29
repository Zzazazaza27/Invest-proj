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

/**
 * Верификация личности.
 *
 * До этого блока подать проверку мог только инвестор: у него экран был, у
 * основателя — нет. При этом публикация листинга требует действующей
 * верификации, и сервер честно отвечал «Требуется пройти верификацию» — а
 * пойти основателю было некуда. Обязательный шаг существовал в API и
 * отсутствовал в кабинете, то есть человек упирался в стену без выхода.
 *
 * Блок общий (`@unicorn/cabinet`): требования к подтверждению личности у
 * основателя и инвестора одни и те же, расходиться этим экранам нельзя.
 * Набор видов проверки задаётся кабинетом: основателю нужна личность,
 * инвестору — ещё статус инвестора и квалификация.
 *
 * Экран НЕ принимает документы и не хранит их: он открывает проверку и
 * показывает состояние. Документы уходят провайдеру верификации, платформа
 * получает только результат — поэтому здесь нет ни поля для скана, ни номера
 * документа. Причина отказа показывается ровно так, как её отдал сервер:
 * обобщённой формулировкой, внутренние основания комплаенса наружу не идут.
 */
export type VerificationDocType = 'passport' | 'foreign_passport' | 'id_card' | 'driver_license';

export interface VerificationPort {
  status: () => Promise<KycVerification[]>;
  start: (body: {
    kind: 'identity' | 'investor_status' | 'accredited';
    docType: VerificationDocType;
    docCountry: string;
  }) => Promise<unknown>;
}

export type VerificationKind = 'identity' | 'investor_status' | 'accredited';

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

export function VerificationCard({
  port,
  kinds = ['identity'],
  description,
}: {
  port: VerificationPort;
  kinds?: VerificationKind[];
  description?: string;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: KycVerification[] }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [kind, setKind] = useState<VerificationKind>(kinds[0] ?? 'identity');
  const [docType, setDocType] = useState<(typeof DOC_TYPES)[number]['value']>('passport');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', items: await port.status() });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Сервис недоступен',
      });
    }
  }, [port]);

  useEffect(() => {
    void load();
  }, [load]);

  const start = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      await port.start({ kind, docType, docCountry: 'RU' });
      setNotice({ tone: 'ok', text: 'Проверка открыта. Результат появится в списке ниже.' });
      await load();
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Сервис недоступен',
      });
    } finally {
      setBusy(false);
    }
  }, [kind, docType, load, port]);

  return (
    <Card>
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Верификация личности</h2>
        <p style={{ margin: 0, color: 'var(--u-text-muted)' }}>
          {description ??
            'Публикация проекта открывается только с подтверждённой личностью. Документы платформа не хранит: проверку проводит провайдер верификации, сюда приходит только её результат.'}
        </p>

        {kinds.length > 1 ? (
          <Field label="Что подтверждаем" htmlFor="kyc-kind">
            <select
              id="kyc-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as VerificationKind)}
              style={selectStyle}
            >
              {kinds.map((value) => (
                <option key={value} value={value}>
                  {KIND_TITLES[value] ?? value}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

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

        {state.status === 'loading' ? <LoadingState label="Загружаем проверки" /> : null}
        {state.status === 'error' ? (
          <ErrorState description={state.message} onRetry={() => void load()} />
        ) : null}
        {state.status === 'ready' && state.items.length === 0 ? (
          <EmptyState
            title="Проверок ещё не было"
            description="Откройте проверку личности — без неё публикация закрыта."
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
