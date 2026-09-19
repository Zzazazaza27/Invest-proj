/**
 * Общая обстановка для проверок расчёта стоимости запуска раунда (5.9.2).
 *
 * Живой прогон и рендер-проверка смотрят на одно и то же: сетку пакетов,
 * временно включённые платные пакеты и черновик раунда в их диапазоне. Чтобы
 * они не разошлись (и чтобы обе одинаково прибирали за собой), обстановка
 * заведена здесь.
 *
 * Условия страны версионируются: «откатить» их нельзя, поэтому прежнее
 * состояние возвращается новой версией с основанием. Версии пакетов не
 * удаляются — история цены такой же факт, как и цена, — поэтому прогоны
 * закрывают свои версии, а не стирают их.
 */
import pg from 'pg';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

/** Диапазоны прогонов заведомо выше настроенных сеток стенда. */
export const GRID = {
  smallFrom: '800000000',
  smallTo: '850000000',
  fullTo: '900000000',
  target: '820000000.00',
  smallPrice: '15000.00',
  fullPrice: '40000.00',
  sidePrice: '90000.00',
  extraPrice: '7000.00',
};

export function makePool(name) {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL_OWNER,
    max: 4,
    application_name: name,
  });
}

export function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

export const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

export function answerFor(question) {
  switch (question.type) {
    case 'number':
      return 3;
    case 'money':
      return '1500000.00';
    case 'select':
      return question.options?.[0]?.code;
    case 'multiselect':
      return [question.options?.[0]?.code];
    case 'boolean':
      return true;
    case 'url':
      return 'https://example.com/product';
    case 'date':
      return '2026-01-01';
    case 'material_ref':
      return [];
    default:
      return 'Ответ прогона расчёта стоимости.';
  }
}

/** Проект с поданным профилем и черновик раунда на сумму из диапазона прогона. */
export async function createProjectWithDraftRound(client, sql, suffix) {
  const [{ id: taxonomyId }] = await sql(
    `SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech' LIMIT 1`,
  );
  await client.json('/v1/me/service-country', { method: 'PUT', body: { code: 'ru' } });

  const project = await client.json('/v1/projects', {
    method: 'POST',
    body: {
      title: `Прогон расчёта ${suffix}`,
      tagline: 'Проект прогона: проверяем расчёт стоимости запуска',
      stage: 'mvp',
      taxonomyId,
      investmentAsk: GRID.target,
      askCurrency: 'RUB',
      geoCountry: 'RU',
    },
  });
  const application = await client.json(`/v1/projects/${project.id}/applications`, {
    method: 'POST',
    body: {},
  });
  const form = await client.json(`/v1/applications/${application.id}/form`);

  const answers = {};
  for (const section of form.sections) {
    for (const question of section.questions) {
      if (question.state !== 'mandatory' || question.coreField) continue;
      answers[question.key] = answerFor(question);
    }
  }
  await client.json(`/v1/applications/${application.id}`, {
    method: 'PATCH',
    body: { stage: 'mvp', answers },
  });
  const preview = await client.json(
    `/v1/applications/${application.id}/preview?audience=investors`,
  );
  const version = await client.json(`/v1/applications/${application.id}/submit`, {
    method: 'POST',
    body: { activeFormVersion: preview.activeFormVersion, contentDigest: preview.contentDigest },
  });

  const created = await client.json(`/v1/projects/${project.id}/rounds`, {
    method: 'POST',
    body: { applicationVersionId: version.id },
  });
  const roundAnswers = {};
  for (const section of form.sections) {
    if (section.scope !== 'round') continue;
    for (const question of section.questions) {
      if (question.state !== 'mandatory' || question.coreField) continue;
      roundAnswers[question.key] = answerFor(question);
    }
  }
  await client.json(`/v1/rounds/${created.round.id}`, {
    method: 'PATCH',
    body: {
      target: GRID.target,
      currency: 'RUB',
      fundingScope: 'project',
      investorMode: 'multiple',
      answers: roundAnswers,
    },
  });
  return { project, application, version, roundId: created.round.id };
}

