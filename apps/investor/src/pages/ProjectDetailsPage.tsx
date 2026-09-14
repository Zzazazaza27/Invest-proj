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
} from '@unicorn/ui';
import type { InvestmentPassport, ProjectFull, ProjectMaterial } from '@unicorn/contracts';
import { ScoreProvenance, publishedScore10 } from '@unicorn/cabinet';
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

/**
 * Ссылка материала с проверкой схемы.
 *
 * Сервер принимает только `https://` (AddProductLinkSchema), но интерфейс
 * рендерит то, что лежит в базе, — а туда строка могла попасть до появления
 * этой проверки, сидом или через служебный путь. `javascript:` в `href` — это
 * выполнение чужого кода в кабинете смотрящего, поэтому схема проверяется и
 * здесь: защита стоит там, где происходит опасное действие.
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
 * Карточка проекта глазами инвестора.
 *
 * Отдельная страница, а не раскрывающийся блок в списке: описание проекта —
 * это несколько экранов текста, документы и оценка. Раскрытие такого объёма
 * прямо в сетке каталога сдвигало соседние карточки и заставляло искать место,
 * где ты только что был.
 *
 * Документы показываются ВНУТРИ платформы: файл приходит с адреса ядра, с
 * `Content-Disposition: inline` и без кнопки «скачать». Прямых ссылок на
 * хранилище страница не получает — они пережили бы и подписку, и снятие
 * листинга. Полная защита от копирования на клиенте невозможна (у того, кто
 * видит документ, он уже есть), и обещать её было бы враньём — но лёгкого пути
 * «сохранить и переслать» здесь нет, а доступ проверяется на каждом запросе.
 *
 * Доступ к материалам открывает активная подписка. Проверяет её СЕРВЕР: экран
 * не прячет раздел, а показывает ответ — включая объяснение, что нужна
 * подписка.
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
    | { status: 'ready'; project: ProjectFull; passport: InvestmentPassport | null }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
  const [materials, setMaterials] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: ProjectMaterial[] }
    | { status: 'denied'; message: string }
  >({ status: 'loading' });
  const [openFile, setOpenFile] = useState<string | null>(null);
  /**
   * Подпись водяного знака: кто и когда смотрит.
   *
   * Имя берётся из текущей сессии — тем же запросом, что рисует шапку кабинета.
   * Отказ здесь не должен закрывать документ: если имя не пришло, знак остаётся
   * с датой и адресом платформы.
   */
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
      const project = await api.projects.get(projectId);
      const passport = await api.projects.passport(projectId).catch(() => null);
      setState({ status: 'ready', project, passport });
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : 'Сервис недоступен',
        traceId: error instanceof ApiError ? error.traceId : null,
      });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setMaterials({ status: 'loading' });
    api.projects
      .materials(projectId)
      .then((items) => setMaterials({ status: 'ready', items }))
      .catch((error: unknown) =>
        setMaterials({
          status: 'denied',
          message:
            error instanceof ApiError
              ? (error.problem?.detail ?? 'Материалы открываются активной подпиской')
              : 'Материалы открываются активной подпиской',
        }),
      );
  }, [projectId]);

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

  const { project, passport } = state;
  const watermark = `${viewer ?? 'Пятый элемент'}
${new Date().toLocaleDateString('ru-RU')} · Пятый элемент`;
  const files = materials.status === 'ready' ? materials.items.filter((m) => m.url === null) : [];
  const links = materials.status === 'ready' ? materials.items.filter((m) => m.url !== null) : [];

  return (
    <Stack gap="var(--u-space-5)">
      <Button variant="secondary" onClick={onBack} style={{ justifySelf: 'start' }}>
        ← К каталогу
      </Button>

      <Card>
        <Stack>
          <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
            <Badge tone="accent">{STAGE_TITLES[project.stage] ?? project.stage}</Badge>
            {project.geoCountry ? <Badge>{project.geoCountry}</Badge> : null}
            {passport ? (
              <Badge tone="success">
                оценка {publishedScore10(passport) ?? formatScore10(passport.irs?.value)}/10
              </Badge>
            ) : null}
          </div>
          <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>{project.title}</h1>
          {project.tagline ? (
            <span style={{ color: 'var(--u-text-muted)' }}>{project.tagline}</span>
          ) : null}
          <strong style={{ fontSize: 'var(--u-text-lg)' }}>
            {formatMoney(project.investmentAsk, project.askCurrency)}
          </strong>
        </Stack>
      </Card>

      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>О проекте</h2>
          {project.description ? (
            <p style={{ margin: 0, whiteSpace: 'pre-line', lineHeight: 1.6 }}>
              {project.description}
            </p>
          ) : (
            <span style={{ color: 'var(--u-text-muted)' }}>
              Основатель пока не добавил подробное описание.
            </span>
          )}
        </Stack>
      </Card>

      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Оценка платформы</h2>
          {passport ? (
            <>
              {/*
                Число не показывается без блока происхождения: «8/10» рядом с
                проектом читается как оценка привлекательности вложения, что бы
                ни лежало в служебных полях (ADR-008 §4).
              */}
              <ScoreProvenance passport={passport} modelVersion={passport.modelVersion ?? null} />
              <ul style={{ margin: 0, paddingLeft: 'var(--u-space-5)', lineHeight: 1.6 }}>
                {passport.scores.map((score) => (
                  <li key={score.axis}>
                    <strong>{SCORE_AXIS_TITLES[score.axis] ?? score.axis}</strong>:{' '}
                    {formatScore10(score.value)}{' '}
                    <span style={{ color: 'var(--u-text-muted)' }}>
                      (интервал {formatScore10(score.confidenceLow)}–
                      {formatScore10(score.confidenceHigh)})
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <span style={{ color: 'var(--u-text-muted)' }}>
              Оценка ещё не рассчитана: проект не проходил анализ платформы.
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

          {materials.status === 'loading' ? <LoadingState label="Загружаем материалы" /> : null}
          {materials.status === 'denied' ? (
            <EmptyState title="Материалы закрыты" description={materials.message} />
          ) : null}
          {materials.status === 'ready' && materials.items.length === 0 ? (
            <EmptyState
              title="Материалов нет"
              description="Основатель не приложил ни презентации, ни ссылки на продукт."
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
                /*
                  Просмотрщик — встроенный в браузер: файл приходит с адреса
                  ядра и открывается на месте. Высота фиксирована, чтобы
                  открытие документа не растягивало страницу рывком.

                  Поверх лежит водяной знак с именем смотрящего. Скопировать
                  документ он не мешает и не должен: у того, кто видит файл, он
                  уже есть. Смысл в другом — снимок экрана или пересланная
                  копия несут имя того, у кого они появились. Это единственная
                  работающая мера против «переслал знакомому»: не запрет, а
                  ответственность.
                */
                <div style={{ position: 'relative' }}>
                  <iframe
                    title={`Материал: ${MATERIAL_TYPE_TITLES[material.type] ?? material.type}`}
                    /*
                      `#toolbar=0` убирает панель встроенного просмотрщика — в
                      ней Chrome рисует свои кнопки «скачать» и «печать», и они
                      прямо противоречат обещанию «смотреть здесь».
                    */
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
                      // Знак не перехватывает мышь: документ остаётся
                      // прокручиваемым и выделяемым.
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
