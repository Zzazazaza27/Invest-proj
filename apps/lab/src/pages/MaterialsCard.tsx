import { useCallback, useEffect, useRef, useState } from 'react';
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
import {
  MATERIAL_UPLOAD_HISTORY_LIMIT,
  MATERIAL_UPLOAD_RULES,
  type MaterialUploadResult,
  type ProjectMaterial,
  type UserOperation,
} from '@unicorn/contracts';
import { ApiError, api } from '../api';
import { useOperations } from '../operations';
import { S } from '../strings';

// Лимит и допустимые форматы — из контрактов, а не строкой в подсказке:
// обещание «до N МБ» в интерфейсе разошлось с проверкой сервера ровно один
// раз — и этого достаточно (CODE-MED-02: UI обещал 500 МБ при серверных 50).
const DECK_RULES = MATERIAL_UPLOAD_RULES.deck;
const DECK_MAX_MB = Math.floor(DECK_RULES.maxBytes / (1024 * 1024));

const TYPE_TITLES: Record<string, string> = {
  deck: 'презентация',
  video: 'видео',
  doc: 'документ',
  product_link: 'ссылка на продукт',
};

/**
 * Опрос показанной операции (1.5): первую минуту наблюдения — раз в 5 секунд,
 * дальше — раз в 30. В скрытой вкладке опрос стоит, по итогу прекращается.
 * Это запрос состояния, а не повтор действия.
 */
const POLL_FAST_MS = 5_000;
const POLL_SLOW_MS = 30_000;
const POLL_FAST_WINDOW_MS = 60_000;

/** Предел передачи на входе (Caddy `read_body`, 2.1.2): браузер ждёт не меньше. */
const TRANSFER_LIMIT_MS = 90 * 60_000;

/** Ждать до срока формы, но не меньше предела передачи. */
function uploadTimeoutMs(expiresAt: string): number {
  return Math.max(TRANSFER_LIMIT_MS, Date.parse(expiresAt) - Date.now());
}

/** Текст «требует вмешательства» — честно: автоматическая обработка остановлена. */
const NEEDS_ATTENTION_TEXT =
  'Не удалось завершить сохранение. Повторять загрузку не нужно — требуется проверка.';

/**
 * Материалы проекта и ссылка на продукт.
 *
 * Файл сюда НЕ проходит: сервер выдаёт подписанную форму загрузки, и файл идёт
 * в хранилище напрямую. Поэтому здесь два разных действия с разной механикой —
 * добавить ссылку (обычный запрос) и получить билет на загрузку (после чего
 * форма отправляется в хранилище браузером).
 *
 * Под списком материалов — загрузки ТЕКУЩЕГО пользователя, которые ещё не
 * стали материалом: идущие, не принятые и требующие проверки (2.1-W04). Идущую
 * можно отменить; не принятая остаётся с причиной и после закрытия
 * всплывающего сообщения.
 */