/**
 * Сетка прогона: требуемый пакет, более полный (состав шире) и «особый» —
 * дороже, но с другим набором. Последний нужен, чтобы проверить, что цена
 * признаком полноты не считается.
 */
export async function publishGrid(admin, codes) {
  for (const [code, name] of [
    [codes.svcBase, 'Базовая проверка (прогон)'],
    [codes.svcExtra, 'Отчёт для инвестора (прогон)'],
    [codes.svcOther, 'Разбор с экспертом (прогон)'],
  ]) {
    const service = await admin.json('/v1/admin/round-services', {
      method: 'POST',
      body: { code, name },
    });
    await admin.json(`/v1/admin/round-services/${service.id}`, {
      method: 'PATCH',
      body: { isImplemented: true, reason: 'прогон расчёта: услуга реализована' },
    });
  }
  await admin.json('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: codes.pkgSmall,
      countryCode: 'ru',
      name: 'Малый (прогон)',
      price: GRID.smallPrice,
      currency: 'RUB',
      minTarget: GRID.smallFrom,
      maxTarget: GRID.smallTo,
      serviceCodes: [codes.svcBase],
      reason: 'прогон расчёта: требуемый пакет',
    },
  });
  await admin.json('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: codes.pkgFull,
      countryCode: 'ru',
      name: 'Полный (прогон)',
      price: GRID.fullPrice,
      currency: 'RUB',
      minTarget: GRID.smallTo,
      maxTarget: GRID.fullTo,
      serviceCodes: [codes.svcBase, codes.svcExtra],
      reason: 'прогон расчёта: более полный пакет',
    },
  });
  await admin.json('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: codes.pkgSide,
      countryCode: 'ru',
      name: 'Особый (прогон)',
      price: GRID.sidePrice,
      currency: 'RUB',
      minTarget: GRID.fullTo,
      maxTarget: null,
      serviceCodes: [codes.svcOther],
      reason: 'прогон расчёта: дороже, но с другим набором',
    },
  });
  await admin.json('/v1/admin/round-service-offers', {
    method: 'POST',
    body: {
      serviceCode: codes.svcOther,
      countryCode: 'ru',
      price: GRID.extraPrice,
      currency: 'RUB',
      reason: 'прогон расчёта: цена докупки',
    },
  });
}

export function codesFor(suffix) {
  return {
    svcBase: `prc_base_${suffix}`,
    svcExtra: `prc_extra_${suffix}`,
    svcOther: `prc_other_${suffix}`,
    pkgSmall: `prcp_small_${suffix}`,
    pkgFull: `prcp_full_${suffix}`,
    pkgSide: `prcp_side_${suffix}`,
  };
}

/** Закрывает версии прошлых прогонов: иначе диапазоны столкнутся. */
export async function closeLeftoverPackages(sql) {
  await sql(
    `UPDATE billing.round_packages
        SET valid_to = GREATEST(now(), valid_from + interval '1 millisecond')
      WHERE starts_with(code, 'prcp_') AND (valid_to IS NULL OR valid_to > now())`,
  );
}

/** Включает платные пакеты новой версией условий и возвращает прежний config. */
export async function enablePaidPackages(admin, sql) {
  const [before] = await sql(
    `SELECT config_jsonb FROM billing.service_country_policies
      WHERE country_code = 'ru' AND is_active`,
  );
  await admin.json('/v1/admin/service-countries/ru/policies', {
    method: 'POST',
    body: {
      config: { ...before.config_jsonb, paidPackages: { enabled: true } },
      reason: 'прогон расчёта: временно включены платные пакеты',
    },
  });
  return before.config_jsonb;
}

export async function restorePolicy(admin, sql, config) {
  await admin.json('/v1/admin/service-countries/ru/policies', {
    method: 'POST',
    body: {
      config,
      reason: 'прогон расчёта: платные пакеты возвращены в выключенное состояние',
    },
  });
  await closeLeftoverPackages(sql);
}
