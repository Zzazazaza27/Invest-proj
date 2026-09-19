import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input, Stack } from '@unicorn/ui';
import type {
  AdminProjectSummary,
  AdminUserSummary,
  DealSupportAssignmentRow,
  ExpertConflict,
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
    // четыре, и «первая кнопка прекращения» легко оказывается из чужого.
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

/**
 * Состояние РАБОТЫ, а не доступа: прекращение доступа показывается отдельной
 * отметкой и эти подписи не меняет (M120).
 */
const STATUS_LABEL: Record<string, string> = {
  assigned: 'назначен, ещё не ответил',
  accepted: 'принял, рецензии пока нет',
  declined: 'отказался',
  completed: 'работа выполнена',
  expired: 'назначение закрыто или просрочено',
};

/** Назначения на ОЦЕНКУ проекта. Открывают рецензенту материалы проекта. */
/**
 * Конфликт интересов, о котором УЖЕ известно.
 *
 * Назначение эксперта с незакрытым конфликтом отвергает сервер (триггер
 * `assignments_conflict_guard`, M007) — и это остаётся единственной защитой.
 * Экран лишь показывает то же ограничение заранее, чтобы человек не узнавал о
 * нём из отказа после нажатия. Своего правила здесь нет: решение о том, что
 * блокирует, а что нет, целиком повторяет серверное.
 */
function blockingConflict(conflicts: ExpertConflict[], expertId: string): ExpertConflict | null {
  return (
    conflicts.find(
      (c) => c.expertId === expertId && (c.resolution === null || c.resolution === 'recused'),
    ) ?? null
  );
}

function disclosedConflict(conflicts: ExpertConflict[], expertId: string): ExpertConflict | null {
  return (
    conflicts.find((c) => c.expertId === expertId && c.resolution === 'approved_with_disclosure') ??
    null
  );
}

export function ReviewAssignmentsSection() {
  const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('');
  const [items, setItems] = useState<ProjectReviewAssignment[]>([]);
  const [conflicts, setConflicts] = useState<ExpertConflict[]>([]);
  const [expertId, setExpertId] = useState('');
  const [expertName, setExpertName] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async (id: string) => {
    // Назначения и конфликты грузятся вместе: показывать список рецензентов,
    // не зная про заявленные конфликты, — это и есть «узнать из отказа».
    const [page, declared] = await Promise.all([
      api.expertAssignments.ofProject(id),
      api.expertAssignments.conflictsOfProject(id),
    ]);
    setItems(page.items);
    setConflicts(declared.items);
  }, []);

  const blocking = expertId ? blockingConflict(conflicts, expertId) : null;
  const disclosed = expertId ? disclosedConflict(conflicts, expertId) : null;

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

  async function revokeAccess(assignmentId: string): Promise<void> {
    if (reason.trim().length < 3) {
      setNotice({ tone: 'error', text: 'Укажите основание: оно попадёт в журнал' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const after = await api.expertAssignments.revokeAccess(assignmentId, reason.trim());
      await load(projectId);
      setNotice({
        tone: 'ok',
        text: after.reviewSubmitted
          ? 'Доступ прекращён. Поданная рецензия осталась — прекращение доступа работу не отменяет'
          : 'Доступ прекращён, назначение закрыто',
      });
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
        <span className="small muted">
          «Прекратить доступ» закрывает именно доступ, а не работу: поданная рецензия остаётся
          поданной и остаётся за своим автором. Если рецензии ещё нет, назначение при этом
          закрывается — ждать её больше не от кого. Вернуть доступ можно только новым назначением.
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
                  {item.reviewSubmitted ? <Badge tone="success">рецензия подана</Badge> : null}
                  {item.accessRevokedAt ? <Badge tone="neutral">доступ прекращён</Badge> : null}
                  <span className="small muted">
                    срок {new Date(item.dueAt).toLocaleDateString('ru-RU')}
                    {item.accessRevokedAt
                      ? ` · доступ прекращён ${new Date(item.accessRevokedAt).toLocaleDateString('ru-RU')}`
                      : ''}
                  </span>
                  {/*
                    Кнопка доступна при любом состоянии работы, в том числе после
                    сданной рецензии: иначе прекратить доступ было бы нечем. Она
                    пропадает только когда доступ уже прекращён.
                  */}
                  {item.accessRevokedAt ? null : (
                    <Button
                      variant="danger"
                      loading={busy}
                      onClick={() => void revokeAccess(item.id)}
                    >
                      Прекратить доступ
                    </Button>
                  )}
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

            {/*
              Известное ограничение показывается ДО попытки работы. Правило
              остаётся серверным: этот блок ничего не решает, он повторяет то,
              чем ответит сервер, чтобы человек не узнавал об этом из отказа.
            */}
            {blocking ? (
              <div
                role="alert"
                style={{
                  padding: 'var(--u-space-3)',
                  borderRadius: 'var(--u-radius-md)',
                  background: 'var(--u-danger-subtle)',
                  color: 'var(--u-danger)',
                }}
              >
                У этого эксперта по проекту заявлен конфликт интересов
                {blocking.resolution === 'recused'
                  ? ' и принято решение об отводе'
                  : ', решения по нему ещё нет'}
                . Назначение отклонит сервер. Сначала — решение комплаенса, потом работа эксперта.
                <div className="small" style={{ marginTop: 4 }}>
                  Заявлено {new Date(blocking.createdAt).toLocaleDateString('ru-RU')}:{' '}
                  {blocking.description}
                </div>
              </div>
            ) : null}
            {!blocking && disclosed ? (
              <div className="small muted">
                Конфликт интересов по этому проекту заявлен и разрешён с раскрытием (
                {new Date(disclosed.createdAt).toLocaleDateString('ru-RU')}). Назначение возможно.
              </div>
            ) : null}
            {conflicts.length > 0 && !expertId ? (
              <div className="small muted">
                По проекту заявлено конфликтов интересов: {conflicts.length}. Выберите человека,
                чтобы увидеть, касается ли это его.
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
              label="Основание прекращения доступа"
              htmlFor="review-reason"
              hint="Нужно только для прекращения доступа; попадёт в журнал"
            >
              <Input
                id="review-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Например: работа по проекту завершена"
              />
            </Field>

            <div>
              <Button
                loading={busy}
                disabled={!expertId || !dueAt || blocking !== null}
                onClick={() => void assign()}
              >
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
          назначение ничего не позволяет: нужны ещё полномочия из раздела выше. Прекращение доступа
          закрывает область работы; уже сделанные записи о деньгах остаются — они о состоявшихся
          событиях, и переписывать их нечем.
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
                    'Доступ прекращён',
                  )
                }
              >
                Прекратить доступ
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
