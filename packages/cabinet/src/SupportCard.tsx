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
} from '@fifth/ui';
import type {
  GuardedOperationName,
  RequestKeyState,
  SupportTicket,
  SupportTicketDetail,
  SupportTicketStatus,
} from '@fifth/contracts';
import { GuardedNotice, useGuardedSend } from './guarded-send';

/**
 * Поддержка: обращения и переписка внутри них.
 *
 * Один компонент на две стороны разговора. Роль решает СЕРВЕР — список
 * приходит по политике БД: автору свои обращения, сотруднику поддержки все.
 * Флаг `staff` здесь управляет только тем, показывать ли кнопки «взять в
 * работу» и «закрыть»: если бы он решал, чьи обращения видны, доступ к чужим
 * решался бы в браузере.
 *
 * Почему не realtime-чат. WebSocket-контура у платформы нет, и заводить его
 * ради MVP поддержки означало бы новый сетевой периметр, свою аутентификацию
 * и свои лимиты — под задачу, которую закрывает асинхронный обмен
 * сообщениями. Визуально это всё равно диалог; отличие в том, что новое
 * сообщение видно после обновления, а не мгновенно.
 */
export interface SupportPort {
  list: () => Promise<SupportTicket[]>;
  detail: (id: string) => Promise<SupportTicketDetail>;
  /** `key` — ключ повтора (2.6): транспорт передаёт его серверу как есть. */
  open: (input: { subject: string; body: string }, key: string) => Promise<SupportTicketDetail>;
  reply: (id: string, body: string, key: string) => Promise<unknown>;
  /** Исход защищённой отправки по ключу — после входа или перезагрузки (2.6). */
  requestState: (operation: GuardedOperationName, key: string) => Promise<RequestKeyState>;
  update: (
    id: string,
    input: { status?: SupportTicketStatus; assignToMe?: boolean },
  ) => Promise<unknown>;
}

const STATUS_TITLES: Record<SupportTicketStatus, string> = {
  new: 'новое',
  in_progress: 'в работе',
  closed: 'закрыто',
};

const KIND_TITLES: Record<string, string> = {
  support: 'Обращение',
  bug_report: 'Ошибка',
};

function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

