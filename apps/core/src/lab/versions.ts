import type { ProjectVersion } from '@unicorn/contracts';

/**
 * Снимок версии заявки (lab.project_versions) — общий для подачи через
 * заявку и через старый маршрут проекта. Вынесен отдельно, чтобы сервисы
 * проектов и заявок не импортировали друг друга.
 */
export const VERSION_COLUMNS = `
  id, project_id, season_id, version_no, submitted_at, application_id, schema_version,
  readiness_config_version, completeness_pct
`;

export interface VersionRow {
  id: string;
  project_id: string;
  season_id: string | null;
  version_no: number;
  submitted_at: Date;
  application_id: string | null;
  schema_version: number;
  readiness_config_version: number | null;
  completeness_pct: number | null;
}

export function mapVersion(row: VersionRow): ProjectVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    seasonId: row.season_id,
    versionNo: row.version_no,
    submittedAt: row.submitted_at.toISOString(),
    applicationId: row.application_id,
    schemaVersion: row.schema_version,
    readinessConfigVersion: row.readiness_config_version,
    completenessPct: row.completeness_pct,
  };
}