export function MaterialsCard({ projectId }: { projectId: string }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: ProjectMaterial[] }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [uploads, setUploads] = useState<UserOperation[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const { requestCheck } = useOperations();

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', items: await api.projects.materials(projectId) });
    } catch (error) {
      setState({ status: 'error', message: errorText(error) });
    }
  }, [projectId]);

  /** Загрузки пользователя. Ошибка чтения не ломает карточку — список просто не обновился. */
  const loadUploads = useCallback(async (): Promise<UserOperation[] | null> => {
    try {
      const items = await api.projects.materialUploads(projectId);
      setUploads(items);
      return items;
    } catch {
      return null;
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    void loadUploads();
  }, [load, loadUploads]);

  // --- опрос идущих загрузок ------------------------------------------------
  const hasPending = uploads.some((item) => item.state === 'pending');
  const pendingIds = useRef(new Set<string>());
  pendingIds.current = new Set(uploads.filter((u) => u.state === 'pending').map((u) => u.id));

  useEffect(() => {
    if (!hasPending) return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      // Скрытая вкладка: опрос стоит до возвращения.
      if (document.visibilityState !== 'visible') return;
      const before = pendingIds.current;
      const items = await loadUploads();
      if (stopped) return;
      if (items) {
        const finished = [...before].filter(
          (id) => !items.some((item) => item.id === id && item.state === 'pending'),
        );
        if (finished.length > 0) {
          // Итог появился: материал — в список, окончательная ошибка — во
          // всплывающее сообщение через общую проверку.
          void load();
          requestCheck();
        }
        if (!items.some((item) => item.state === 'pending')) return;
      }
      schedule();
    };
    const schedule = () => {
      const delay = Date.now() - started < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS;
      timer = setTimeout(() => void tick(), delay);
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      if (timer) clearTimeout(timer);
      void tick();
    };

    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [hasPending, load, loadUploads, requestCheck]);

  /** Отметка владельца: единственный способ открыть материал допущенным инвесторам (5.7.3). */
  const toggleVisibility = useCallback(
    async (material: ProjectMaterial) => {
      setBusy(true);
      setNotice(null);
      try {
        await api.projects.setMaterialVisibility(projectId, material.id, {
          visibility: material.visibility === 'investors' ? 'private' : 'investors',
        });
        setNotice({ tone: 'ok', text: S.materials.visibility.done });
        await load();
      } catch (error) {
        setNotice({ tone: 'error', text: errorText(error) });
      } finally {
        setBusy(false);
      }
    },
    [projectId, load],
  );

  const addLink = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      // Адрес не проверяется здесь на «внутренний»: этот запрет — правило
      // сервера (SSRF), и дублировать его в браузере значило бы завести второе
      // место, где он может разойтись с настоящим.
      await api.projects.addProductLink(projectId, { projectId, url });
      setUrl('');
      setNotice({ tone: 'ok', text: 'Ссылка добавлена' });
      await load();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }, [projectId, url, load]);

  /**
   * Загрузка файла: сервер выдаёт подписанную форму, браузер отправляет файл
   * прямо в хранилище. Условия подписи (ключ, тип, размер) проверяет само
   * хранилище — заявленный размер здесь ничего не «разрешает».
   *
   * Шагов ТРИ, и третий обязателен. Раньше их было два: получить форму и
   * отправить файл, после чего интерфейс объявлял «Файл загружен». Но пока
   * загрузка не подтверждена сервером, материал остаётся незавершённым, и
   * уборщик штатно удаляет объект через час — пользователю сообщили об успехе,
   * которого не было (CODE-03).
   *
   * Подтверждение не «отчёт клиента»: сервер сам ходит в хранилище и убеждается,
   * что объект есть. Поэтому вызов нельзя ни пропустить, ни подделать.
   */
  const upload = useCallback(async () => {
    if (!file) return;
    // Лимит проверяется ДО запроса билета: пользователь узнаёт об ошибке
    // сразу, а не после ожидания ответа сервера (CODE-MED-02).
    if (file.size > DECK_RULES.maxBytes) {
      setNotice({
        tone: 'error',
        text: `Файл больше ${DECK_MAX_MB} МБ — выберите файл меньшего размера`,
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const ticket = await api.projects.requestUpload(projectId, {
        projectId,
        type: 'deck',
        fileName: file.name,
        contentType: file.type as 'application/pdf',
        sizeBytes: file.size,
      });
      // Загрузка уже числится: она видна в списке и её можно отменить, пока
      // файл передаётся.
      void loadUploads();
      const form = new FormData();
      for (const [key, value] of Object.entries(ticket.formFields)) form.append(key, value);
      form.append('file', file);
      // Таймаут обязателен и здесь: хранилище — внешняя зависимость, и зависший
      // запрос иначе оставляет кнопку в состоянии «загружается» навсегда.
      // Но не короче всей допустимой передачи (2.1.2, 2.1-W06): форма живёт
      // 95 минут, Caddy принимает тело до 90 — браузер ждёт до срока формы.
      // Пять минут прежнего таймаута обрывали большой файл на медленном канале.
      const response = await fetch(ticket.uploadUrl, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(uploadTimeoutMs(ticket.expiresAt)),
      });
      if (!response.ok) throw new Error(`хранилище ответило ${response.status}`);

      // Успех объявляется только по состоянию «готово»: файл скопирован,
      // проверен и связан с проектом. Ответ хранилища и сам вызов
      // подтверждения успехом ещё не являются (2.1-W03).
      const result = await api.projects.finalizeUpload(projectId, ticket.materialId);

      setFile(null);
      setNotice(uploadNotice(result));
      await Promise.all([load(), loadUploads()]);
      // Не принят — итог показывает общее сообщение (1.5), один раз.
      if (result.uploadState === 'rejected') requestCheck();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error, 'Загрузка не удалась') });
      void loadUploads();
    } finally {
      setBusy(false);
    }
  }, [file, projectId, load, loadUploads, requestCheck]);

  /**
   * Отмена идущей загрузки: состояние «отменено», запись и файл сохраняются,
   * место в проекте освобождается. Загрузка могла успеть завершиться — тогда
   * сервер отвечает её фактическим состоянием, и отменять нечего.
   */
  const cancel = useCallback(
    async (op: UserOperation) => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await api.projects.cancelUpload(projectId, op.id);
        setNotice(cancelNotice(result));
        await Promise.all([load(), loadUploads()]);
        if (result.uploadState === 'rejected') requestCheck();
      } catch (error) {
        setNotice({ tone: 'error', text: errorText(error) });
      } finally {
        setBusy(false);
      }
    },
    [projectId, load, loadUploads, requestCheck],
  );

  return (
    <Card id="materials">
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Материалы</h2>

        {state.status === 'loading' ? <LoadingState label="Загружаем материалы" /> : null}
        {state.status === 'error' ? (
          <ErrorState description={state.message} onRetry={() => void load()} />
        ) : null}
        {state.status === 'ready' && state.items.length === 0 ? (
          <EmptyState
            title="Материалов пока нет"
            description="Добавьте презентацию и ссылку на работающий продукт — по ним о проекте судят те, кому вы его откроете."
          />
        ) : null}
        {state.status === 'ready' && state.items.length > 0 ? (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: 'var(--u-space-2)',
            }}
          >
            {state.items.map((material) => (
              <li
                key={material.id}
                // Строка материала переносится: значки, отметка и кнопка не
                // умещаются в одну строку на телефоне и раньше растягивали
                // страницу до горизонтальной прокрутки.
                style={{
                  display: 'flex',
                  gap: 'var(--u-space-3)',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <Badge>{TYPE_TITLES[material.type] ?? material.type}</Badge>
                <span style={{ flex: '1 1 160px', minWidth: 0, wordBreak: 'break-all' }}>
                  {material.url ?? `версия ${material.version}`}
                </span>
                {/* Маркер на обёртке: Badge не пробрасывает произвольные
                    атрибуты, а проверкам нужна отметка материала. */}
                <span data-material-visibility={material.visibility}>
                  <Badge tone={material.visibility === 'investors' ? 'success' : 'neutral'}>
                    {
                      S.materials.visibility[
                        material.visibility === 'investors' ? 'investors' : 'private'
                      ]
                    }
                  </Badge>
                </span>
                <Button
                  variant="secondary"
                  loading={busy}
                  data-material-toggle={material.id}
                  onClick={() => void toggleVisibility(material)}
                >
                  {material.visibility === 'investors'
                    ? S.materials.visibility.hide
                    : S.materials.visibility.show}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {state.status === 'ready' && state.items.length > 0 ? (
          <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
            {S.materials.visibility.hint}
          </span>
        ) : null}

        {uploads.length > 0 ? (
          <div data-uploads>
            <h3 style={{ margin: '0 0 var(--u-space-2)', fontSize: 'var(--u-text-md)' }}>
              Ваши загрузки
            </h3>
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: 'var(--u-space-2)',
              }}
            >
              {uploads.map((op) => (
                <li
                  key={op.id}
                  data-upload-row={op.id}
                  data-upload-state={op.state}
                  style={{
                    display: 'flex',
                    gap: 'var(--u-space-3)',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    padding: 'var(--u-space-2) var(--u-space-3)',
                    border: '1px solid var(--u-border)',
                    borderRadius: 'var(--u-radius-md)',
                  }}
                >
                  <Badge tone={UPLOAD_BADGES[op.state].tone}>{UPLOAD_BADGES[op.state].label}</Badge>
                  <span style={{ flex: '1 1 200px', minWidth: 0, overflowWrap: 'anywhere' }}>
                    <strong style={{ fontWeight: 600 }}>
                      {op.fileName ?? TYPE_TITLES[op.materialType] ?? op.materialType}
                    </strong>
                    <span
                      data-upload-text
                      style={{
                        display: 'block',
                        fontSize: 'var(--u-text-sm)',
                        color: op.state === 'rejected' ? 'var(--u-danger)' : 'var(--u-text-muted)',
                      }}
                    >
                      {uploadText(op)}
                    </span>
                  </span>
                  {op.state === 'pending' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy}
                      data-upload-cancel={op.id}
                      onClick={() => void cancel(op)}
                    >
                      Отменить загрузку
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {uploads.filter((op) => op.state !== 'pending').length >=
            MATERIAL_UPLOAD_HISTORY_LIMIT ? (
              <span
                data-uploads-history-limit
                style={{ fontSize: 'var(--u-text-xs)', color: 'var(--u-text-muted)' }}
              >
                Из завершённых без успеха показаны последние {MATERIAL_UPLOAD_HISTORY_LIMIT}. Идущие
                загрузки показаны все.
              </span>
            ) : null}
          </div>
        ) : null}

        {notice ? (
          <div
            role={notice.tone === 'error' ? 'alert' : 'status'}
            data-upload-notice={notice.tone}
            style={{
              padding: 'var(--u-space-3) var(--u-space-4)',
              borderRadius: 'var(--u-radius-md)',
              background: NOTICE_COLORS[notice.tone].background,
              color: NOTICE_COLORS[notice.tone].color,
            }}
          >
            {notice.text}
          </div>
        ) : null}

        <Field label="Ссылка на продукт" htmlFor="product-link" hint="Только https-адрес">
          <Input
            id="product-link"
            type="url"
            value={url}
            placeholder="https://example.com"
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <Button onClick={() => void addLink()} loading={busy} disabled={url.trim().length === 0}>
          Добавить ссылку
        </Button>

        <Field
          label="Презентация"
          htmlFor="deck-file"
          hint={`PDF или PPTX, до ${DECK_MAX_MB} МБ. Файл уходит в хранилище напрямую, минуя API.`}
        >
          <input
            id="deck-file"
            type="file"
            accept="application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
        <Button variant="secondary" onClick={() => void upload()} loading={busy} disabled={!file}>
          Загрузить презентацию
        </Button>
      </Stack>
    </Card>
  );
}

type Notice = { tone: 'ok' | 'error' | 'pending'; text: string };

const NOTICE_COLORS: Record<Notice['tone'], { background: string; color: string }> = {
  ok: { background: 'var(--u-success-subtle)', color: 'var(--u-success)' },
  error: { background: 'var(--u-danger-subtle)', color: 'var(--u-danger)' },
  pending: { background: 'var(--u-warning-subtle)', color: 'var(--u-warning)' },
};

const UPLOAD_BADGES: Record<
  UserOperation['state'],
  { label: string; tone: 'neutral' | 'warning' | 'danger' | 'success' }
> = {
  pending: { label: 'Загружается', tone: 'neutral' },
  rejected: { label: 'Не принят', tone: 'danger' },
  needs_attention: { label: 'Требует проверки', tone: 'warning' },
  ready: { label: 'Готово', tone: 'success' },
  cancelled: { label: 'Отменено', tone: 'neutral' },
};

function uploadText(op: UserOperation): string {
  switch (op.state) {
    case 'pending':
      return op.received
        ? 'Файл получен, сохраняем. Он появится в материалах, когда будет готов'
        : 'Файл передаётся или ещё не получен';
    case 'rejected':
      return op.reason ?? 'Файл не подошёл — загрузите другой файл';
    case 'needs_attention':
      return NEEDS_ATTENTION_TEXT;
    default:
      return '';
  }
}

/**
 * Сообщение по итогу подтверждения (2.1-W03). «Получен, сохраняем» — только
 * когда хранилище подтвердило объект; иначе состояние ещё выясняется.
 */
function uploadNotice(result: MaterialUploadResult): Notice {
  switch (result.uploadState) {
    case 'ready':
      return { tone: 'ok', text: 'Файл загружен и подтверждён' };
    case 'rejected':
      return { tone: 'error', text: result.reason ?? 'Файл не подходит — выберите другой файл' };
    case 'needs_attention':
      return { tone: 'error', text: NEEDS_ATTENTION_TEXT };
    case 'cancelled':
      return { tone: 'pending', text: 'Загрузка отменена' };
    default:
      return result.received
        ? {
            tone: 'pending',
            text: 'Файл получен, сохраняем. Он появится в списке, когда будет готов',
          }
        : { tone: 'pending', text: 'Загрузка ещё не завершена, проверяем состояние' };
  }
}

/** Итог отмены: отменено — или загрузка успела закончиться раньше. */
function cancelNotice(result: MaterialUploadResult): Notice {
  switch (result.uploadState) {
    case 'cancelled':
      return { tone: 'ok', text: 'Загрузка отменена, место в проекте освобождено' };
    case 'ready':
      return { tone: 'ok', text: 'Файл успел загрузиться — он уже в материалах' };
    default:
      return uploadNotice(result);
  }
}

/**
 * Текст ошибки: отказ сервера — его объяснение. Для загрузки показывается и
 * собственная ошибка браузера (отказ хранилища, таймаут), для остального — общее
 * «Сервис недоступен», как раньше.
 */
function errorText(error: unknown, uploadFallback?: string): string {
  if (error instanceof ApiError) return error.problem?.detail ?? error.message;
  if (uploadFallback) return error instanceof Error ? error.message : uploadFallback;
  return 'Сервис недоступен';
}
