import { useCallback, useEffect, useState } from 'react';
import { ContextualImage, noteGroupError, useFilesAvailability } from '@fifth/cabinet';
import { Button, Card, Stack } from '@fifth/ui';
import { MEDIA_LIMITS, type ProjectMedia, type ProjectMediaKind } from '@fifth/contracts';
import { keyAfterError, keyForSend, type RetryKey } from '@fifth/api-client';
import { ApiError, api, mediaUrl } from '../api';
import { S } from '../strings';

/**
 * Логотип и обложка проекта (7.2).
 *
 * Кадрирование задаётся ТОЧКОЙ ФОКУСА, а не рамкой с ручками. Это осознанный
 * размен: редактор с рамкой умеет больше, но требует мыши, аккуратности и
 * объяснений, а на телефоне превращается в мучение. Точка отвечает на
 * единственный вопрос, который здесь важен, — что не должно уехать за край.
 *
 * Изображения показываются по адресам ядра: доступ к ним проверяется на
 * каждом запросе, и ссылка сама по себе ничего не открывает.
 */
/**
 * Незавершённое подтверждение загрузки (2.6, M164): загрузка, её точка фокуса и состояние
 * ключа — ВНЕ компонента, по проекту и виду. После потерянного ответа проверка и повтор
 * подтверждения идут для ПРЕЖНЕЙ загрузки (тот же uploadId и ключ `media-<uploadId>`) —
 * без нового билета, без повторной обработки и события на сервере. Новый билет — только для
 * новой операции, когда человек явно выбрал другое изображение. Живёт в памяти страницы:
 * перезагрузка его не сохраняет — результат тогда виден в карточке.
 */
interface PendingFinalize {
  uploadId: string;
  focusX: number;
  focusY: number;
  key: RetryKey;
}
const pendingFinalize = new Map<string, PendingFinalize>();
const slotOf = (projectId: string, kind: ProjectMediaKind) => `${projectId}:${kind}`;

