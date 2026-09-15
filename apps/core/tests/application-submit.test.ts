/**
 * Снимок версии заявки (план 0.2 §5.1): что в него входит и что — нет.
 * Чистая функция; сама подача и проекция проверяются живьём (smoke-lab).
 */
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_FORM_V1,
  computeCompleteness,
  defaultReadinessConfig,
  type InvestmentApplication,
} from '@unicorn/contracts';
import { buildSnapshot } from '../src/lab/applications.service';

const application: InvestmentApplication = {
  id: '0192a0c0-0000-7000-8000-000000000001',
  projectId: '0192a0c0-0000-7000-8000-000000000002',
  status: 'draft',
  title: 'Раунд seed',
  stage: 'mvp',
  businessType: 'saas',
  fundingScope: 'direction',
  fundingScopeNote: 'Запуск Taxi',
  investmentAsk: '3000000.00',
  askCurrency: 'RUB',
  schemaVersion: 0,
  answers: { description: 'Текст заявки' },
  evidence: { description: ['0192a0c0-0000-7000-8000-000000000003'] },
  currentVersionId: null,
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
  submittedAt: null,
  archivedAt: null,
};

describe('Снимок версии заявки', () => {
  it('содержит core-поля, ответы, подтверждения и поля проекта для карточки', () => {
    const snapshot = buildSnapshot(application, {
      title: 'Проект',
      tagline: 'Коротко',
      description: 'Длинно',
      taxonomy_id: '0192a0c0-0000-7000-8000-000000000004',
      geo_country: 'RU',
      geo_region: 'Москва',
    });
    expect(snapshot).toEqual({
      core: {
        title: 'Раунд seed',
        stage: 'mvp',
        businessType: 'saas',
        fundingScope: 'direction',
        fundingScopeNote: 'Запуск Taxi',
        investmentAsk: '3000000.00',
        askCurrency: 'RUB',
      },
      answers: { description: 'Текст заявки' },
      evidence: { description: ['0192a0c0-0000-7000-8000-000000000003'] },
      applicableKeys: {},
      project: {
        title: 'Проект',
        tagline: 'Коротко',
        description: 'Длинно',
        taxonomyId: '0192a0c0-0000-7000-8000-000000000004',
        geoCountry: 'RU',
        geoRegion: 'Москва',
      },
    });
  });

  it('не тянет в снимок служебные поля заявки: статус, идентификаторы, даты', () => {
    const snapshot = buildSnapshot(application, {
      title: 'Проект',
      tagline: null,
      description: null,
      taxonomy_id: null,
      geo_country: null,
      geo_region: null,
    });
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain(application.id);
    expect(text).not.toContain('"status"');
    expect(text).not.toContain('createdAt');
  });

  it('с формой версии: применимые ключи, форма с текстами и готовность (план 0.2 §0в п.7)', () => {
    const v1 = { ...application, schemaVersion: 1, answers: {}, evidence: {} };
    const readiness = computeCompleteness(
      APPLICATION_FORM_V1,
      defaultReadinessConfig(APPLICATION_FORM_V1),
      { ...v1, evidence: {} },
      { schemaVersion: 1, readinessConfigVersion: 1 },
    );
    const snapshot = buildSnapshot(
      v1,
      {
        title: 'Проект',
        tagline: null,
        description: null,
        taxonomy_id: null,
        geo_country: null,
        geo_region: null,
      },
      { form: APPLICATION_FORM_V1, readiness, locale: 'ru-RU' },
    ) as {
      applicableKeys: Record<string, string>;
      form: {
        schemaVersion: number;
        stage: string;
        sections: { key: string; questions: { key: string; label: string; state: string }[] }[];
      };
      readiness: { percent: number; readinessConfigVersion: number | null };
    };
    // Применимость зафиксирована на момент подачи: стадия mvp, направление → note применим.
    expect(snapshot.applicableKeys.problem_statement).toBe('mandatory');
    expect(snapshot.applicableKeys.funding_scope_note).toBe('mandatory');
    expect(snapshot.applicableKeys.mrr).toBeUndefined();
    expect(snapshot.applicableKeys.growth_rate).toBeUndefined();
    // Форма — с формулировками на языке подачи, чтобы снимок читался без конфигурации.
    expect(snapshot.form.schemaVersion).toBe(1);
    expect(snapshot.form.stage).toBe('mvp');
    const problem = snapshot.form.sections
      .flatMap((s) => s.questions)
      .find((q) => q.key === 'problem_statement');
    expect(problem?.label).toBe('Какую проблему вы решаете?');
    expect(problem?.state).toBe('mandatory');
    expect(snapshot.readiness).toEqual({ percent: readiness.percent, readinessConfigVersion: 1 });
  });
});
