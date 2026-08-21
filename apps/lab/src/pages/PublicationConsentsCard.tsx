import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Stack } from '@unicorn/ui';
import type { PublicationConsent, PublicationDisclosableField } from '@unicorn/contracts';
import { ApiError, api } from '../api';

/**
 * Согласия на публичный контур — разрешение снимать и показывать.
 *
 * Экран собран так, чтобы согласие оставалось согласием, а не галочкой:
 *
 *  * области перечислены отдельно и выдаются по одной — «разрешаю всё» одной
 *    кнопкой не является информированным согласием;
 *  * состав раскрываемых данных виден до нажатия, а не описан в документе,
 *    который никто не открывает;
 *  * отзыв доступен всегда и рядом с выдачей. Право отозвать согласие
 *    (152-ФЗ ст. 9) не должно требовать письма в поддержку;
 *  * после отзыва показывается КРАЙНИЙ СРОК удаления публичной проекции —
 *    обязательство платформы, а не «мы передали запрос».
 *
 * Версия документа не подставляется интерфейсом: её отдаёт сервер списком
 * действующих документов. Зашитый номер — ровно та ошибка, из-за которой
 * регистрация отвечала 500 до Ф49.
 */
const SCOPES: { value: PublicationConsent['scope']; title: string; description: string }[] = [
  {
    value: 'episode_selection',
    title: 'Выпуск отбора',
    description: 'Съёмка и показ в выпуске об отборе проектов',
  },
  {
    value: 'episode_bootcamp',
    title: 'Выпуск буткемпа',
    description: 'Съёмка и показ в выпусках буткемпа',
  },
  {
    value: 'final_live',
    title: 'Финальный эфир',
    description: 'Прямая трансляция финала и её повторы',
  },
  {
    value: 'top100_public',
    title: 'Публичный топ-100',
    description: 'Карточка проекта в открытом рейтинге платформы',
  },
];

/**
 * Что можно раскрыть. Словарь тот же, что в контракте: список читает
 * медиаконтур и исполняет буквально, поэтому вольные формулировки здесь
 * недопустимы — они не были бы исполнимы.
 */
const DISCLOSABLE: { value: PublicationDisclosableField; title: string }[] = [
  { value: 'project_title', title: 'Название проекта' },
  { value: 'project_tagline', title: 'Короткое описание' },
  { value: 'project_description', title: 'Полное описание' },
  { value: 'project_stage', title: 'Стадия' },
  { value: 'project_geo', title: 'География' },
  { value: 'investment_ask', title: 'Запрос инвестиций' },
  { value: 'founder_display_name', title: 'Имя основателя' },
  { value: 'founder_photo', title: 'Фотография основателя' },
  { value: 'founder_video', title: 'Видео с основателем' },
  { value: 'team_members', title: 'Состав команды' },
  { value: 'metrics', title: 'Метрики' },
  { value: 'pitch_deck', title: 'Презентация' },
];

const DOCUMENT_KIND = 'pdn_biometric';

