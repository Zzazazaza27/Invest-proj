import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Stack,
  formatMoney,
  formatScore10,
  describeRaising,
} from '@unicorn/ui';
import type { InvestorView } from '@unicorn/contracts';
import { ApiError, api, apiBaseUrl } from '../api';

const STAGE_TITLES: Record<string, string> = {
  idea: 'идея',
  mvp: 'MVP',
  early_revenue: 'первая выручка',
  growth: 'рост',
};

const MATERIAL_TYPE_TITLES: Record<string, string> = {
  deck: 'презентация',
  video: 'видео',
  doc: 'документ',
  product_link: 'ссылка на продукт',
};

const SCORE_AXIS_TITLES: Record<string, string> = {
  market: 'рынок',
  demand: 'спрос',
  competitive_edge: 'преимущество перед конкурентами',
  uniqueness: 'уникальность',
  profitability: 'прибыльность',
  presentation_quality: 'качество подачи',
  scalability: 'масштабируемость',
  investment_readiness: 'готовность к инвестициям',
  product_readiness: 'готовность продукта',
};

const FUNDING_SCOPE_TITLES: Record<string, string> = {
  project: 'проект в целом',
  direction: 'отдельное направление',
};

/**
 * Ссылка материала с проверкой схемы: `javascript:` в `href` — выполнение
 * чужого кода в кабинете смотрящего, поэтому схема проверяется там, где
 * происходит опасное действие.
 */
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:']);
function safeHref(raw: string | null | undefined): string {
  if (!raw) return '#';
  try {
    const parsed = new URL(raw);
    return SAFE_LINK_SCHEMES.has(parsed.protocol) ? parsed.toString() : '#';
  } catch {
    return '#';
  }
}

/**
 * Карточка проекта глазами инвестора — Investor View (5.7.4).
 *
 * Один серверный ответ вместо трёх вызовов: состав решает предикат доступа
 * по каждому разрешению отдельно (профиль, раунд, материалы, паспорт), а
 * страница только показывает, что пришло, и честно называет закрытые
 * блоки. Ответы анкеты — согласованный владельцем снимок с эффективной
 * видимостью; поля выше уровня «инвесторам» сюда не попадают по построению.
 *
 * Документы показываются ВНУТРИ платформы: файл приходит с адреса ядра, с
 * `Content-Disposition: inline` и без кнопки «скачать». Прямых ссылок на
 * хранилище страница не получает. Поверх лежит водяной знак с именем
 * смотрящего — не запрет, а ответственность.
 */
