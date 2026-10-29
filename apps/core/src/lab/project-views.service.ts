import { Injectable } from '@nestjs/common';
import {
  projectAudience,
  visibleTo,
  type Audience,
  type AudienceSummary,
  type InvestorView,
  type PreviewAudience,
  type ProjectVisibility,
  type PublicView,
  type ViewMaterial,
  type ViewPreview,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Представления проекта наружу (5.7.2).
 *
 * Собираются из SECURITY DEFINER-проекций, каждая из которых сама спрашивает
 * предикат `lab.project_audience` по своему разрешению: основа (тизер и
 * описание) и материалы по отметке владельца. Сервис не решает, кому что
 * можно, — он раскладывает ответы проекций по блокам. Поэтому Public View и
 * Investor View нельзя собрать шире, чем разрешает БД.
 *
 * С 2.1-W05 в карточке только данные самого проекта: ответы заявки, раунд и
 * паспорт удалены вместе с инвестиционным процессом и анализом ИИ.
 */

type Viewer = { userId: string | null; roles: readonly string[] } | null;

interface BaseRow {
  teaser_audience: Audience;
  profile_audience: Audience | null;
  materials_audience: Audience | null;
  id: string;
  title: string;
  tagline: string | null;
  description: string | null;
  stage: PublicView['stage'];
  taxonomy_id: string | null;
  geo_country: string | null;
  geo_region: string | null;
  listed_at: Date | null;
  visibility: ProjectVisibility;
}

interface MaterialRow {
  audience: Audience;
  id: string;
  type: ViewMaterial['type'];
  version: number;
  url: string | null;
  visibility: ViewMaterial['visibility'];
  created_at: Date;
}

@Injectable()
export class ProjectViewsService {
  constructor(private readonly db: Database) {}

  /** Public View — по сессии зрителя под публичной ролью БД. */
  async publicView(traceId: string, projectId: string, viewer: Viewer): Promise<PublicView> {
    return this.db.asPublicRole(
      traceId,
      async (tx) => this.toPublic(await this.base(tx, projectId)),
      viewer,
    );
  }

  /** Investor View — нужен только доступ к тизеру; блоки по своим разрешениям. */
  async investorView(traceId: string, projectId: string, viewer: Viewer): Promise<InvestorView> {
    return this.db.asPublicRole(
      traceId,
      async (tx) => {
        const base = await this.base(tx, projectId);
        const materials = base.materials_audience ? await this.materials(tx, projectId) : null;
        // Получателю важно понимать, ПОЧЕМУ проект ему открыт: доступ выдан
        // лично владельцем или следует из режима проекта (M093).
        const grantedAt = await this.ownGrantAt(tx, projectId);
        return this.toInvestor(base, materials, grantedAt);
      },
      viewer,
    );
  }

  /**
   * Предпросмотр владельца: что увидит выбранная аудитория (аноним или
   * допущенный инвестор) при текущем режиме проекта.
   */
  async viewPreview(
    ctx: RequestContext,
    projectId: string,
    audience: PreviewAudience,
  ): Promise<ViewPreview> {
    return this.db.readOnly(ctx, async (tx) => {
      const base = await this.base(tx, projectId);
      if (base.profile_audience !== 'private') throw errors.forbidden({ subject: 'view_preview' });

      // Зритель аудитории «вообще»: аноним или инвестор без личного
      // разрешения. Каждый блок — по своему разрешению того же предиката,
      // что решает в БД; личные разрешения в предпросмотр не входят.
      const viewer =
        audience === 'public'
          ? { userId: null, roles: [] }
          : { userId: '00000000-0000-0000-0000-000000000000', roles: ['investor'] };
      const state = { visibility: base.visibility };
      const teaser = projectAudience(state, viewer, 'teaser');
      const profile = projectAudience(state, viewer, 'profile');
      const materialsAudience = projectAudience(state, viewer, 'materials');
      const materials =
        materialsAudience === null
          ? null
          : (await this.materials(tx, projectId)).filter((m) =>
              visibleTo(m.visibility, materialsAudience),
            );
      const view: InvestorView | null =
        teaser === null
          ? null
          : {
              ...this.toPublic(base),
              access: { profile, materials: materialsAudience },
              // Предпросмотр показывает вид аудитории вообще, а не конкретного
              // получателя: пометки «доступ открыт лично вам» здесь нет.
              grant: null,
              description: profile === null ? null : base.description,
              geoRegion: profile === null ? null : base.geo_region,
              materials,
            };
      return { audience, view, audienceSummary: audienceSummary(base.visibility) };
    });
  }

  // ------------------------------------------------------------------ private

  private async base(tx: Tx, projectId: string): Promise<BaseRow> {
    const { rows } = await tx.query<BaseRow>(`SELECT * FROM lab.project_view_base($1)`, [
      projectId,
    ]);
    const row = rows[0];
    if (!row) throw errors.notFound({ subject: 'project' });
    return row;
  }

  private async materials(tx: Tx, projectId: string): Promise<ViewMaterial[]> {
    const { rows } = await tx.query<MaterialRow>(`SELECT * FROM lab.visible_materials($1)`, [
      projectId,
    ]);
    return rows.map((m) => ({
      id: m.id,
      type: m.type,
      version: m.version,
      url: m.url,
      visibility: m.visibility,
      createdAt: m.created_at.toISOString(),
    }));
  }

  /** Дата действующей выдачи текущему пользователю; null — доступ по режиму. */
  private async ownGrantAt(tx: Tx, projectId: string): Promise<Date | null> {
    const { rows } = await tx.query<{ granted_at: Date | null }>(
      'SELECT lab.own_grant_at($1) AS granted_at',
      [projectId],
    );
    return rows[0]?.granted_at ?? null;
  }

  private toPublic(base: BaseRow): PublicView {
    return {
      id: base.id,
      title: base.title,
      tagline: base.tagline,
      stage: base.stage,
      taxonomyId: base.taxonomy_id,
      geoCountry: base.geo_country,
      // Наличие изображения эта выборка не знает: страница спрашивает
      // `/media` отдельно, а не получает адрес несуществующей картинки.
      logoUrl: null,
      listedAt: base.listed_at?.toISOString() ?? null,
    };
  }

  private toInvestor(
    base: BaseRow,
    materials: ViewMaterial[] | null,
    grantedAt: Date | null,
  ): InvestorView {
    return {
      ...this.toPublic(base),
      grant: grantedAt === null ? null : { grantedAt: grantedAt.toISOString() },
      access: { profile: base.profile_audience, materials: base.materials_audience },
      description: base.description,
      geoRegion: base.geo_region,
      materials,
    };
  }
}

/**
 * Кому открыт проект при данном режиме. Инвесторы допускаются лично
 * (выбранные получатели) или никак: допуск по роли был за подпиской, а
 * подписки удалены (2.1-W05) — открывать его без решения нельзя.
 */
function audienceSummary(mode: ProjectVisibility): AudienceSummary {
  const investors: AudienceSummary['investors'] =
    mode === 'selected_investors' ? 'selected' : 'never';
  return { mode, anonymous: mode === 'public', investors };
}
