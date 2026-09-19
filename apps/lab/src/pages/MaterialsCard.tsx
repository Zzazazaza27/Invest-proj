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
import {
  MATERIAL_UPLOAD_RULES,
  type ProjectMaterial,
  type ProjectVersion,
} from '@unicorn/contracts';
import { ApiError, api } from '../api';
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
 * Состояние разбора материала по-человечески.
 *
 * Сырое `not_required` в списке читалось как поломка: человек видит английский
 * код там, где ждёт понятного слова, и не может отличить норму от ошибки.
 */
const PARSE_STATUS_TITLES: Record<string, string> = {
  not_required: 'разбор не нужен',
  pending: 'ждёт разбора',
  in_progress: 'разбирается',
  done: 'разобран',
  failed: 'разбор не удался',
};

/**
 * Материалы проекта и ссылка на продукт.
 *
 * Файл сюда НЕ проходит: сервер выдаёт подписанную форму загрузки, и файл идёт
 * в хранилище напрямую. Поэтому здесь два разных действия с разной механикой —
 * добавить ссылку (обычный запрос) и получить билет на загрузку (после чего
 * форма отправляется в хранилище браузером).
 */
export function MaterialsCard({ projectId }: { projectId: string }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: ProjectMaterial[] }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', items: await api.projects.materials(projectId) });
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : 'Сервис недоступен',
      });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

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
      const form = new FormData();
      for (const [key, value] of Object.entries(ticket.formFields)) form.append(key, value);
      form.append('file', file);
      // Таймаут обязателен и здесь: хранилище — внешняя зависимость, и зависший
      // запрос иначе оставляет кнопку в состоянии «загружается» навсегда.
      // Пять минут, а не пятнадцать секунд: это выгрузка файла до 500 МБ.
      const response = await fetch(ticket.uploadUrl, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok) throw new Error(`хранилище ответило ${response.status}`);

      // Успех объявляется ПОСЛЕ подтверждения, а не после ответа хранилища.
      // Отказ здесь — настоящий отказ загрузки: объект есть, но материал
      // считается незавершённым и будет убран.
      await api.projects.finalizeUpload(projectId, ticket.materialId);

      setFile(null);
      setNotice({ tone: 'ok', text: 'Файл загружен и подтверждён' });
      await load();
    } catch (error) {
      setNotice({
        tone: 'error',
        text:
          error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : error instanceof Error
              ? error.message
              : 'Загрузка не удалась',
      });
    } finally {
      setBusy(false);
    }
  }, [file, projectId, load]);

  return (
    <Card>
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Материалы</h2>

        {state.status === 'loading' ? <LoadingState label="Загружаем материалы" /> : null}
        {state.status === 'error' ? (
          <ErrorState description={state.message} onRetry={() => void load()} />
        ) : null}
        {state.status === 'ready' && state.items.length === 0 ? (
          <EmptyState
            title="Материалов пока нет"
            description="Добавьте презентацию и ссылку на работающий продукт — по ним работают эксперты."
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
                <Badge tone={material.parseStatus === 'failed' ? 'warning' : 'neutral'}>
                  {PARSE_STATUS_TITLES[material.parseStatus] ?? material.parseStatus}
                </Badge>
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

/**
 * История подач заявки.
 *
 * Раньше жила внутри карточки «Путь по сезону» и исчезла вместе с ней, когда
 * сезоны отложили (M088): владелец перестал видеть, какие версии поданы, хотя
 * к сезонам это не относится — снимок создаётся подачей и идёт на экспертизу
 * независимо от сезонного контура. Поэтому вынесена отдельной карточкой.
 */
export function SubmissionsCard({ projectId }: { projectId: string }) {
  const [versions, setVersions] = useState<ProjectVersion[] | 'loading' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    api.projects
      .versions(projectId)
      .then((value) => {
        if (!cancelled) setVersions(value);
      })
      .catch(() => {
        if (!cancelled) setVersions('error');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <Card data-submissions-card>
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>История подач</h2>
        {versions === 'loading' ? <LoadingState label="Загружаем историю" /> : null}
        {versions === 'error' ? <ErrorState description="История подач недоступна" /> : null}
        {Array.isArray(versions) && versions.length === 0 ? (
          <span style={{ color: 'var(--u-text-muted)' }}>
            Заявка ещё не подавалась. Подача создаёт неизменяемый снимок — именно он идёт на
            экспертизу.
          </span>
        ) : null}
        {Array.isArray(versions) && versions.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 'var(--u-space-5)' }}>
            {versions.map((version) => (
              <li key={version.id}>
                версия {version.versionNo} — {new Date(version.submittedAt).toLocaleString('ru-RU')}
              </li>
            ))}
          </ul>
        ) : null}
      </Stack>
    </Card>
  );
}