export function SupportCard({ port, staff = false }: { port: SupportPort; staff?: boolean }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: SupportTicket[] }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<SupportTicketDetail | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', items: await port.list() });
    } catch (cause) {
      setState({
        status: 'error',
        message: cause instanceof Error ? cause.message : 'Не удалось загрузить обращения',
      });
    }
  }, [port]);

  useEffect(() => {
    void load();
  }, [load]);

  const openThread = useCallback(
    async (id: string) => {
      setOpenId(id);
      setThread(null);
      setReply('');
      try {
        setThread(await port.detail(id));
      } catch (cause) {
        setNotice({
          tone: 'error',
          text: cause instanceof Error ? cause.message : 'Обращение не открылось',
        });
      }
    },
    [port],
  );

  // Обращение и ответ — защищённые отправки (2.6): при потерянном ответе форма заперта на
  // отправленном и выясняет результат тем же ключом, второе обращение не создаётся.
  const ticketSend = useGuardedSend({
    scope: 'support.ticket.open',
    operation: 'support.ticket.open',
    send: (input: { subject: string; body: string }, key: string) => port.open(input, key),
    state: (key) => port.requestState('support.ticket.open', key),
    onResolved: (ticketId) => {
      setSubject('');
      setBody('');
      setNotice({ tone: 'ok', text: 'Обращение принято. Мы ответим в этом же разделе.' });
      void load().then(() => openThread(ticketId));
    },
    onDone: (created) => {
      setSubject('');
      setBody('');
      setNotice({ tone: 'ok', text: 'Обращение принято. Мы ответим в этом же разделе.' });
      void load().then(() => openThread(created.id));
    },
    onFail: (cause) =>
      setNotice({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'Не удалось отправить обращение',
      }),
  });

  const replySend = useGuardedSend({
    scope: `support.message.add:${openId ?? ''}`,
    operation: 'support.message.add',
    send: (input: { ticketId: string; body: string }, key: string) =>
      port.reply(input.ticketId, input.body, key),
    state: (key) => port.requestState('support.message.add', key),
    onResolved: (_messageId, ticketId) => {
      setReply('');
      if (ticketId) void openThread(ticketId).then(load);
    },
    onDone: (_result, input) => {
      setReply('');
      void openThread(input.ticketId).then(load);
    },
    onFail: (cause) =>
      setNotice({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'Сообщение не отправлено',
      }),
  });

  function createTicket(event: React.FormEvent) {
    event.preventDefault();
    setNotice(null);
    void ticketSend.submit({ subject: subject.trim(), body: body.trim() });
  }

  function sendReply(event: React.FormEvent) {
    event.preventDefault();
    if (!openId) return;
    setNotice(null);
    void replySend.submit({ ticketId: openId, body: reply.trim() });
  }

  async function changeStatus(input: { status?: SupportTicketStatus; assignToMe?: boolean }) {
    if (!openId) return;
    setBusy(true);
    setNotice(null);
    try {
      await port.update(openId, input);
      await openThread(openId);
      await load();
    } catch (cause) {
      setNotice({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'Состояние не изменилось',
      });
    } finally {
      setBusy(false);
    }
  }

  if (state.status === 'loading') return <LoadingState label="Загружаем обращения" />;
  if (state.status === 'error') {
    return <ErrorState description={state.message} onRetry={() => void load()} />;
  }

  return (
    <Stack gap="var(--u-space-6)">
      {notice ? (
        <div
          role="status"
          style={{
            padding: 'var(--u-space-3)',
            borderRadius: 'var(--u-radius-md)',
            border: `1px solid ${notice.tone === 'ok' ? 'var(--u-border)' : 'var(--u-danger)'}`,
            color: notice.tone === 'ok' ? 'var(--u-text)' : 'var(--u-danger)',
          }}
        >
          {notice.text}
        </div>
      ) : null}

      {/*
        Форма нового обращения есть только у пользователя. Сотрудник поддержки
        заводит обращение так же, как все, — из своего кабинета; отдельная
        форма «создать обращение за пользователя» означала бы обращение,
        которого человек не писал.
      */}
      {!staff ? (
        <Card>
          <Stack gap="var(--u-space-4)">
            <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Написать в поддержку</h2>
            <form onSubmit={createTicket}>
              <Stack gap="var(--u-space-4)">
                <Field label="Тема" htmlFor="support-subject">
                  <Input
                    id="support-subject"
                    required
                    minLength={3}
                    maxLength={200}
                    value={ticketSend.snapshot?.subject ?? subject}
                    readOnly={ticketSend.unresolved || ticketSend.busy}
                    onChange={(event) => setSubject(event.target.value)}
                    placeholder="Коротко о вопросе"
                  />
                </Field>
                <Field label="Сообщение" htmlFor="support-body">
                  <textarea
                    id="support-body"
                    required
                    rows={5}
                    maxLength={5000}
                    value={ticketSend.snapshot?.body ?? body}
                    readOnly={ticketSend.unresolved || ticketSend.busy}
                    onChange={(event) => setBody(event.target.value)}
                    style={{
                      padding: 'var(--u-space-3)',
                      borderRadius: 'var(--u-radius-md)',
                      border: '1px solid var(--u-border-strong)',
                      background: 'var(--u-surface)',
                      color: 'var(--u-text)',
                      fontSize: 'var(--u-text-md)',
                      fontFamily: 'inherit',
                      width: '100%',
                      resize: 'vertical',
                    }}
                  />
                </Field>
                <GuardedNotice guard={ticketSend} />
                {ticketSend.unresolved ? null : (
                  <div>
                    <Button
                      type="submit"
                      loading={busy || ticketSend.busy}
                      disabled={
                        busy ||
                        ticketSend.busy ||
                        subject.trim().length < 3 ||
                        body.trim().length === 0
                      }
                    >
                      Отправить
                    </Button>
                  </div>
                )}
                <p
                  style={{ margin: 0, color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}
                >
                  Обращение сохраняется в системе и уходит на почту проекта — оно не потеряется,
                  даже если в этот момент никто не в интерфейсе.
                </p>
              </Stack>
            </form>
          </Stack>
        </Card>
      ) : null}

      <Card>
        <Stack gap="var(--u-space-4)">
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>
            {staff ? 'Все обращения' : 'Мои обращения'}
          </h2>
          {state.items.length === 0 ? (
            <EmptyState
              title="Обращений нет"
              description={
                staff
                  ? 'Как только пользователь напишет, обращение появится здесь.'
                  : 'Здесь появятся ваши обращения и сообщения об ошибках.'
              }
            />
          ) : (
            <Stack gap="var(--u-space-2)">
              {state.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void openThread(item.id)}
                  style={{
                    display: 'grid',
                    gap: 'var(--u-space-1)',
                    textAlign: 'left',
                    minHeight: 44,
                    padding: 'var(--u-space-3)',
                    borderRadius: 'var(--u-radius-md)',
                    border: `1px solid ${item.id === openId ? 'var(--u-accent)' : 'var(--u-border)'}`,
                    background: 'transparent',
                    color: 'var(--u-text)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <span
                    style={{
                      display: 'flex',
                      gap: 'var(--u-space-2)',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                    }}
                  >
                    <Badge>{KIND_TITLES[item.kind] ?? item.kind}</Badge>
                    <Badge>{STATUS_TITLES[item.status]}</Badge>
                    <strong>{item.subject}</strong>
                  </span>
                  <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                    сообщений: {item.messageCount} · последнее:{' '}
                    {item.lastMessageAt
                      ? formatMoment(item.lastMessageAt)
                      : formatMoment(item.createdAt)}
                    {item.assigned ? ' · взято в работу' : ''}
                  </span>
                </button>
              ))}
            </Stack>
          )}
        </Stack>
      </Card>

      {openId ? (
        <Card>
          <Stack gap="var(--u-space-4)">
            {!thread ? (
              <LoadingState label="Открываем обращение" />
            ) : (
              <>
                <div
                  style={{
                    display: 'flex',
                    gap: 'var(--u-space-2)',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>{thread.subject}</h2>
                  <Badge>{STATUS_TITLES[thread.status]}</Badge>
                </div>

                <Stack gap="var(--u-space-3)">
                  {thread.messages.map((message) => (
                    <div
                      key={message.id}
                      style={{
                        // Диалог: сообщения сторон прижаты к разным краям —
                        // так видно, кто говорит, без подписи к каждой реплике.
                        alignSelf: message.authorKind === 'staff' ? 'flex-start' : 'flex-end',
                        maxWidth: 'min(100%, 46rem)',
                        padding: 'var(--u-space-3)',
                        borderRadius: 'var(--u-radius-md)',
                        border: '1px solid var(--u-border)',
                        background:
                          message.authorKind === 'staff' ? 'var(--u-surface)' : 'transparent',
                      }}
                    >
                      <div
                        style={{
                          fontSize: 'var(--u-text-xs)',
                          color: 'var(--u-text-muted)',
                          marginBottom: 'var(--u-space-1)',
                        }}
                      >
                        {message.authorKind === 'staff' ? 'Поддержка' : 'Пользователь'} ·{' '}
                        {formatMoment(message.createdAt)}
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{message.body}</div>
                    </div>
                  ))}
                </Stack>

                {/*
                  Технический контекст показывается и автору тоже: он его и
                  отправил, скрывать от него собственные данные незачем.
                */}
                {Object.keys(thread.context).length > 0 ? (
                  <details>
                    <summary
                      style={{
                        cursor: 'pointer',
                        color: 'var(--u-text-muted)',
                        fontSize: 'var(--u-text-sm)',
                      }}
                    >
                      Технический контекст
                    </summary>
                    <pre
                      style={{
                        margin: 'var(--u-space-2) 0 0',
                        padding: 'var(--u-space-3)',
                        border: '1px solid var(--u-border)',
                        borderRadius: 'var(--u-radius-md)',
                        fontSize: 'var(--u-text-xs)',
                        overflowX: 'auto',
                      }}
                    >
                      {JSON.stringify(thread.context, null, 2)}
                    </pre>
                  </details>
                ) : null}

                {thread.status === 'closed' ? (
                  <p style={{ margin: 0, color: 'var(--u-text-muted)' }}>
                    Обращение закрыто. Если вопрос остался — откройте новое.
                  </p>
                ) : (
                  <form onSubmit={sendReply}>
                    <Stack gap="var(--u-space-3)">
                      <Field label="Ответ" htmlFor="support-reply">
                        <textarea
                          id="support-reply"
                          required
                          rows={4}
                          maxLength={5000}
                          value={replySend.snapshot?.body ?? reply}
                          readOnly={replySend.unresolved || replySend.busy}
                          onChange={(event) => setReply(event.target.value)}
                          style={{
                            padding: 'var(--u-space-3)',
                            borderRadius: 'var(--u-radius-md)',
                            border: '1px solid var(--u-border-strong)',
                            background: 'var(--u-surface)',
                            color: 'var(--u-text)',
                            fontSize: 'var(--u-text-md)',
                            fontFamily: 'inherit',
                            width: '100%',
                            resize: 'vertical',
                          }}
                        />
                      </Field>
                      <GuardedNotice guard={replySend} />
                      <div hidden={replySend.unresolved}>
                        <Button
                          type="submit"
                          loading={busy || replySend.busy}
                          disabled={busy || replySend.busy || reply.trim().length === 0}
                        >
                          Отправить
                        </Button>
                      </div>
                    </Stack>
                  </form>
                )}

                {staff ? (
                  <div style={{ display: 'flex', gap: 'var(--u-space-3)', flexWrap: 'wrap' }}>
                    <Button
                      variant="secondary"
                      disabled={busy || thread.status === 'in_progress'}
                      onClick={() => void changeStatus({ status: 'in_progress', assignToMe: true })}
                    >
                      Взять в работу
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy || thread.status === 'closed'}
                      onClick={() => void changeStatus({ status: 'closed' })}
                    >
                      Закрыть
                    </Button>
                    {thread.status === 'closed' ? (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void changeStatus({ status: 'in_progress' })}
                      >
                        Вернуть в работу
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </Stack>
        </Card>
      ) : null}
    </Stack>
  );
}
