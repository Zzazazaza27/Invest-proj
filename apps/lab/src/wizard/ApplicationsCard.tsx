import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  ErrorState,
  LoadingState,
  SectionCard,
  Stack,
  describeRaising,
  formatMoney,
  raisingTone,
} from '@unicorn/ui';
import type { ApplicationList, FundingRound } from '@unicorn/contracts';
import { raisingState } from '@unicorn/contracts';
import { ApiError, api } from '../api';
import { S } from '../strings';

/**
 * Заявки проекта в кабинете v2 (этап 4): список, остаток по политике,
 * создание новой и переход в мастер. У проекта может быть несколько заявок;
 * каждая живёт на своей версии анкеты и подаётся отдельно.
 *
 * Строка раунда (этап 5.6.4): состояние привлечения — из раундов проекта, не
 * из суммы заявки; переход к раунду идёт через мастер последней заявки.
 */
export function ApplicationsCard({
  projectId,
  onOpen,
  onOpenRound,
}: {
  projectId: string;
  onOpen: (applicationId: string) => void;
  onOpenRound?: (applicationId: string) => void;
}) {
  const [rounds, setRounds] = useState<FundingRound[] | null>(null);
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; list: ApplicationList }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, roundList] = await Promise.all([
        api.applications.list(projectId),
        api.rounds.list(projectId),
      ]);
      setState({ status: 'ready', list });
      setRounds(roundList.items);
    } catch (e) {
      setState({
        status: 'error',
        message: e instanceof ApiError ? (e.problem?.detail ?? e.message) : 'Сервис недоступен',
        traceId: e instanceof ApiError ? e.traceId : null,
      });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setCreating(true);
    setNotice(null);
    try {
      const created = await api.applications.create(projectId, {});
      onOpen(created.id);
    } catch (e) {
      setNotice(e instanceof ApiError ? (e.problem?.detail ?? e.message) : 'Сервис недоступен');
    } finally {
      setCreating(false);
    }
  };

  const limits = state.status === 'ready' ? state.list.limits : null;
  const unfinished = rounds?.find((r) => r.status === 'open' || r.status === 'paused') ?? null;
  const draft = rounds?.find((r) => r.status === 'draft') ?? null;
  const raising = {
    raising: raisingState(unfinished),
    investmentAsk: unfinished?.target ?? null,
    askCurrency: unfinished?.currency ?? 'RUB',
  };
  const latestOpenable =
    state.status === 'ready'
      ? (state.list.items.find((i) => i.status !== 'archived' && i.schemaVersion > 0) ?? null)
      : null;

  return (
    <SectionCard
      icon="document"
      title={S.applications.title}
      description={S.applications.description}
      actions={
        <Button
          variant="brand"
          loading={creating}
          disabled={limits !== null && limits.applications.remaining <= 0}
          onClick={() => void create()}
        >
          {S.applications.create}
        </Button>
      }
    >
      <Stack gap="var(--u-space-3)">
        {limits ? (
          <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
            {S.applications.remaining(limits.applications.used, limits.applications.limit)}
            {limits.maxAskPerApplication
              ? ` · сумма одной заявки до ${formatMoney(limits.maxAskPerApplication, 'RUB')}`
              : ''}
          </span>
        ) : null}
        {rounds && onOpenRound ? (
          <div
            data-round-line={raising.raising}
            style={{
              display: 'flex',
              gap: 'var(--u-space-3)',
              alignItems: 'center',
              flexWrap: 'wrap',
              padding: 'var(--u-space-3)',
              border: '1px solid var(--u-border)',
              borderRadius: 'var(--u-radius-md)',
            }}
          >
            <Badge tone={raisingTone(raising.raising)}>{describeRaising(raising)}</Badge>
            {draft ? <Badge tone="accent">{S.round.state.draft}</Badge> : null}
            <span style={{ flex: 1 }} />
            {latestOpenable ? (
              <Button variant="secondary" onClick={() => onOpenRound(latestOpenable.id)}>
                {unfinished || draft ? S.round.intro.toRound : S.round.intro.yes}
              </Button>
            ) : null}
          </div>
        ) : null}
        {notice ? (
          <div role="alert" style={{ color: 'var(--u-danger)' }}>
            {notice}
          </div>
        ) : null}
        {state.status === 'loading' ? <LoadingState label="Загружаем заявки" /> : null}
        {state.status === 'error' ? (
          <ErrorState
            description={state.message}
            traceId={state.traceId}
            onRetry={() => void load()}
          />
        ) : null}
        {state.status === 'ready' && state.list.items.length === 0 ? (
          <span style={{ color: 'var(--u-text-muted)' }}>{S.applications.empty}</span>
        ) : null}
        {state.status === 'ready'
          ? state.list.items.map((item) => (
              <div
                key={item.id}
                data-application={item.id}
                style={{
                  display: 'flex',
                  gap: 'var(--u-space-3)',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: 'var(--u-space-3)',
                  border: '1px solid var(--u-border)',
                  borderRadius: 'var(--u-radius-md)',
                }}
              >
                <div style={{ flex: 1, minWidth: 200, display: 'grid', gap: 'var(--u-space-1)' }}>
                  <strong>{item.title ?? S.applications.untitled}</strong>
                  <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                    {S.applications.stage[item.stage] ?? item.stage} ·{' '}
                    {S.applications.version(item.schemaVersion)}
                    {item.schemaVersion === 0 && item.investmentAsk
                      ? ` · ${formatMoney(item.investmentAsk, item.askCurrency)} (старая форма)`
                      : ''}
                  </span>
                </div>
                <Badge
                  tone={
                    item.status === 'submitted'
                      ? 'success'
                      : item.status === 'archived'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {S.applications.status[item.status] ?? item.status}
                </Badge>
                {item.status !== 'archived' ? (
                  <Button variant="secondary" onClick={() => onOpen(item.id)}>
                    {S.applications.open}
                  </Button>
                ) : null}
              </div>
            ))
          : null}
      </Stack>
    </SectionCard>
  );
}