export function MediaCard({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ProjectMedia[] | null>(null);
  const [busy, setBusy] = useState<ProjectMediaKind | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  // Группа «Файлы» (4.11): ограничиваются только загрузка и удаление; причину на странице
  // показывает карточка материалов — одна на группу.
  const files = useFilesAvailability(api.features);
  const [, rerender] = useState(0);
  const pendingOf = (kind: ProjectMediaKind) => pendingFinalize.get(slotOf(projectId, kind));

  const load = useCallback(async () => {
    const result = await api.projects.media(projectId).catch(() => ({ items: [] }));
    setItems(result.items);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(kind: ProjectMediaKind, file: File, focusX: number, focusY: number) {
    const limits = MEDIA_LIMITS[kind];
    if (file.size > limits.maxBytes) {
      setNotice({
        tone: 'error',
        text: `Файл больше ${Math.round(limits.maxBytes / (1024 * 1024))} МБ`,
      });
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setNotice({ tone: 'error', text: 'Подходят JPEG, PNG и WebP' });
      return;
    }

    setBusy(kind);
    setNotice(null);
    try {
      const ticket = await api.projects.requestMediaUpload(projectId, {
        kind,
        contentType: file.type as 'image/jpeg',
        sizeBytes: file.size,
      });
      const form = new FormData();
      for (const [key, value] of Object.entries(ticket.formFields)) form.append(key, value);
      form.append('file', file);
      const response = await fetch(ticket.uploadUrl, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`хранилище ответило ${response.status}`);

      // Успех объявляется после подтверждения: до него платформа ещё не
      // смотрела, что внутри файла, и отказать может именно здесь.
      pendingFinalize.set(slotOf(projectId, kind), {
        uploadId: ticket.uploadId,
        focusX,
        focusY,
        key: keyForSend(null),
      });
    } catch (error) {
      noteGroupError(error);
      setNotice({
        tone: 'error',
        text:
          error instanceof ApiError
            ? (error.problem?.errors?.[0]?.message ?? error.problem?.detail ?? error.message)
            : error instanceof Error
              ? error.message
              : 'Загрузка не удалась',
      });
    } finally {
      setBusy(null);
    }
    if (pendingOf(kind)) await confirm(kind);
  }

  /** Подтвердить прежнюю загрузку: тот же uploadId и ключ; неизвестный исход — держать. */
  async function confirm(kind: ProjectMediaKind) {
    const pending = pendingOf(kind);
    if (!pending) return;
    setBusy(kind);
    setNotice(null);
    try {
      await api.projects.finalizeMedia(projectId, kind, {
        uploadId: pending.uploadId,
        focusX: pending.focusX,
        focusY: pending.focusY,
      });
      pendingFinalize.delete(slotOf(projectId, kind));
      setNotice({ tone: 'ok', text: 'Изображение загружено' });
      await load();
    } catch (error) {
      noteGroupError(error);
      const kept = keyAfterError(pending.key, error);
      if (kept) {
        pendingFinalize.set(slotOf(projectId, kind), { ...pending, key: kept });
        setNotice({
          tone: 'error',
          text: 'Исход подтверждения неизвестен: изображение могло уже сохраниться. Проверьте загрузку — повтор не обработает файл второй раз.',
        });
      } else {
        pendingFinalize.delete(slotOf(projectId, kind));
        setNotice({
          tone: 'error',
          text:
            error instanceof ApiError
              ? (error.problem?.errors?.[0]?.message ?? error.problem?.detail ?? error.message)
              : 'Загрузка не удалась',
        });
      }
    } finally {
      setBusy(null);
      rerender((n) => n + 1);
    }
  }

  async function remove(kind: ProjectMediaKind) {
    setBusy(kind);
    try {
      await api.projects.removeMedia(projectId, kind);
      setNotice({ tone: 'ok', text: 'Изображение убрано' });
      await load();
    } catch (error) {
      noteGroupError(error);
      setNotice({
        tone: 'error',
        text: error instanceof ApiError ? (error.problem?.detail ?? 'Не удалось') : 'Не удалось',
      });
    } finally {
      setBusy(null);
    }
  }

  if (items === null) return null;

  return (
    <Card data-project-media>
      <Stack gap="var(--u-space-4)">
        <div>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>{S.media.title}</h2>
          <div className="small muted">{S.media.hint}</div>
        </div>

        {notice ? (
          <div
            data-media-notice={notice.tone}
            style={{ color: notice.tone === 'ok' ? 'var(--u-success)' : 'var(--u-danger)' }}
          >
            {notice.text}
          </div>
        ) : null}

        {(['logo', 'cover'] as ProjectMediaKind[]).map((kind) => (
          <MediaSlot
            key={kind}
            kind={kind}
            media={items.find((item) => item.kind === kind) ?? null}
            busy={busy === kind}
            canWrite={files.canWrite}
            pending={Boolean(pendingOf(kind))}
            onUpload={(file, focusX, focusY) => void upload(kind, file, focusX, focusY)}
            onCheck={() => void confirm(kind)}
            onDiscard={() => {
              // Явное решение: прежнюю загрузку не выяснять, следующая — новая операция.
              pendingFinalize.delete(slotOf(projectId, kind));
              setNotice(null);
              rerender((n) => n + 1);
            }}
            onRemove={() => void remove(kind)}
          />
        ))}
      </Stack>
    </Card>
  );
}

function MediaSlot({
  kind,
  media,
  busy,
  canWrite,
  pending,
  onUpload,
  onCheck,
  onDiscard,
  onRemove,
}: {
  kind: ProjectMediaKind;
  media: ProjectMedia | null;
  busy: boolean;
  canWrite: boolean;
  /** Подтверждение прежней загрузки не выяснено. */
  pending: boolean;
  onUpload: (file: File, focusX: number, focusY: number) => void;
  onCheck: () => void;
  onDiscard: () => void;
  onRemove: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [focus, setFocus] = useState<{ x: number; y: number }>({
    x: media?.focusX ?? 0.5,
    y: media?.focusY ?? 0.5,
  });
  const limits = MEDIA_LIMITS[kind];
  const label = kind === 'logo' ? S.media.logo : S.media.cover;

  return (
    <div data-media-slot={kind} style={{ display: 'grid', gap: 'var(--u-space-2)' }}>
      <strong>{label}</strong>
      <span className="small muted">
        {S.media.limits(limits.minWidth, limits.minHeight, Math.round(limits.maxBytes / 1048576))}
      </span>

      {media ? (
        <ContextualImage
          data-media-preview={kind}
          src={`${mediaUrl(media.urls.card ?? '')}?v=${encodeURIComponent(media.updatedAt)}`}
          // Изображение непубличного проекта отдаётся только по сессии. При
          // запуске dev-сервером страница и ядро живут на разных портах, и без
          // этого атрибута браузер запросит картинку БЕЗ cookie — получит
          // отказ и покажет пустую рамку. За единой точкой входа адрес свой, и
          // атрибут ничего не меняет.
          crossOrigin="use-credentials"
          alt=""
          style={{
            width: kind === 'logo' ? 96 : '100%',
            maxWidth: 320,
            borderRadius: 'var(--u-radius-md)',
          }}
        />
      ) : (
        <span className="small muted" data-media-empty={kind}>
          {S.media.empty}
        </span>
      )}

      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label={label}
        data-media-input={kind}
        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
      />

      {/* Позиционирование: две шкалы вместо редактора. */}
      <label className="small muted" htmlFor={`focus-x-${kind}`}>
        {S.media.focusX}
      </label>
      <input
        id={`focus-x-${kind}`}
        type="range"
        min={0}
        max={100}
        value={Math.round(focus.x * 100)}
        data-media-focus-x={kind}
        onChange={(event) => setFocus((f) => ({ ...f, x: Number(event.target.value) / 100 }))}
      />
      <label className="small muted" htmlFor={`focus-y-${kind}`}>
        {S.media.focusY}
      </label>
      <input
        id={`focus-y-${kind}`}
        type="range"
        min={0}
        max={100}
        value={Math.round(focus.y * 100)}
        data-media-focus-y={kind}
        onChange={(event) => setFocus((f) => ({ ...f, y: Number(event.target.value) / 100 }))}
      />

      {pending ? (
        <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
          <Button
            variant="brand"
            loading={busy}
            disabled={!canWrite}
            data-media-check={kind}
            onClick={onCheck}
          >
            Проверить загрузку
          </Button>
          <Button variant="ghost" disabled={busy} data-media-discard={kind} onClick={onDiscard}>
            Загрузить другое изображение
          </Button>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
        <Button
          variant="brand"
          loading={busy}
          disabled={file === null || !canWrite || pending}
          data-media-upload={kind}
          onClick={() => {
            if (file) onUpload(file, focus.x, focus.y);
          }}
        >
          {media ? S.media.replace : S.media.upload}
        </Button>
        {media ? (
          <Button
            variant="secondary"
            loading={busy}
            disabled={!canWrite}
            data-media-remove={kind}
            onClick={onRemove}
          >
            {S.media.remove}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
