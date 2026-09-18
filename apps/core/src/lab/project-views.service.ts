import { Injectable } from '@nestjs/common';
import {
  buildApplicationPreview,
  projectAudience,
  visibleTo,
  type ApplicationPreview,
  type ApplicationPreviewQuestion,
  type Audience,
  type AudienceSummary,
  type InvestorView,
  type PreviewAudience,
  type ProjectVisibility,
  type PublicView,
  type RoundOpenPreview,
  type RoundProjection,
  type ViewMaterial,
  type ViewPassport,
  type ViewPreview,
  resolveText,
  sortedQuestions,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { parseStoredConfig } from './application-forms.service';
import { disclosureDigest, roundDigest } from './disclosure-digest';
import { ROUND_COLUMNS, mapRound, type RoundRow } from './funding-rounds.service';

/**
 * Отпечаток содержимого, которое расширяет «Применить новые условия»:
 * согласованный снимок, режим проекта и незавершённый раунд. Один и тот же
 * расчёт у предпросмотра владельца и у самого действия (5.7.4).
 */
export async function currentDisclosureDigest(tx: Tx, projectId: string): Promise<string> {
  const { rows } = await tx.query<{ disclosed_version_id: string | null; visibility: string }>(
    `SELECT disclosed_version_id, visibility FROM lab.projects WHERE id = $1`,
    [projectId],
  );
  const project = rows[0];
  if (!project) throw errors.notFound({ subject: 'project' });
  const round = await tx.query<RoundRow>(
    `SELECT ${ROUND_COLUMNS} FROM lab.funding_rounds
      WHERE project_id = $1 AND status IN ('open', 'paused') LIMIT 1`,
    [projectId],
  );
  return disclosureDigest({
    disclosedVersionId: project.disclosed_version_id,
    visibility: project.visibility,
    round: round.rows[0] ? mapRound(round.rows[0]) : null,
  });
}

/**
 * Представления проекта наружу (5.7.2, план `заявка-04` §3.5).
 *
 * Всё собирается из четырёх SECURITY DEFINER-проекций M089, каждая из
 * которых сама спрашивает предикат `lab.project_audience` по своему
 * разрешению: основа (тизер, описание, раунд), согласованный снимок с
 * эффективной видимостью, материалы по отметке владельца, паспорт явным
 * составом. Сервис не решает, кому что можно, — он только раскладывает
 * ответы проекций по блокам и фильтрует поля по аудитории, которую проекция
 * вернула. Поэтому Public View и Investor View нельзя собрать шире, чем
 * разрешает БД, какой бы ролью ни шёл запрос.
 */

type Viewer = { userId: string | null; roles: readonly string[] } | null;

interface BaseRow {
  teaser_audience: Audience;
  profile_audience: Audience | null;
  round_audience: Audience | null;
  materials_audience: Audience | null;
  passport_audience: Audience | null;
  id: string;
  title: string;
  tagline: string | null;
  description: string | null;
  stage: ApplicationPreview['stage'];
  taxonomy_id: string | null;
  geo_country: string | null;
  geo_region: string | null;
  listed_at: Date | null;
  visibility: ProjectVisibility;
  raising: RoundProjection['raising'];
  round_target: string | null;
  round_currency: string | null;
  funding_scope: RoundProjection['fundingScope'];
  funding_scope_note: string | null;
}

interface ProfileRow {
  audience: Audience;
  version_id: string;
  application_id: string;
  schema_version: number;
  consent_version: number;
  active_version: number | null;
  stage: ApplicationPreview['stage'];
  snapshot: {
    core: ApplicationPreview['core'];
    answers: Record<string, unknown>;
    evidence: Record<string, string[] | undefined>;
  };
  config: unknown;
  effective_visibility: Record<string, Audience>;
  disclosed_at: Date | null;
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

interface PassportRow {
  audience: Audience;
  version: number;
  disclosure_tier: ViewPassport['disclosureTier'];
  irs: string | null;
  axes: { axis: ViewPassport['axes'][number]['axis']; value: string }[];
  published_at: Date | null;
}

const ROUND_KEYS = [
  'raising_status',
  'investment_ask',
  'funding_scope',
  'funding_scope_note',
] as const;
const ROUND_LABELS: Record<(typeof ROUND_KEYS)[number], string> = {
  raising_status: 'Состояние привлечения',
  investment_ask: 'Сумма и валюта раунда',
  funding_scope: 'Предмет финансирования',
  funding_scope_note: 'Пояснение направления',
};

/** Аудитория для фильтра полей: полный доступ считается как инвестор (наружу выше не бывает). */
function externalAudience(audience: Audience): PreviewAudience {
  return audience === 'public' ? 'public' : 'investors';
}

function roundOf(row: BaseRow): RoundProjection {
  return {
    raising: row.raising,
    investmentAsk: row.round_target,
    askCurrency: row.round_currency?.trim() ?? null,
    fundingScope: row.funding_scope,
    fundingScopeNote: row.funding_scope_note,
  };
}

@Injectable()
export class ProjectViewsService {
  constructor(private readonly db: Database) {}

  /** Public View — по сессии зрителя под публичной ролью БД. */
  async publicView(
    traceId: string,
    projectId: string,
    viewer: Viewer,
    locale = 'ru-RU',
  ): Promise<PublicView> {
    return this.db.asPublicRole(
      traceId,
      async (tx) => {
        const base = await this.base(tx, projectId);
        const profile = await this.profile(tx, base, locale, null);
        return this.toPublic(base, profile);
      },
      viewer,
    );
  }

  /** Investor View — нужен только доступ к тизеру; блоки по своим разрешениям. */
  async investorView(
    traceId: string,
    projectId: string,
    viewer: Viewer,
    locale = 'ru-RU',
  ): Promise<InvestorView> {
    return this.db.asPublicRole(
      traceId,
      async (tx) => {
        const base = await this.base(tx, projectId);
        const profile = await this.profile(tx, base, locale, null);
        const materials = base.materials_audience
          ? await this.materials(tx, projectId, null)
          : null;
        const passport = base.passport_audience ? await this.passport(tx, projectId) : null;
        return this.toInvestor(base, profile, materials, passport);
      },
      viewer,
    );
  }

  /**
   * Предпросмотр владельца: что увидит выбранная аудитория (аноним или
   * допущенный инвестор) при текущем режиме, согласии и условиях; что станет
   * видно после применения активной версии; конфликты «ответ виден,
   * подтверждение закрыто».
   */
  async viewPreview(
    ctx: RequestContext,
    projectId: string,
    audience: PreviewAudience,
    locale = 'ru-RU',
  ): Promise<ViewPreview> {
    return this.db.readOnly(ctx, async (tx) => {
      const base = await this.base(tx, projectId);
      if (base.profile_audience !== 'private') throw errors.forbidden({ subject: 'view_preview' });

      const summary = await this.audienceSummary(tx, base.visibility);
      const simulated = projectAudience(
        { visibility: base.visibility },
        audience === 'public'
          ? { userId: null, roles: [] }
          : { userId: ctx.userId, roles: ['investor'], investorGate: true },
        'teaser',
      );

      const profile = await this.profile(tx, base, locale, audience);
      const round = await this.roundAs(tx, projectId, audience);
      const allMaterials = await this.materials(tx, projectId, null);
      const materialsAs = (allMaterials ?? []).filter((m) => visibleTo(m.visibility, audience));
      const passport = audience === 'investors' ? await this.passport(tx, projectId) : null;

      const access = {
        profile: profile ? audience : null,
        round: audience,
        materials: audience === 'investors' ? ('investors' as const) : null,
        passport: passport ? ('investors' as const) : null,
      };
      const view: InvestorView | null =
        simulated === null
          ? null
          : {
              ...this.toPublic(base, profile),
              profileAudience: profile ? audience : null,
              access,
              description: base.description,
              geoRegion: base.geo_region,
              round,
              materials: audience === 'investors' ? materialsAs : null,
              passport: passport && passport.disclosureTier !== 'dataroom' ? passport : null,
            };

      const consent = await this.consent(tx, projectId);
      const pending = await this.pending(tx, profile, audience, consent.roundDisclosureVersion);
      const conflicts = profile
        ? evidenceConflicts(profile.sections, allMaterials ?? [], audience)
        : [];

      return {
        audience,
        view,
        audienceSummary: summary,
        consent,
        pending,
        evidenceConflicts: conflicts,
        contentDigest: await currentDisclosureDigest(tx, projectId),
      };
    });
  }

  /** Предпросмотр перед открытием раунда: проекция по активной версии для обеих аудиторий. */
  async roundOpenPreview(ctx: RequestContext, roundId: string): Promise<RoundOpenPreview> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<RoundRow>(
        `SELECT ${ROUND_COLUMNS} FROM lab.funding_rounds WHERE id = $1`,
        [roundId],
      );
      if (!rows[0]) throw errors.notFound({ subject: 'funding_round' });
      const mapped = mapRound(rows[0]);
      const { rows: projectRows } = await tx.query<{
        visibility: ProjectVisibility;
        disclosed_version_id: string | null;
      }>(`SELECT visibility, disclosed_version_id FROM lab.projects WHERE id = $1`, [
        mapped.projectId,
      ]);
      const round = {
        status: mapped.status,
        target: mapped.target,
        currency: mapped.currency,
        funding_scope: mapped.fundingScope,
        funding_scope_note: mapped.fundingScopeNote,
        visibility: projectRows[0]?.visibility ?? 'private',
        disclosed_version_id: projectRows[0]?.disclosed_version_id ?? null,
      };

      const active = await tx.query<{ version: number | null; vis: Record<string, Audience> }>(
        `SELECT (SELECT version FROM lab.application_form_versions WHERE is_active LIMIT 1) AS version,
                (SELECT jsonb_object_agg(k, lab.field_visibility(k)) FROM unnest($1::text[]) k) AS vis`,
        [[...ROUND_KEYS]],
      );
      const activeVersion = active.rows[0]?.version ?? 0;
      const vis = active.rows[0]?.vis ?? {};
      const projectionFor = (audience: PreviewAudience): RoundProjection => {
        const ok = (key: (typeof ROUND_KEYS)[number]): boolean =>
          visibleTo(vis[key] ?? 'private', audience);
        const statusOk = ok('raising_status');
        // Предпросмотр показывает состояние ПОСЛЕ открытия: для черновика это
        // «раунд открыт», а не текущее «приостановлено» (проверено вручную
        // 2026-09-19: черновик показывался как «не привлекает»).
        const status: RoundProjection['raising'] = round.status === 'paused' ? 'paused' : 'open';
        return {
          raising: statusOk ? status : 'undisclosed',
          investmentAsk: statusOk && ok('investment_ask') ? round.target : null,
          askCurrency: statusOk && ok('investment_ask') ? (round.currency?.trim() ?? null) : null,
          fundingScope: statusOk && ok('funding_scope') ? round.funding_scope : null,
          fundingScopeNote:
            statusOk && ok('funding_scope') && ok('funding_scope_note')
              ? round.funding_scope_note
              : null,
        };
      };
      const warnings: RoundOpenPreview['warnings'] = [];
      if (round.visibility === 'private') warnings.push('private_project');
      if (!round.disclosed_version_id) warnings.push('no_profile_consent');
      return {
        roundId,
        activeFormVersion: activeVersion,
        public: projectionFor('public'),
        investors: projectionFor('investors'),
        audienceSummary: await this.audienceSummary(tx, round.visibility),
        warnings,
        // Тот же отпечаток, что сверяет открытие: параметры раунда на момент показа.
        contentDigest: roundDigest(mapped),
      };
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

  /**
   * Ответы согласованного снимка для аудитории. `as` — симуляция для
   * предпросмотра владельца; без него — аудитория зрителя из проекции.
   */
  private async profile(
    tx: Tx,
    base: BaseRow,
    locale: string,
    as: PreviewAudience | null,
  ): Promise<(ApplicationPreview & { consentVersion: number; disclosedAt: Date | null }) | null> {
    if (!base.profile_audience) return null;
    const { rows } = await tx.query<ProfileRow>(`SELECT * FROM lab.disclosed_profile($1)`, [
      base.id,
    ]);
    const row = rows[0];
    if (!row) return null;
    const form = parseStoredConfig(row.config, row.schema_version);
    const preview = buildApplicationPreview(
      form,
      {
        schemaVersion: row.schema_version,
        stage: row.stage,
        locale,
        audience: as ?? externalAudience(row.audience),
        effectiveVisibility: row.effective_visibility,
      },
      {
        core: row.snapshot.core,
        answers: row.snapshot.answers ?? {},
        evidence: row.snapshot.evidence ?? {},
        project: {
          title: base.title,
          tagline: base.tagline,
          description: base.description,
          taxonomyId: base.taxonomy_id,
          geoCountry: base.geo_country,
          geoRegion: base.geo_region,
        },
        round: roundOf(base),
      },
    );
    return { ...preview, consentVersion: row.consent_version, disclosedAt: row.disclosed_at };
  }

  private async materials(
    tx: Tx,
    projectId: string,
    as: PreviewAudience | null,
  ): Promise<ViewMaterial[] | null> {
    const { rows } = await tx.query<MaterialRow>(`SELECT * FROM lab.visible_materials($1)`, [
      projectId,
    ]);
    return rows
      .filter((m) => (as ? visibleTo(m.visibility, as) : true))
      .map((m) => ({
        id: m.id,
        type: m.type,
        version: m.version,
        url: m.url,
        visibility: m.visibility,
        createdAt: m.created_at.toISOString(),
      }));
  }

  private async passport(tx: Tx, projectId: string): Promise<ViewPassport | null> {
    const { rows } = await tx.query<PassportRow>(`SELECT * FROM lab.visible_passport($1)`, [
      projectId,
    ]);
    const row = rows[0];
    if (!row) return null;
    return {
      version: row.version,
      disclosureTier: row.disclosure_tier,
      irs: row.irs === null ? null : Number(row.irs),
      axes: row.axes.map((a) => ({ axis: a.axis, value: Number(a.value) })),
      publishedAt: row.published_at?.toISOString() ?? null,
    };
  }

  private async roundAs(tx: Tx, projectId: string, audience: PreviewAudience) {
    const { rows } = await tx.query<{
      raising: RoundProjection['raising'];
      target: string | null;
      currency: string | null;
      funding_scope: RoundProjection['fundingScope'];
      funding_scope_note: string | null;
    }>(`SELECT * FROM lab.round_view_as($1, $2)`, [projectId, audience]);
    const r = rows[0];
    return {
      raising: r?.raising ?? 'undisclosed',
      investmentAsk: r?.target ?? null,
      askCurrency: r?.currency?.trim() ?? null,
      fundingScope: r?.funding_scope ?? null,
      fundingScopeNote: r?.funding_scope_note ?? null,
    } satisfies RoundProjection;
  }

  private async audienceSummary(tx: Tx, mode: ProjectVisibility): Promise<AudienceSummary> {
    const { rows } = await tx.query<{ required: boolean }>(
      `SELECT lab.investor_access_requires_subscription() AS required`,
    );
    const subscriptionRequired = rows[0]?.required ?? true;
    const investors: AudienceSummary['investors'] =
      mode === 'private'
        ? 'never'
        : mode === 'selected_investors'
          ? 'selected'
          : subscriptionRequired
            ? 'subscribed'
            : 'registered';
    return { mode, anonymous: mode === 'public', investors, subscriptionRequired };
  }

  private async consent(tx: Tx, projectId: string): Promise<ViewPreview['consent']> {
    const { rows } = await tx.query<{
      form_version: number | null;
      active_version: number | null;
      round_id: string | null;
      round_version: number | null;
    }>(
      `SELECT p.disclosure_form_version AS form_version,
              (SELECT version FROM lab.application_form_versions WHERE is_active LIMIT 1) AS active_version,
              r.id AS round_id,
              COALESCE(r.disclosure_version, r.schema_version) AS round_version
         FROM lab.projects p
         LEFT JOIN lab.funding_rounds r
                ON r.project_id = p.id AND r.status IN ('open', 'paused')
        WHERE p.id = $1`,
      [projectId],
    );
    const row = rows[0];
    return {
      formVersion: row?.form_version ?? null,
      activeFormVersion: row?.active_version ?? null,
      roundDisclosureVersion: row?.round_id ? (row.round_version ?? null) : null,
      roundId: row?.round_id ?? null,
    };
  }

  /** Что станет видно этой аудитории после применения активной версии условий. */
  private async pending(
    tx: Tx,
    profile: (ApplicationPreview & { consentVersion: number }) | null,
    audience: PreviewAudience,
    roundVersion: number | null,
  ): Promise<ViewPreview['pending']> {
    const result: ViewPreview['pending'] = { profile: [], round: [] };
    if (profile) {
      const form = await this.formOf(tx, profile.schemaVersion);
      const keys = sortedQuestions(form).map((q) => q.key);
      const { rows } = await tx.query<{
        active: Record<string, Audience>;
        effective: Record<string, Audience>;
      }>(
        `SELECT (SELECT jsonb_object_agg(k, lab.field_visibility(k)) FROM unnest($1::text[]) k) AS active,
                (SELECT jsonb_object_agg(k, lab.effective_visibility(k, $2)) FROM unnest($1::text[]) k) AS effective`,
        [keys, profile.consentVersion],
      );
      const active = rows[0]?.active ?? {};
      const effective = rows[0]?.effective ?? {};
      for (const question of sortedQuestions(form)) {
        const a = active[question.key] ?? 'private';
        const e = effective[question.key] ?? 'private';
        if (visibleTo(a, audience) && !visibleTo(e, audience)) {
          result.profile.push({
            key: question.key,
            label:
              resolveText(question.texts, 'label', profile.locale, form.defaultLocale).value ??
              question.key,
            current: e,
            active: a,
          });
        }
      }
    }
    if (roundVersion !== null) {
      const { rows } = await tx.query<{ key: string; active: Audience; current: Audience }>(
        `SELECT k AS key, lab.field_visibility(k) AS active, lab.round_field_visibility(k, $2) AS current
           FROM unnest($1::text[]) k`,
        [[...ROUND_KEYS], roundVersion],
      );
      for (const row of rows) {
        if (visibleTo(row.active, audience) && !visibleTo(row.current, audience)) {
          result.round.push({
            key: row.key,
            label: ROUND_LABELS[row.key as (typeof ROUND_KEYS)[number]] ?? row.key,
            current: row.current,
            active: row.active,
          });
        }
      }
    }
    return result;
  }

  private async formOf(tx: Tx, version: number) {
    const { rows } = await tx.query<{ config_jsonb: unknown }>(
      `SELECT config_jsonb FROM lab.application_form_versions WHERE version = $1`,
      [version],
    );
    const row = rows[0];
    if (!row) throw errors.notFound({ subject: 'application_form_version', version });
    return parseStoredConfig(row.config_jsonb, version);
  }

  private toPublic(
    base: BaseRow,
    profile: (ApplicationPreview & { consentVersion: number; disclosedAt: Date | null }) | null,
  ): PublicView {
    const round = roundOf(base);
    return {
      id: base.id,
      title: base.title,
      tagline: base.tagline,
      stage: base.stage,
      taxonomyId: base.taxonomy_id,
      geoCountry: base.geo_country,
      investmentAsk: round.investmentAsk,
      askCurrency: (round.askCurrency ?? 'RUB') as 'RUB',
      listedAt: base.listed_at?.toISOString() ?? null,
      raising: round.raising,
      profileAudience: profile ? base.profile_audience : null,
      schemaVersion: profile?.schemaVersion ?? null,
      sections: profile?.sections ?? [],
      withheld: profile?.withheld ?? 0,
      disclosedAt: profile?.disclosedAt?.toISOString() ?? null,
    };
  }

  private toInvestor(
    base: BaseRow,
    profile: (ApplicationPreview & { consentVersion: number; disclosedAt: Date | null }) | null,
    materials: ViewMaterial[] | null,
    passport: ViewPassport | null,
  ): InvestorView {
    return {
      ...this.toPublic(base, profile),
      access: {
        profile: base.profile_audience,
        round: base.round_audience,
        materials: base.materials_audience,
        passport: base.passport_audience,
      },
      description: base.description,
      geoRegion: base.geo_region,
      round: roundOf(base),
      materials,
      passport,
    };
  }
}

/** Ответ виден аудитории, а его подтверждение (материал) для неё закрыто. */
function evidenceConflicts(
  sections: ApplicationPreview['sections'],
  materials: ViewMaterial[],
  audience: PreviewAudience,
): ViewPreview['evidenceConflicts'] {
  const closed = new Set(
    materials.filter((m) => !visibleTo(m.visibility, audience)).map((m) => m.id),
  );
  const result: ViewPreview['evidenceConflicts'] = [];
  const questions: ApplicationPreviewQuestion[] = sections.flatMap((s) => s.questions);
  for (const q of questions) {
    if (q.evidence.some((id) => closed.has(id))) result.push({ key: q.key, label: q.label });
  }
  return result;
}
