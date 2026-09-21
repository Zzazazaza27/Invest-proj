import { useState } from 'react';
import { ContextualImage } from './test-context';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Stack,
  describeRaising,
  formatMoney,
  formatScore10,
} from '@unicorn/ui';
import type { InvestorView, PublicView } from '@unicorn/contracts';

/**
 * Представление проекта — ОДНО на все три поверхности (этап 7.3).
 *
 * Раньше их было три: страница витрины, карточка в кабинете инвестора и
 * предпросмотр владельца. Данные у всех трёх приходили из одних серверных
 * проекций, а разметка расходилась по одной за раз — даже подписи стадий
 * успели разойтись («Идея» на витрине, «идея» в кабинете). Хуже подписей то,
 * что владелец в предпросмотре видел не карточку, а одну строку «показано N,
 * скрыто M»: проверить глазами, что увидит инвестор, было нечем.
 *
 * **Компонент не решает, кому что видно.** Это делает сервер: предикат
 * `lab.project_audience` собирает проекцию по каждому разрешению отдельно, и
 * сюда приходит уже готовый состав. Здесь нет ни одной проверки прав — есть
 * только «блок пришёл» и «блока нет». Второй модели раскрытия в браузере не
 * заводится.
 *
 * **Различия аудиторий сохранены, а не стёрты.** Public View и Investor View —
 * РАЗНЫЕ проекции с разным составом, и компонент принимает их как разные
 * варианты, а не догадывается по наличию полей. Описание, материалы, оценка
 * платформы и состав раунда существуют только в инвесторской проекции;
 * анониму их не показывает не компонент, а сервер, который их не присылает.
 */

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
 * чужого кода у смотрящего, поэтому схема проверяется там, где происходит
 * опасное действие, а не там, где ссылка появилась.
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

function pluralAnswers(count: number): string {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return 'ответов';
  switch (count % 10) {
    case 1:
      return 'ответ';
    case 2:
    case 3:
    case 4:
      return 'ответа';
    default:
      return 'ответов';
  }
}

/**
 * Какая проекция пришла.
 *
 * Вариант называет САМ вызывающий: он знает, какой маршрут спрашивал. Гадать
 * по наличию полей нельзя — это и было бы второй моделью раскрытия, только
 * спрятанной в условиях.
 */
export type ProjectCardSource =
  { kind: 'public'; view: PublicView } | { kind: 'investor'; view: InvestorView };

export interface ProjectCardMedia {
  /** Готовый адрес изображения или `null`, если его нет. */
  logoUrl?: string | null;
  coverUrl?: string | null;
}

export interface ProjectCardProps {
  source: ProjectCardSource;
  media?: ProjectCardMedia;
  /**
   * Адрес содержимого материала. Без него список материалов показывается, но
   * читалка не открывается — так предпросмотр владельца показывает СОСТАВ
   * того, что увидит аудитория, не превращаясь в читалку документов.
   */
  materialContentUrl?: (materialId: string) => string;
  /** Подпись водяного знака в читалке: кто смотрит и когда. */
  viewerLabel?: string | null;
  /** Кнопка возврата — своя в каждом приложении. */
  back?: React.ReactNode;
  /** Атрибут-якорь для браузерных проверок конкретной поверхности. */
  surface?: string;
}

/**
 * Строка «Доступ»: разрешение смотреть и фактическое наличие данных — разные
 * вещи. Прежнее перечисление разрешений читалось как обещание: «оценка
 * платформы» в списке выглядела готовой оценкой, хотя паспорт мог быть не
 * рассчитан, а материалы — не добавлены (замечание ручного прохода 5.7).
 * Поэтому каждый открытый блок называется вместе с его состоянием, а сам
 * список по-прежнему строится по ответу сервера, а не по догадке страницы.
 */
function describeAccess(view: InvestorView, questionCount: number): string {
  if (view.access.profile === null) {
    return 'Доступ: только тизер — ответы анкеты, материалы и оценка закрыты режимом проекта или вашим допуском.';
  }
  const parts = [questionCount > 0 ? 'профиль' : 'профиль (ответов пока нет)'];
  if (view.access.round !== null) {
    parts.push(view.round.raising === 'none' ? 'раунд (не открыт)' : 'раунд');
  }
  if (view.access.materials !== null) {
    parts.push((view.materials?.length ?? 0) > 0 ? 'материалы' : 'материалы (не добавлены)');
  }
  if (view.access.passport !== null) {
    parts.push(view.passport ? 'оценка платформы' : 'оценка платформы (ещё не рассчитана)');
  }
  return `Доступ открыт: ${parts.join(', ')}.`;
}

