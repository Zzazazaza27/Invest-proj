import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input, Stack } from '@unicorn/ui';
import type {
  AdminProjectSummary,
  AdminUserSummary,
  DealSupportAssignmentRow,
  ProjectReviewAssignment,
  StaffCapability,
} from '@unicorn/contracts';
import { ApiError, api } from '../api';

/**
 * Управление сотрудниками: три РАЗНЫХ условия доступа на одном экране.
 *
 * Их путают постоянно, поэтому они разведены и подписаны:
 *
 *   1. **Роль** (`expert`) — кем человек является на платформе. Выдаётся выше,
 *      в разделе ролей.
 *   2. **Функциональное полномочие** — что он вправе делать вообще. Галочки
 *      ниже, каталог реализованных функций по разделам.
 *   3. **Назначение на объект** — с чем именно он работает. Два независимых
 *      вида: оценка проекта (`review`) и сопровождение сделки
 *      (`deal_support`). Первое открывает материалы рецензенту, второе — нет.
 *
 * Нужны ОДНОВРЕМЕННО: полномочие без назначения не открывает конкретный
 * объект, назначение без полномочия ничего не позволяет делать. Роль сама по
 * себе не даёт ни того, ни другого.
 *
 * Экран не изобретает новых сущностей: всё это уже работало по API (M097,
 * M099), не хватало только места, где это видно человеку.
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
                .searchUsers(query.trim())
                .then((page) => setFound(page.items))
                .catch(() => setFound([]));
            }}
          >
            Искать
          </button>
        </div>
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

/** Поиск проекта. Тот же приём, что у людей: имя вместо идентификатора. */
function ProjectPicker({
  id,
  label,
  value,
  onPick,
}: {
  id: string;
  label: string;
  value: string;
  onPick: (project: AdminProjectSummary) => void;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<AdminProjectSummary[] | null>(null);

  return (
    <Stack gap="var(--u-space-2)">
      <Field label={label} htmlFor={id} hint="По названию проекта">
        <div style={{ display: 'flex', gap: 'var(--u-space-2)' }}>
          <Input
            id={id}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Например, Мираж"
          />
          <button
            type="button"
            className="btn--sm"
            onClick={() => {
              setFound(null);
              void api
                .searchProjects(query.trim())
                .then((page) => setFound(page.items))
                .catch(() => setFound([]));
            }}
          >
            Искать
          </button>
        </div>
      </Field>
      {found !== null && found.length === 0 ? (
        <div className="small muted">Ничего не нашлось — попробуйте другую часть названия.</div>
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
                {item.title}
                <span className="small muted">
                  {' '}
                  · {item.status} · {item.id.slice(0, 8)}
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
    // четыре, и «первая кнопка «Снять»» легко оказывается из чужого.
    <Card data-section="capabilities">
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Полномочия сотрудника</h2>
        <span className="small muted">
          Полномочие отвечает на вопрос «что сотрудник вправе делать вообще». С какими именно
          объектами — решает назначение ниже: без него полномочие, помеченное значком, ничего не
          откроет. Роль эксперта сама по себе не даёт ни того, ни другого, а расширить себе права
          сотрудник не может — выдаёт только администратор.
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
                placeholder="Например: сопровождает сделки по проекту Мираж"
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

const STATUS_LABEL: Record<string, string> = {
  assigned: 'назначен, ещё не ответил',
  accepted: 'принял',
  declined: 'отказался',
  completed: 'завершено',
  expired: 'снято или просрочено',
};

/** Назначения на ОЦЕНКУ проекта. Открывают рецензенту материалы проекта. */
export function ReviewAssignmentsSection() {
  const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('');
  const [items, setItems] = useState<ProjectReviewAssignment[]>([]);
  const [expertId, setExpertId] = useState('');
  const [expertName, setExpertName] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async (id: string) => {
    const page = await api.expertAssignments.ofProject(id);
    setItems(page.items);
  }, []);

  async function assign(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      // Срок обязателен: без него назначение невозможно ни просрочить, ни вести.
      await api.expertAssignments.assign(projectId, [expertId], new Date(dueAt).toISOString());
      await load(projectId);
      setNotice({ tone: 'ok', text: 'Эксперт назначен на оценку' });
    } catch (error) {
      setNotice({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(assignmentId: string): Promise<void> {
    if (reason.trim().length < 3) {
      setNotice({ tone: 'error', text: 'Укажите основание снятия: оно попадёт в журнал' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await api.expertAssignments.withdraw(assignmentId, reason.trim());
      await load(projectId);
      setNotice({ tone: 'ok', text: 'Назначение снято' });
    } catch (error) {
      setNotice({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-section="review-assignments">
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Назначение на оценку проекта</h2>
        <span className="small muted">
          Открывает рецензенту материалы проекта и даёт написать рецензию. Требует роли эксперта у
          человека. Это НЕ то же, что сопровождение сделки: одно другого не заменяет и не включает.
        </span>

        <ProjectPicker
          id="review-project-search"
          label="Проект"
          value={projectId}
          onPick={(project) => {
            setProjectId(project.id);
            setProjectTitle(project.title);
            setNotice(null);
            void load(project.id).catch((error: unknown) =>
              setNotice({ tone: 'error', text: describe(error) }),
            );
          }}
        />

        {projectId ? (
          <>
            <div className="small muted">
              Выбран: <strong>{projectTitle}</strong> · {projectId.slice(0, 8)}
            </div>

            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
              {items.map((item) => (
                <li
                  key={item.id}
                  style={{
                    display: 'flex',
                    gap: 'var(--u-space-3)',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    borderTop: '1px solid var(--u-border)',
                    paddingTop: 6,
                  }}
                >
                  <strong>{item.expertName}</strong>
                  <Badge tone={item.status === 'expired' ? 'neutral' : 'success'}>
                    {STATUS_LABEL[item.status] ?? item.status}
                  </Badge>
                  <span className="small muted">
                    срок {new Date(item.dueAt).toLocaleDateString('ru-RU')}
                    {item.reviewSubmitted ? ' · рецензия подана' : ''}
                  </span>
                  {item.status === 'assigned' || item.status === 'accepted' ? (
                    <Button
                      variant="danger"
                      loading={busy}
                      onClick={() => void withdraw(item.id)}
                      disabled={item.reviewSubmitted}
                    >
                      Снять
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {items.length === 0 ? (
              <div className="small muted">На этот проект никто не назначен.</div>
            ) : null}

            <UserPicker
              id="review-expert-search"
              label="Кого назначить"
              value={expertId}
              onPick={(user) => {
                setExpertId(user.id);
                setExpertName(user.displayName);
              }}
            />
            {expertId ? (
              <div className="small muted">
                Выбран: <strong>{expertName}</strong> · {expertId.slice(0, 8)}
              </div>
            ) : null}

            <Field label="Срок рецензии" htmlFor="review-due" hint="Должен быть в будущем">
              <Input
                id="review-due"
                type="date"
                value={dueAt}
                onChange={(event) => setDueAt(event.target.value)}
              />
            </Field>

            <Field
              label="Основание снятия"
              htmlFor="review-reason"
              hint="Нужно только для снятия назначения"
            >
              <Input
                id="review-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Например: заявлен конфликт интересов"
              />
            </Field>

            <div>
              <Button loading={busy} disabled={!expertId || !dueAt} onClick={() => void assign()}>
                Назначить на оценку
              </Button>
            </div>
          </>
        ) : (
          <div className="small muted">Выберите проект, чтобы увидеть его рецензентов.</div>
        )}

        <NoticeLine notice={notice} />
      </Stack>
    </Card>
  );
}

/** Назначения на СОПРОВОЖДЕНИЕ сделки. Материалы рецензента не открывают. */
export function DealSupportSection() {
  const [items, setItems] = useState<DealSupportAssignmentRow[]>([]);
  const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('');
  const [userId, setUserId] = useState('');
  const [userName, setUserName] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    const page = await api.capabilities.dealSupport({});
    setItems(page.items);
  }, []);

  useEffect(() => {
    void load().catch((error: unknown) => setNotice({ tone: 'error', text: describe(error) }));
  }, [load]);

  async function run(action: () => Promise<unknown>, okText: string): Promise<void> {
    if (reason.trim().length < 3) {
      setNotice({ tone: 'error', text: 'Укажите основание: оно попадёт в журнал' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await action();
      await load();
      setNotice({ tone: 'ok', text: okText });
    } catch (error) {
      setNotice({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-section="deal-support">
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Сопровождение сделок проекта</h2>
        <span className="small muted">
          Область работы для денежных действий: чьи сделки сотрудник ведёт. Рецензентом от этого не
          становятся — анкета, внутренние оценки и материалы проекта не открываются. Само по себе
          назначение ничего не позволяет: нужны ещё полномочия из раздела выше.
        </span>

        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          {items.map((item) => (
            <li
              key={item.id}
              style={{
                display: 'flex',
                gap: 'var(--u-space-3)',
                alignItems: 'center',
                flexWrap: 'wrap',
                borderTop: '1px solid var(--u-border)',
                paddingTop: 6,
              }}
            >
              <strong>{item.userName}</strong>
              <span className="small muted">→ {item.projectTitle}</span>
              <Badge tone="success">{item.status}</Badge>
              <Button
                variant="danger"
                loading={busy}
                onClick={() =>
                  void run(
                    () =>
                      api.capabilities.revokeDealSupport(
                        item.projectId,
                        item.userId,
                        reason.trim(),
                      ),
                    'Назначение снято',
                  )
                }
              >
                Снять
              </Button>
            </li>
          ))}
        </ul>
        {items.length === 0 ? <div className="small muted">Действующих назначений нет.</div> : null}

        <ProjectPicker
          id="deal-project-search"
          label="Проект"
          value={projectId}
          onPick={(project) => {
            setProjectId(project.id);
            setProjectTitle(project.title);
          }}
        />
        {projectId ? (
          <div className="small muted">
            Выбран проект: <strong>{projectTitle}</strong> · {projectId.slice(0, 8)}
          </div>
        ) : null}

        <UserPicker
          id="deal-user-search"
          label="Кого назначить"
          value={userId}
          onPick={(user) => {
            setUserId(user.id);
            setUserName(user.displayName);
          }}
        />
        {userId ? (
          <div className="small muted">
            Выбран: <strong>{userName}</strong> · {userId.slice(0, 8)}
          </div>
        ) : null}

        <Field
          label="Основание"
          htmlFor="deal-reason"
          hint="Обязательно и для назначения, и для снятия"
        >
          <Input
            id="deal-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Например: ведёт сделки по этому проекту с сентября"
          />
        </Field>

        <div>
          <Button
            loading={busy}
            disabled={!projectId || !userId}
            onClick={() =>
              void run(
                () => api.capabilities.assignDealSupport(projectId, userId, reason.trim()),
                'Назначение создано',
              )
            }
          >
            Назначить на сопровождение
          </Button>
        </div>

        <NoticeLine notice={notice} />
      </Stack>
    </Card>
  );
}