export function ProjectDetailsPage({
  projectId,
  onBack,
}: {
  projectId: string;
  onBack: () => void;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; view: InvestorView }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);

  useEffect(() => {
    api.auth
      .me()
      .then((me) => setViewer(me.displayName))
      .catch(() => setViewer(null));
  }, []);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', view: await api.projects.investorView(projectId) });
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof ApiError
            ? error.status === 404
              ? 'Проект недоступен: его нет или доступ к нему закрыт'
              : (error.problem?.detail ?? error.message)
            : 'Сервис недоступен',
        traceId: error instanceof ApiError ? error.traceId : null,
      });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') return <LoadingState label="Загружаем проект" />;
  if (state.status === 'error') {
    return (
      <Stack>
        <Button variant="secondary" onClick={onBack} style={{ justifySelf: 'start' }}>
          ← К каталогу
        </Button>
        <ErrorState
          description={state.message}
          traceId={state.traceId}
          onRetry={() => void load()}
        />
      </Stack>
    );
  }

  const { view } = state;
  const watermark = `${viewer ?? 'Пятый элемент'}
${new Date().toLocaleDateString('ru-RU')} · Пятый элемент`;
  const materials = view.materials ?? [];
  const files = materials.filter((m) => m.url === null);
  const links = materials.filter((m) => m.url !== null);
  const questionCount = view.sections.reduce((n, s) => n + s.questions.length, 0);
  const accessText =
    view.access.profile === null
      ? 'Доступ: только тизер — ответы анкеты, материалы и оценка закрыты режимом проекта или вашим допуском.'
      : `Доступ: профиль${view.access.materials ? ', материалы' : ''}${view.access.passport ? ', оценка платформы' : ''}${view.access.round ? ', раунд' : ''}.`;

  return (
    <Stack gap="var(--u-space-5)" data-investor-view>
      <Button variant="secondary" onClick={onBack} style={{ justifySelf: 'start' }}>
        ← К каталогу
      </Button>

      <Card>
        <Stack>
          <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
            <Badge tone="accent">{STAGE_TITLES[view.stage] ?? view.stage}</Badge>
            {view.geoCountry ? <Badge>{view.geoCountry}</Badge> : null}
            {view.passport && view.passport.irs !== null ? (
              <Badge tone="success">оценка {formatScore10(view.passport.irs)}/10</Badge>
            ) : null}
          </div>
          <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>{view.title}</h1>
          {view.tagline ? (
            <span style={{ color: 'var(--u-text-muted)' }}>{view.tagline}</span>
          ) : null}
          <strong
            style={{ fontSize: 'var(--u-text-lg)' }}
            data-investor-raising={view.round.raising}
          >
            {describeRaising({ ...view.round, askCurrency: view.round.askCurrency ?? undefined })}
          </strong>
          {view.round.fundingScope ? (
            <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
              Предмет финансирования: {FUNDING_SCOPE_TITLES[view.round.fundingScope]}
              {view.round.fundingScopeNote ? ` — ${view.round.fundingScopeNote}` : ''}
            </span>
          ) : null}
          {/* Кто что видит — решил сервер; страница только показывает ответ. */}
          <span
            role="status"
            style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}
          >
            {accessText}
          </span>
        </Stack>
      </Card>

      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>О проекте</h2>
          {view.description ? (
            <p style={{ margin: 0, whiteSpace: 'pre-line', lineHeight: 1.6 }}>{view.description}</p>
          ) : (
            <span style={{ color: 'var(--u-text-muted)' }}>
              {view.access.profile === null
                ? 'Описание закрыто.'
                : 'Основатель пока не добавил подробное описание.'}
            </span>
          )}
        </Stack>
      </Card>

      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Анкета</h2>
          {view.access.profile === null ? (
            <EmptyState
              title="Ответы закрыты"
              description="Основатель открыл проект не для этой аудитории или ещё не согласовал показ ответов."
            />
          ) : questionCount === 0 ? (
            <EmptyState
              title="Ответов пока нет"
              description="Основатель ещё не подал профиль через мастер заявки."
            />
          ) : (
            <Stack gap="var(--u-space-3)">
              {view.sections.map((section) => (
                <div key={section.key} data-investor-section={section.key}>
                  <h3 style={{ margin: '0 0 var(--u-space-2)', fontSize: 'var(--u-text-md)' }}>
                    {section.title}
                  </h3>
                  <dl style={{ display: 'grid', gap: 'var(--u-space-2)', margin: 0 }}>
                    {section.questions.map((q) => (
                      <div key={q.key} data-investor-question={q.key}>
                        <dt style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                          {q.label}
                        </dt>
                        <dd style={{ margin: 0, whiteSpace: 'pre-line' }}>
                          {q.type === 'money' && typeof q.value === 'string'
                            ? formatMoney(q.value, 'RUB')
                            : q.display}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
              {view.withheld > 0 ? (
                <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                  Ещё ответов, закрытых для вас: {view.withheld}.
                </span>
              ) : null}
            </Stack>
          )}
        </Stack>
      </Card>

      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Оценка платформы</h2>
          {view.passport ? (
            <>
              <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                Паспорт версии {view.passport.version}, уровень раскрытия{' '}
                {view.passport.disclosureTier}
                {view.passport.publishedAt
                  ? `, опубликован ${new Date(view.passport.publishedAt).toLocaleDateString('ru-RU')}`
                  : ''}
                . Оценка — мнение алгоритма платформы о качестве заявки, не совет о вложении.
              </span>
              {view.passport.irs !== null ? (
                <strong>Итог: {formatScore10(view.passport.irs)}/10</strong>
              ) : null}
              <ul style={{ margin: 0, paddingLeft: 'var(--u-space-5)', lineHeight: 1.6 }}>
                {view.passport.axes.map((score) => (
                  <li key={score.axis}>
                    <strong>{SCORE_AXIS_TITLES[score.axis] ?? score.axis}</strong>:{' '}
                    {formatScore10(score.value)}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <span style={{ color: 'var(--u-text-muted)' }}>
              {view.access.passport === null
                ? 'Оценка закрыта для этой аудитории.'
                : 'Оценка ещё не рассчитана: проект не проходил анализ платформы.'}
            </span>
          )}
        </Stack>
      </Card>

      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Материалы</h2>
          <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
            Документы открываются здесь, внутри платформы: скачивание не предусмотрено.
          </span>

          {view.materials === null ? (
            <EmptyState
              title="Материалы закрыты"
              description="Материалы открываются допущенным инвесторам по отметке основателя."
            />
          ) : null}
          {view.materials !== null && materials.length === 0 ? (
            <EmptyState
              title="Материалов нет"
              description="Основатель не открыл инвесторам ни презентации, ни ссылки на продукт."
            />
          ) : null}

          {links.map((material) => (
            <div key={material.id} style={{ display: 'flex', gap: 'var(--u-space-3)' }}>
              <Badge>{MATERIAL_TYPE_TITLES[material.type] ?? material.type}</Badge>
              <a href={safeHref(material.url)} target="_blank" rel="noreferrer noopener">
                {material.url}
              </a>
            </div>
          ))}

          {files.map((material) => (
            <Stack key={material.id} gap="var(--u-space-2)">
              <div style={{ display: 'flex', gap: 'var(--u-space-3)', alignItems: 'center' }}>
                <Badge>{MATERIAL_TYPE_TITLES[material.type] ?? material.type}</Badge>
                <span style={{ flex: 1 }}>версия {material.version}</span>
                <Button
                  variant="secondary"
                  onClick={() => setOpenFile(openFile === material.id ? null : material.id)}
                >
                  {openFile === material.id ? 'Закрыть' : 'Смотреть'}
                </Button>
              </div>
              {openFile === material.id ? (
                <div style={{ position: 'relative' }}>
                  <iframe
                    title={`Материал: ${MATERIAL_TYPE_TITLES[material.type] ?? material.type}`}
                    src={`${apiBaseUrl}/projects/${projectId}/materials/${material.id}/content#toolbar=0&navpanes=0`}
                    style={{
                      width: '100%',
                      height: '70vh',
                      border: '1px solid var(--u-border)',
                      borderRadius: 'var(--u-radius-md)',
                      background: 'var(--u-surface)',
                      display: 'block',
                    }}
                  />
                  <div
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      pointerEvents: 'none',
                      overflow: 'hidden',
                      borderRadius: 'var(--u-radius-md)',
                      display: 'grid',
                      placeItems: 'center',
                    }}
                  >
                    <span
                      style={{
                        transform: 'rotate(-24deg)',
                        fontSize: 'clamp(1rem, 3vw, 2rem)',
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        color: 'rgba(90, 70, 180, 0.16)',
                        textAlign: 'center',
                        lineHeight: 1.6,
                        whiteSpace: 'pre-line',
                        userSelect: 'none',
                      }}
                    >
                      {watermark}
                    </span>
                  </div>
                </div>
              ) : null}
            </Stack>
          ))}
        </Stack>
      </Card>
    </Stack>
  );
}
