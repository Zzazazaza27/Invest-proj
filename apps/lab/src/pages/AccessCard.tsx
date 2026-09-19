import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Stack,
} from '@unicorn/ui';
import type { GrantPermission, ProjectAccessEntry, ProjectAccessList } from '@unicorn/contracts';
import { ApiError, api } from '../api';
import { S } from '../strings';

const PERMISSIONS: GrantPermission[] = ['profile', 'round', 'materials', 'passport', 'extended'];

/**
 * «Кому открыт доступ» — выдача и отзыв разрешений, исключения (5.8.2).
 *
 * Карточка говорит владельцу три вещи, которые легко перепутать:
 *
 *  1. разрешение — НАБОР частей, а не уровень: отмечены материалы — открыты
 *     материалы, ответы анкеты при этом закрыты;
 *  2. тизер открывается вместе с любым разрешением — иначе получатель не
 *     нашёл бы проект и не понял, о чём речь;
 *  3. выданное действует в режиме «Выбранные инвесторы»; при другом режиме
 *     записи остаются, но доступ определяет режим — об этом сказано прямо,
 *     а не оставлено догадкой.
 *
 * Права проверяет сервер: скрытая кнопка защитой не является.
 */
export function AccessCard({
  projectId,
  visibility,
}: {
  projectId: string;
  /** Режим проекта — чтобы честно сказать, действует ли выданное. */
  visibility: string;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; list: ProjectAccessList }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [email, setEmail] = useState('');
  const [permissions, setPermissions] = useState<GrantPermission[]>(['profile']);
  const [reason, setReason] = useState('');
  const [excludeEmail, setExcludeEmail] = useState('');
  const [fieldError, setFieldError] = useState<{ grant?: string; exclude?: string }>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', list: await api.projects.access(projectId) });
    } catch (e) {
      setState({
        status: 'error',
        message: e instanceof ApiError ? (e.problem?.detail ?? e.message) : 'Сервис недоступен',
      });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Действие с одним местом для ответа сервера. Ошибка поля (неизвестный
   * адрес) показывается У ПОЛЯ, остальное — общим сообщением: «не найдено»
   * под кнопкой не подсказывает, что именно исправить.
   */
  const run = async (
    key: string,
    field: 'grant' | 'exclude' | null,
    action: () => Promise<unknown>,
    okText: string,
  ) => {
    setBusy(key);
    setNotice(null);
    setFieldError({});
    try {
      await action();
      setNotice({ tone: 'ok', text: okText });
      await load();
    } catch (e) {
      const problem = e instanceof ApiError ? e.problem : null;
      const emailError = (problem?.errors ?? []).find((x) => x.path === 'email');
      if (field && emailError) {
        setFieldError({ [field]: emailError.message });
      } else {
        setNotice({
          tone: 'error',
          text: e instanceof ApiError ? (problem?.detail ?? e.message) : 'Сервис недоступен',
        });
      }
    } finally {
      setBusy(null);
    }
  };

  const list = state.status === 'ready' ? state.list : null;
  const modeMismatch = visibility !== 'selected_investors';

  return (
    <Card data-access-card data-access-mode={visibility}>
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>{S.access.title}</h2>
        <p style={{ margin: 0, color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
          {S.access.note}
        </p>
        {modeMismatch ? (
          <p
            data-access-mode-hint
            style={{ margin: 0, fontSize: 'var(--u-text-sm)', color: 'var(--u-warning)' }}
          >
            {S.access.modeHint}
          </p>
        ) : null}

        {state.status === 'loading' ? <LoadingState label={S.access.loading} /> : null}
        {state.status === 'error' ? (
          <ErrorState description={state.message} onRetry={() => void load()} />
        ) : null}

        {list ? (
          <>
            {list.grants.length === 0 ? (
              <EmptyState title={S.access.empty} description={S.access.regrantHint} />
            ) : (
              <Stack gap="var(--u-space-2)">
                {list.grants.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    actionLabel={S.access.revoke}
                    busy={busy === `revoke:${entry.id}`}
                    onAction={() =>
                      void run(
                        `revoke:${entry.id}`,
                        null,
                        () => api.projects.revokeAccess(projectId, entry.id),
                        S.access.revoked,
                      )
                    }
                  />
                ))}
              </Stack>
            )}

            <Stack gap="var(--u-space-2)">
              <Field
                label={S.access.email}
                htmlFor="access-email"
                hint={S.access.emailHint}
                error={fieldError.grant ?? null}
              >
                <Input
                  id="access-email"
                  type="email"
                  inputMode="email"
                  value={email}
                  placeholder="investor@example.com"
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <fieldset
                style={{
                  border: 0,
                  padding: 0,
                  margin: 0,
                  display: 'grid',
                  gap: 'var(--u-space-1)',
                }}
              >
                <legend style={{ fontSize: 'var(--u-text-sm)', fontWeight: 600, padding: 0 }}>
                  {S.access.permissions}
                </legend>
                {PERMISSIONS.map((permission) => (
                  <label
                    key={permission}
                    style={{ display: 'flex', gap: 'var(--u-space-2)', alignItems: 'center' }}
                  >
                    <input
                      type="checkbox"
                      data-access-permission={permission}
                      checked={permissions.includes(permission)}
                      onChange={(e) =>
                        setPermissions((current) =>
                          e.target.checked
                            ? [...current, permission]
                            : current.filter((p) => p !== permission),
                        )
                      }
                    />
                    <span style={{ fontSize: 'var(--u-text-sm)' }}>
                      {S.access.permissionLabels[permission]}
                    </span>
                  </label>
                ))}
              </fieldset>
              <Field label={S.access.reason} htmlFor="access-reason">
                <Input
                  id="access-reason"
                  value={reason}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <div>
                <Button
                  data-access-grant
                  loading={busy === 'grant'}
                  disabled={email.trim() === '' || permissions.length === 0}
                  onClick={() =>
                    void run(
                      'grant',
                      'grant',
                      async () => {
                        await api.projects.grantAccess(projectId, {
                          email: email.trim(),
                          permissions,
                          ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
                        });
                        setEmail('');
                        setReason('');
                      },
                      S.access.granted,
                    )
                  }
                >
                  {S.access.grant}
                </Button>
              </div>
            </Stack>

            <Stack gap="var(--u-space-2)">
              <h3 style={{ margin: 0, fontSize: 'var(--u-text-md)' }}>
                {S.access.exclusionsTitle}
              </h3>
              <p style={{ margin: 0, color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                {S.access.exclusionsNote}
              </p>
              {list.exclusions.length === 0 ? (
                <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                  {S.access.exclusionsEmpty}
                </span>
              ) : (
                list.exclusions.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    actionLabel={S.access.removeExclusion}
                    busy={busy === `exclusion:${entry.id}`}
                    onAction={() =>
                      void run(
                        `exclusion:${entry.id}`,
                        null,
                        () => api.projects.revokeExclusion(projectId, entry.id),
                        S.access.exclusionRemoved,
                      )
                    }
                  />
                ))
              )}
              <Field
                label={S.access.email}
                htmlFor="access-exclude-email"
                error={fieldError.exclude ?? null}
              >
                <Input
                  id="access-exclude-email"
                  type="email"
                  inputMode="email"
                  value={excludeEmail}
                  placeholder="investor@example.com"
                  onChange={(e) => setExcludeEmail(e.target.value)}
                />
              </Field>
              <div>
                <Button
                  data-access-exclude
                  variant="secondary"
                  loading={busy === 'exclude'}
                  disabled={excludeEmail.trim() === ''}
                  onClick={() =>
                    void run(
                      'exclude',
                      'exclude',
                      async () => {
                        await api.projects.excludeAccess(projectId, {
                          email: excludeEmail.trim(),
                        });
                        setExcludeEmail('');
                      },
                      S.access.excluded,
                    )
                  }
                >
                  {S.access.exclude}
                </Button>
              </div>
            </Stack>
          </>
        ) : null}

        {notice ? (
          <div
            role={notice.tone === 'error' ? 'alert' : 'status'}
            style={{ color: notice.tone === 'error' ? 'var(--u-danger)' : 'var(--u-success)' }}
          >
            {notice.text}
          </div>
        ) : null}
      </Stack>
    </Card>
  );
}

function EntryRow({
  entry,
  actionLabel,
  busy,
  onAction,
}: {
  entry: ProjectAccessEntry;
  actionLabel: string;
  busy: boolean;
  onAction: () => void;
}) {
  return (
    <div
      data-access-entry={entry.id}
      data-access-entry-kind={entry.kind}
      style={{
        display: 'flex',
        gap: 'var(--u-space-3)',
        alignItems: 'center',
        flexWrap: 'wrap',
        borderBottom: '1px solid var(--u-border)',
        paddingBottom: 'var(--u-space-2)',
      }}
    >
      <strong style={{ minWidth: 160 }}>{entry.subjectName}</strong>
      <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap', flex: 1 }}>
        {entry.permissions.map((permission) => (
          <Badge key={permission} tone="accent">
            {S.access.permissionLabels[permission] ?? permission}
          </Badge>
        ))}
        <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-xs)' }}>
          {S.access.since(new Date(entry.createdAt).toLocaleDateString('ru-RU'))}
          {entry.reason ? ` · ${entry.reason}` : ''}
        </span>
      </div>
      <Button variant="secondary" loading={busy} onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}
