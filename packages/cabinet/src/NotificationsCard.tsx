import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, EmptyState, ErrorState, LoadingState, Stack } from '@unicorn/ui';
import type { Notification, NotificationPreference } from '@unicorn/contracts';

/**
 * Уведомления и их настройки.
 *
 * Живёт в общем пакете, а не в каждом кабинете. Причина не в экономии строк:
 * четыре копии одного экрана в этом проекте уже расходились по одной за раз —
 * в Ф44 в трёх кабинетах из четырёх нашли ошибку сброса CSRF-токена, давно
 * исправленную в четвёртом. У уведомлений цена расхождения выше обычной: они
 * про то, о чём человека предупредят, а о чём нет.
 *
 * Пакет НЕ знает про HTTP: транспорт передаётся тремя функциями. Так границу
 * «фронтенд не ходит в сеть мимо своего клиента» видно в сигнатуре, а каждый
 * кабинет остаётся при своём клиенте и своей схеме аутентификации.
 */
export interface NotificationsPort {
  list: (limit: number) => Promise<Notification[]>;
  preferences: () => Promise<NotificationPreference[]>;
  savePreferences: (items: NotificationPreference[]) => Promise<NotificationPreference[]>;
}

/**
 * Каналы и темы показываются человеческими словами, а не кодами.
 *
 * Незнакомый код здесь не прячется: если сервер вернёт тему, которой в этом
 * словаре нет, покажется сам код. Скрыть строку значило бы, что человек не
 * увидит настройку, которая у него на самом деле есть.
 */
const CHANNEL_TITLES: Record<string, string> = {
  email: 'Почта',
  push: 'Push',
  telegram: 'Telegram',
  sms: 'SMS',
  inapp: 'В интерфейсе',
};

const TOPIC_TITLES: Record<string, string> = {
  all: 'Все',
  projects: 'Проекты',
  messages: 'Сообщения',
  security: 'Безопасность',
  marketing: 'Рассылки',
};

/**
 * Темы, которые отключить НЕЛЬЗЯ, и это не каприз интерфейса: ограничение
 * стоит в самой схеме (CHECK по теме `security`; `billing` снята в 2.1-W05
 * вместе с платежами). Показать переключатель, который сервер отвергнет,
 * значило бы обещать управление, которого нет.
 */
const MANDATORY_TOPICS = new Set(['security']);

const STATUS_TITLES: Record<string, string> = {
  queued: 'в очереди',
  sending: 'отправляется',
  sent: 'отправлено',
  failed: 'не доставлено',
  skipped_by_preference: 'пропущено по настройкам',
};

export function NotificationsCard({
  port,
  limit = 20,
}: {
  port: NotificationsPort;
  limit?: number;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: Notification[]; preferences: NotificationPreference[] }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [items, preferences] = await Promise.all([port.list(limit), port.preferences()]);
      setState({ status: 'ready', items, preferences });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Сервис недоступен',
      });
    }
  }, [port, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(target: NotificationPreference, enabled: boolean): Promise<void> {
    if (state.status !== 'ready') return;
    setBusy(true);
    setNotice(null);
    try {
      // Отправляется ОДНА изменённая настройка, а не весь список: полный список
      // затирал бы настройки, изменённые в другой вкладке между загрузкой и
      // нажатием. Сервер принимает частичный набор — он делает upsert по паре
      // (канал, тема).
      const saved = await port.savePreferences([{ ...target, enabled }]);
      const byKey = new Map(saved.map((item) => [`${item.channel}|${item.topic}`, item]));
      setState({
        ...state,
        preferences: state.preferences.map(
          (item) => byKey.get(`${item.channel}|${item.topic}`) ?? item,
        ),
      });
      setNotice({ tone: 'ok', text: 'Настройка сохранена' });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Сервис недоступен',
      });
    } finally {
      setBusy(false);
    }
  }

  if (state.status === 'loading') return <LoadingState label="Загружаем уведомления" />;
  if (state.status === 'error') {
    return <ErrorState description={state.message} onRetry={() => void load()} />;
  }

  return (
    <Stack gap="var(--u-space-5)">
      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Уведомления</h2>
          {state.items.length === 0 ? (
            <EmptyState
              title="Уведомлений нет"
              description="Здесь появятся сообщения о проекте и аккаунте — по тем каналам, которые включены ниже."
            />
          ) : (
            <ul style={LIST_STYLE}>
              {state.items.map((item) => (
                <li key={item.id} style={ROW_STYLE}>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {item.templateCode}{' '}
                      <Badge tone={item.status === 'sent' ? 'success' : 'neutral'}>
                        {STATUS_TITLES[item.status] ?? item.status}
                      </Badge>
                    </div>
                    <div style={MUTED_STYLE}>
                      {CHANNEL_TITLES[item.channel] ?? item.channel} ·{' '}
                      {new Date(item.createdAt).toLocaleString('ru-RU')}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {/*
            Состояние доставки показывается как есть. «В очереди» — честное
            состояние: канал может быть ещё не подключён, и делать вид, что
            письмо отправлено, значит обещать то, чего не было.
          */}
          <span style={MUTED_STYLE}>
            Показаны последние {limit}. Состояние доставки — фактическое, а не «принято к сведению».
          </span>
        </Stack>
      </Card>

      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Каналы и темы</h2>

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

          {state.preferences.length === 0 ? (
            <EmptyState
              title="Настроек пока нет"
              description="Настройки появляются вместе с первым уведомлением по каналу."
            />
          ) : (
            <ul style={LIST_STYLE}>
              {state.preferences.map((item) => {
                const mandatory = MANDATORY_TOPICS.has(item.topic);
                const id = `pref-${item.channel}-${item.topic}`;
                return (
                  <li key={id} style={ROW_STYLE}>
                    <label htmlFor={id} style={{ display: 'grid', gap: 2 }}>
                      <span style={{ fontWeight: 600 }}>
                        {TOPIC_TITLES[item.topic] ?? item.topic}
                      </span>
                      <span style={MUTED_STYLE}>
                        {CHANNEL_TITLES[item.channel] ?? item.channel}
                        {mandatory ? ' · отключить нельзя' : ''}
                      </span>
                    </label>
                    <input
                      id={id}
                      type="checkbox"
                      checked={item.enabled}
                      disabled={busy || mandatory}
                      onChange={(event) => void toggle(item, event.target.checked)}
                    />
                  </li>
                );
              })}
            </ul>
          )}

          <span style={MUTED_STYLE}>
            Безопасность и счета отключить нельзя: это не настройка интерфейса, а ограничение самой
            схемы — уведомление о входе с нового устройства или о выставленном счёте обязано дойти.
          </span>
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