export function ProjectCard({
  source,
  media,
  materialContentUrl,
  viewerLabel,
  back,
  surface,
}: ProjectCardProps): React.ReactElement {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const view = source.view;
  const investor = source.kind === 'investor' ? source.view : null;

  const sections = view.sections.filter((section) => section.questions.length > 0);
  const questionCount = view.sections.reduce((n, s) => n + s.questions.length, 0);
  const materials = investor?.materials ?? [];
  const links = materials.filter((m) => m.url !== null);
  const files = materials.filter((m) => m.url === null);
  const watermark = `${viewerLabel ?? 'Пятый элемент'}\n${new Date().toLocaleDateString('ru-RU')} · Пятый элемент`;

  return (
    <Stack gap="var(--u-space-5)" data-project-card={surface ?? source.kind}>
      {back}

      <Card>
        <Stack>
          {media?.coverUrl ? (
            <ContextualImage
              data-project-cover
              src={media.coverUrl}
              alt=""
              width={1600}
              height={900}
              style={{
                width: '100%',
                height: 'auto',
                borderRadius: 'var(--u-radius-lg)',
                display: 'block',
              }}
            />
          ) : null}
          {media?.logoUrl ? (
            <ContextualImage
              data-project-logo
              src={media.logoUrl}
              alt=""
              width={96}
              height={96}
              style={{ width: 96, height: 96, borderRadius: 'var(--u-radius-md)' }}
            />
          ) : null}
          <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
            <Badge tone="accent">{STAGE_TITLES[view.stage] ?? view.stage}</Badge>
            {view.geoCountry ? <Badge>{view.geoCountry}</Badge> : null}
            {investor?.passport && investor.passport.irs !== null ? (
              <Badge tone="success">оценка {formatScore10(investor.passport.irs)}/10</Badge>
            ) : null}
          </div>
          <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>{view.title}</h1>
          {view.tagline ? (
            <span style={{ color: 'var(--u-text-muted)' }}>{view.tagline}</span>
          ) : null}
          {/*
            Состояние привлечения берётся из инвесторской проекции раунда, если
            она пришла, иначе из тизера. Обе — ответ сервера; выбирать «что
            показать понаряднее» тут нечего.
          */}
          <strong
            style={{ fontSize: 'var(--u-text-lg)' }}
            data-project-raising={investor ? investor.round.raising : view.raising}
          >
            {investor
              ? describeRaising({
                  ...investor.round,
                  askCurrency: investor.round.askCurrency ?? undefined,
                })
              : describeRaising(view)}
          </strong>
          {investor?.round.fundingScope ? (
            <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
              Предмет финансирования: {FUNDING_SCOPE_TITLES[investor.round.fundingScope]}
              {investor.round.fundingScopeNote ? ` — ${investor.round.fundingScopeNote}` : ''}
            </span>
          ) : null}
          {/*
            Выбранному получателю сказано, что доступ открыл владелец: иначе
            непонятно, почему закрытый проект вообще виден. Причину выдачи
            владелец пишет для себя — её здесь нет.
          */}
          {investor?.grant ? (
            <span
              data-project-grant
              style={{ fontSize: 'var(--u-text-sm)', color: 'var(--u-success)' }}
            >
              Доступ открыл владелец проекта{' '}
              {new Date(investor.grant.grantedAt).toLocaleDateString('ru-RU')} — ниже перечислено,
              что именно он открыл.
            </span>
          ) : null}
          {investor ? (
            <span
              role="status"
              style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}
            >
              {describeAccess(investor, questionCount)}
            </span>
          ) : null}
        </Stack>
      </Card>

      {/* Описание есть только в инвесторской проекции: анониму сервер его не отдаёт. */}
      {investor ? (
        <Card>
          <Stack>
            <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>О проекте</h2>
            {investor.description ? (
              <p style={{ margin: 0, whiteSpace: 'pre-line', lineHeight: 1.6 }}>
                {investor.description}
              </p>
            ) : (
              <span style={{ color: 'var(--u-text-muted)' }}>
                {investor.access.profile === null
                  ? 'Описание закрыто.'
                  : 'Основатель пока не добавил подробное описание.'}
              </span>
            )}
          </Stack>
        </Card>
      ) : null}

      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Анкета</h2>
          {view.profileAudience === null ? (
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
              {sections.map((section) => (
                <div key={section.key} data-project-section={section.key}>
                  <h3 style={{ margin: '0 0 var(--u-space-2)', fontSize: 'var(--u-text-md)' }}>
                    {section.title}
                  </h3>
                  <dl style={{ display: 'grid', gap: 'var(--u-space-2)', margin: 0 }}>
                    {section.questions.map((q) => (
                      <div key={q.key} data-project-answer={q.key}>
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
            </Stack>
          )}
          {/* Скрытое названо числом: «показано не всё» — часть правды о заявке. */}
          <span
            data-project-withheld={view.withheld}
            style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}
          >
            {view.withheld > 0
              ? `Ещё ${view.withheld} ${pluralAnswers(view.withheld)} автор открыл не для всех.`
              : 'Автор открыл все заполненные ответы.'}
          </span>
        </Stack>
      </Card>

      {investor ? (
        <Card>
          <Stack>
            <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Оценка платформы</h2>
            {investor.passport ? (
              <>
                <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                  Паспорт версии {investor.passport.version}, уровень раскрытия{' '}
                  {investor.passport.disclosureTier}
                  {investor.passport.publishedAt
                    ? `, опубликован ${new Date(investor.passport.publishedAt).toLocaleDateString('ru-RU')}`
                    : ''}
                  . Оценка — мнение алгоритма платформы о качестве заявки, не совет о вложении.
                </span>
                {investor.passport.irs !== null ? (
                  <strong>Итог: {formatScore10(investor.passport.irs)}/10</strong>
                ) : null}
                <ul style={{ margin: 0, paddingLeft: 'var(--u-space-5)', lineHeight: 1.6 }}>
                  {investor.passport.axes.map((score) => (
                    <li key={score.axis}>
                      <strong>{SCORE_AXIS_TITLES[score.axis] ?? score.axis}</strong>:{' '}
                      {formatScore10(score.value)}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <span style={{ color: 'var(--u-text-muted)' }}>
                {investor.access.passport === null
                  ? 'Оценка закрыта для этой аудитории.'
                  : 'Оценка ещё не рассчитана: проект не проходил анализ платформы.'}
              </span>
            )}
          </Stack>
        </Card>
      ) : null}

      {investor ? (
        <Card>
          <Stack>
            <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Материалы</h2>
            <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
              {materialContentUrl
                ? 'Документы открываются здесь, внутри платформы: скачивание не предусмотрено.'
                : 'Здесь показан состав материалов. Сами документы открываются в кабинете того, кому они открыты.'}
            </span>

            {investor.materials === null ? (
              <EmptyState
                title="Материалы закрыты"
                description="Материалы открываются допущенным инвесторам по отметке основателя."
              />
            ) : null}
            {investor.materials !== null && materials.length === 0 ? (
              <EmptyState
                title="Материалов нет"
                description="Основатель не открыл инвесторам ни презентации, ни ссылки на продукт."
              />
            ) : null}

            {links.map((material) => (
              <div
                key={material.id}
                data-project-material={material.id}
                style={{ display: 'flex', gap: 'var(--u-space-3)' }}
              >
                <Badge>{MATERIAL_TYPE_TITLES[material.type] ?? material.type}</Badge>
                {materialContentUrl ? (
                  <a href={safeHref(material.url)} target="_blank" rel="noreferrer noopener">
                    {material.url}
                  </a>
                ) : (
                  <span style={{ color: 'var(--u-text-muted)' }}>ссылка</span>
                )}
              </div>
            ))}

            {files.map((material) => (
              <Stack key={material.id} gap="var(--u-space-2)" data-project-material={material.id}>
                <div style={{ display: 'flex', gap: 'var(--u-space-3)', alignItems: 'center' }}>
                  <Badge>{MATERIAL_TYPE_TITLES[material.type] ?? material.type}</Badge>
                  <span style={{ flex: 1 }}>версия {material.version}</span>
                  {materialContentUrl ? (
                    <Button
                      variant="secondary"
                      onClick={() => setOpenFile(openFile === material.id ? null : material.id)}
                    >
                      {openFile === material.id ? 'Закрыть' : 'Смотреть'}
                    </Button>
                  ) : null}
                </div>
                {materialContentUrl && openFile === material.id ? (
                  <div style={{ position: 'relative' }}>
                    <iframe
                      title={`Материал: ${MATERIAL_TYPE_TITLES[material.type] ?? material.type}`}
                      src={materialContentUrl(material.id)}
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
      ) : null}
    </Stack>
  );
}
