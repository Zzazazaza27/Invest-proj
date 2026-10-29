import { useState } from 'react';
import { ContextualImage } from './test-context';
import { Badge, Button, Card, EmptyState, Stack } from '@unicorn/ui';
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
 * варианты, а не догадывается по наличию полей. Описание и материалы
 * существуют только в инвесторской проекции; анониму их не показывает не
 * компонент, а сервер, который их не присылает.
 *
 * С 2.1-W05 карточка собирается только из данных самого проекта: ответы
 * анкеты заявки, раунд и оценка платформы удалены вместе с инвестиционным
 * процессом и анализом ИИ.
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
 * вещи. Поэтому каждый открытый блок называется вместе с его состоянием, а
 * сам список строится по ответу сервера, а не по догадке страницы.
 */
function describeAccess(view: InvestorView): string {
  if (view.access.profile === null) {
    return 'Доступ: только тизер — описание и материалы закрыты режимом проекта или вашим допуском.';
  }
  const parts = [view.description ? 'описание' : 'описание (пока не добавлено)'];
  if (view.access.materials !== null) {
    parts.push((view.materials?.length ?? 0) > 0 ? 'материалы' : 'материалы (не добавлены)');
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
            {investor?.geoRegion ? <Badge>{investor.geoRegion}</Badge> : null}
          </div>
          <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>{view.title}</h1>
          {view.tagline ? (
            <span style={{ color: 'var(--u-text-muted)' }}>{view.tagline}</span>
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
              {describeAccess(investor)}
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
                description="Материалы открывает владелец проекта — личным разрешением и отметкой материала."
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