export function PublicationConsentsCard({ projectId }: { projectId: string }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: PublicationConsent[]; documentVersion: string | null }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [selected, setSelected] = useState<Set<PublicationDisclosableField>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      // Список согласий и действующая версия документа берутся вместе: без
      // версии кнопка выдачи не работает, и показывать её работающей нельзя.
      const [items, templates] = await Promise.all([
        api.publication.list(projectId),
        api.auth.consentTemplates('ru-RU'),
      ]);
      const document = templates.find((template) => template.kind === DOCUMENT_KIND);
      setState({ status: 'ready', items, documentVersion: document?.version ?? null });
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

  async function run(key: string, action: () => Promise<unknown>, okText: string): Promise<void> {
    setBusy(key);
    setNotice(null);
    try {
      await action();
      setNotice({ tone: 'ok', text: okText });
      await load();
    } catch (error) {
      // Причину отказа объясняет сервер: он один знает и состав участников
      // проекта, и действующую версию документа.
      setNotice({
        tone: 'error',
        text:
          error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : 'Сервис недоступен',
      });
    } finally {
      setBusy(null);
    }
  }

  if (state.status === 'loading') return <LoadingState label="Загружаем согласия" />;
  if (state.status === 'error') {
    return <ErrorState description={state.message} onRetry={() => void load()} />;
  }

  const active = new Map(
    state.items.filter((item) => item.revokedAt === null).map((item) => [item.scope, item]),
  );
  const revoked = state.items.filter((item) => item.revokedAt !== null);

  return (
    <Card>
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Согласия на публичный контур</h2>
        <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
          Съёмка и публичный показ возможны только с вашего согласия. Оно даётся по областям
          отдельно и отзывается в любой момент; после отзыва публичная проекция удаляется в течение
          15 минут.
        </span>

        {state.documentVersion === null ? (
          <EmptyState
            title="Документ не опубликован"
            description="Действующей версии согласия на публичность нет — выдать согласие сейчас нельзя."
          />
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

        <fieldset
          style={{
            border: '1px solid var(--u-border)',
            borderRadius: 'var(--u-radius-md)',
            padding: 'var(--u-space-4)',
            margin: 0,
          }}
        >
          <legend style={{ padding: '0 var(--u-space-2)', color: 'var(--u-text-muted)' }}>
            Что разрешаю раскрывать
          </legend>
          <div style={{ display: 'flex', gap: 'var(--u-space-3)', flexWrap: 'wrap' }}>
            {DISCLOSABLE.map((field) => (
              // Подпись связана с полем через `htmlFor`, а не только обёрткой:
              // обёртка работает в браузере, но проверка доступности требует
              // явной связи — и она же переживает перестановку разметки.
              <label
                key={field.value}
                htmlFor={`disclose-${field.value}`}
                style={{ display: 'flex', gap: 'var(--u-space-2)', alignItems: 'center' }}
              >
                <input
                  id={`disclose-${field.value}`}
                  type="checkbox"
                  checked={selected.has(field.value)}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(field.value);
                    else next.delete(field.value);
                    setSelected(next);
                  }}
                />
                {field.title}
              </label>
            ))}
          </div>
          <span
            style={{
              display: 'block',
              marginTop: 'var(--u-space-3)',
              color: 'var(--u-text-muted)',
              fontSize: 'var(--u-text-sm)',
            }}
          >
            Пустой список — тоже согласие: снимать можно, данные проекта не раскрывать.
          </span>
        </fieldset>

        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: 'var(--u-space-3)',
          }}
        >
          {SCOPES.map((scope) => {
            const granted = active.get(scope.value);
            return (
              <li
                key={scope.value}
                style={{
                  display: 'flex',
                  gap: 'var(--u-space-3)',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  borderTop: '1px solid var(--u-border)',
                  paddingTop: 'var(--u-space-3)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {scope.title}{' '}
                    {granted ? <Badge tone="success">выдано</Badge> : <Badge>не выдано</Badge>}
                  </div>
                  <div style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                    {scope.description}
                  </div>
                  {granted ? (
                    <div style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                      Раскрывается:{' '}
                      {granted.disclosedFields.length === 0
                        ? 'ничего сверх факта съёмки'
                        : granted.disclosedFields
                            .map(
                              (field) =>
                                DISCLOSABLE.find((item) => item.value === field)?.title ?? field,
                            )
                            .join(', ')}
                    </div>
                  ) : null}
                </div>
                {granted ? (
                  <Button
                    variant="danger"
                    loading={busy === `revoke:${scope.value}`}
                    onClick={() =>
                      void run(
                        `revoke:${scope.value}`,
                        () => api.publication.revoke(granted.id),
                        'Согласие отозвано, проекция будет удалена в течение 15 минут',
                      )
                    }
                  >
                    Отозвать
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={state.documentVersion === null}
                    loading={busy === `grant:${scope.value}`}
                    onClick={() =>
                      void run(
                        `grant:${scope.value}`,
                        () =>
                          api.publication.grant({
                            projectId,
                            scope: scope.value,
                            disclosedFields: [...selected],
                            documentVersion: state.documentVersion!,
                          }),
                        'Согласие выдано',
                      )
                    }
                  >
                    Дать согласие
                  </Button>
                )}
              </li>
            );
          })}
        </ul>

        {revoked.length > 0 ? (
          <details>
            <summary style={{ cursor: 'pointer', color: 'var(--u-text-muted)' }}>
              Отозванные согласия ({revoked.length})
            </summary>
            <ul style={{ margin: 'var(--u-space-3) 0 0', paddingLeft: 'var(--u-space-5)' }}>
              {revoked.map((item) => (
                <li key={item.id} style={{ color: 'var(--u-text-muted)' }}>
                  {SCOPES.find((scope) => scope.value === item.scope)?.title ?? item.scope} —
                  отозвано {new Date(item.revokedAt!).toLocaleString('ru-RU')}, удаление проекции до{' '}
                  {new Date(item.deletionDeadline!).toLocaleString('ru-RU')}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Stack>
    </Card>
  );
}
