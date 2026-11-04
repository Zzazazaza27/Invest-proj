import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, Field, Input, Stack } from '@fifth/ui';
import type { AdminUserSummary, StaffCapability } from '@fifth/contracts';
import { ApiError, api } from '../api';

/**
 * Управление сотрудниками: функциональные полномочия.
 *
 * **Роль** — кем человек является на платформе (выдаётся выше, в разделе
 * ролей). **Функциональное полномочие** — что он вправе делать вообще:
 * галочки ниже, каталог реализованных функций по разделам. Назначения на
 * объект (оценка проекта, сопровождение сделки) удалены в 2.1-W05 вместе с
 * экспертизой и сделками.
 */

type Notice = { tone: 'ok' | 'error'; text: string } | null;

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.problem?.detail ?? error.message;
  return 'Сервис недоступен';
}

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      style={{
        padding: 'var(--u-space-3)',
        borderRadius: 'var(--u-radius-md)',
        background: notice.tone === 'error' ? 'var(--u-danger-subtle)' : 'var(--u-success-subtle)',
        color: notice.tone === 'error' ? 'var(--u-danger)' : 'var(--u-success)',
      }}
    >
      {notice.text}
    </div>
  );
}

/**
 * Поиск человека по имени.
 *
 * Идентификатор остаётся тем, чем оперирует API и журнал, но брать его
 * оператору неоткуда: базы у него нет. Поэтому ищем по имени, а выбранный
 * идентификатор показываем рядом — сверить с журналом по-прежнему можно.
 */
function UserPicker({
  id,
  label,
  value,
  onPick,
}: {
  id: string;
  label: string;
  value: string;
  onPick: (user: AdminUserSummary) => void;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<AdminUserSummary[] | null>(null);
  // Выключено по умолчанию: записи проверок в обычной работе только мешают.
  const [includeProbes, setIncludeProbes] = useState(false);

  return (
    <Stack gap="var(--u-space-2)">
      <Field label={label} htmlFor={id} hint="По имени, как оно указано в профиле">
        <div style={{ display: 'flex', gap: 'var(--u-space-2)' }}>
          <Input
            id={id}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Например, Оливер"
          />
          <button
            type="button"
            className="btn--sm"
            onClick={() => {
              setFound(null);
              void api
                .searchUsers(query.trim(), { includeProbes })
                .then((page) => setFound(page.items))
                .catch(() => setFound([]));
            }}
          >
            Искать
          </button>
        </div>
        <label
          className="small muted"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6 }}
        >
          <input
            type="checkbox"
            data-include-probes
            checked={includeProbes}
            onChange={(event) => {
              setIncludeProbes(event.target.checked);
              // Прежняя выдача относится к прежнему условию: оставить её на
              // экране значило бы показывать ответ на другой вопрос.
              setFound(null);
            }}
          />
          Включая тестовых пользователей
        </label>
      </Field>
      {found !== null && found.length === 0 ? (
        <div className="small muted">Никого не нашлось — попробуйте другую часть имени.</div>
      ) : null}
      {found !== null && found.length > 0 ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
          {found.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={item.id === value ? 'btn--sm' : 'btn--ghost btn--sm'}
                style={{ width: '100%', textAlign: 'left' }}
                onClick={() => onPick(item)}
              >
                {item.displayName}
                <span className="small muted">
                  {' '}
                  · {item.roles.length > 0 ? item.roles.join(', ') : 'без ролей'} ·{' '}
                  {item.id.slice(0, 8)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Stack>
  );
}

/**
 * Что даёт полномочие — обычными словами.
 *
 * Каталог в базе хранит и заголовок, и описание; здесь добавляются два
 * условия, о которых человек за экраном знать не обязан: реализовано ли
 * действие вообще и нужна ли к нему область работы.
 */
function CapabilityRow({
  capability,
  granted,
  busy,
  onToggle,
}: {
  capability: StaffCapability;
  granted: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  const disabled = busy || !capability.isImplemented;
  return (
    <li
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: 'var(--u-space-3)',
        alignItems: 'start',
        padding: 'var(--u-space-2) 0',
        borderTop: '1px solid var(--u-border)',
      }}
    >
      <input
        type="checkbox"
        id={`cap-${capability.code}`}
        checked={granted}
        disabled={disabled}
        onChange={(event) => onToggle(event.target.checked)}
        // Ширина и высота заданы явно: общий стиль админки растягивает любой
        // `input` на всю ширину, и галочка занимала половину строки.
        style={{ width: 16, height: 16, marginTop: 4 }}
      />
      <label
        htmlFor={`cap-${capability.code}`}
        style={{ display: 'grid', gap: 2, textAlign: 'left', marginBottom: 0, fontWeight: 400 }}
      >
        <span style={{ fontWeight: 600 }}>
          {capability.title}{' '}
          {capability.isImplemented ? null : <Badge tone="neutral">не реализовано</Badge>}{' '}
          {capability.requiresAssignment ? (
            <Badge tone="warning">нужно назначение на объект</Badge>
          ) : null}
        </span>
        <span className="small muted">{capability.description}</span>
        <span className="small muted" style={{ fontFamily: 'var(--u-font-mono, monospace)' }}>
          {capability.code}
        </span>
      </label>
    </li>
  );
}

/** Полномочия сотрудника: каталог по разделам, выдача и отзыв галочками. */
export function CapabilitiesSection() {
  const [catalog, setCatalog] = useState<StaffCapability[]>([]);
  const [userId, setUserId] = useState('');
  const [userName, setUserName] = useState('');
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    void api.capabilities
      .catalog()
      .then((page) => setCatalog(page.items))
      .catch((error: unknown) => setNotice({ tone: 'error', text: describe(error) }));
  }, []);

  const loadGrants = useCallback(async (id: string) => {
    const page = await api.capabilities.grantsOf(id);
    setGranted(
      new Set(page.items.filter((item) => item.revokedAt === null).map((item) => item.capability)),
    );
  }, []);

  async function toggle(code: string, next: boolean): Promise<void> {
    if (reason.trim().length < 3) {
      setNotice({ tone: 'error', text: 'Укажите основание: оно попадёт в журнал вместе с вами' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      if (next) await api.capabilities.grant(userId, code, reason.trim());
      else await api.capabilities.revoke(userId, code, reason.trim());
      await loadGrants(userId);
      setNotice({ tone: 'ok', text: next ? 'Полномочие выдано' : 'Полномочие отозвано' });
    } catch (error) {
      setNotice({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(false);
    }
  }

  const sections = [...new Set(catalog.map((c) => c.section))];

  return (
    // `data-section` — якорь для браузерных проверок: разделов на странице
    // четыре, и «первая кнопка прекращения» легко оказывается из чужого.
    <Card data-section="capabilities">
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Полномочия сотрудника</h2>
        <span className="small muted">
          Полномочие отвечает на вопрос «что сотрудник вправе делать вообще». Полномочие, помеченное
          значком, требует назначения на объект — таких назначений сейчас нет, и оно ничего не
          откроет. Расширить себе права сотрудник не может — выдаёт только администратор.
        </span>

        <UserPicker
          id="cap-user-search"
          label="Кому"
          value={userId}
          onPick={(user) => {
            setUserId(user.id);
            setUserName(user.displayName);
            setNotice(null);
            void loadGrants(user.id).catch((error: unknown) =>
              setNotice({ tone: 'error', text: describe(error) }),
            );
          }}
        />

        {userId ? (
          <>
            <div className="small muted">
              Выбран: <strong>{userName}</strong> · {userId.slice(0, 8)}
            </div>
            <Field
              label="Основание"
              htmlFor="cap-reason"
              hint="Обязательно: попадёт в журнал вместе с тем, кто сделал изменение"
            >
              <Input
                id="cap-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Например: разбирает обращения поддержки"
              />
            </Field>

            {sections.map((section) => (
              <div key={section}>
                <h3 style={{ margin: '0 0 4px', fontSize: 'var(--u-text-md)' }}>{section}</h3>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {catalog
                    .filter((c) => c.section === section)
                    .map((c) => (
                      <CapabilityRow
                        key={c.code}
                        capability={c}
                        granted={granted.has(c.code)}
                        busy={busy}
                        onToggle={(next) => void toggle(c.code, next)}
                      />
                    ))}
                </ul>
              </div>
            ))}

            {catalog.length === 0 ? (
              <div className="small muted">
                Каталог пуст: реализованных полномочий пока нет. Это честный ответ, а не ошибка
                загрузки.
              </div>
            ) : null}
          </>
        ) : (
          <div className="small muted">Выберите человека, чтобы увидеть его полномочия.</div>
        )}

        <NoticeLine notice={notice} />
      </Stack>
    </Card>
  );
}
