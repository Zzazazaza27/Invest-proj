/**
 * Контракты раунда и условий страны обслуживания (этап 5.6.2, план 0.2 §0г).
 */
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_FORM_V1,
  ActivateServiceCountryPolicyRequestSchema,
  FUNDING_ROUND_TRANSITIONS,
  ProjectTeaserSchema,
  ServiceCountryPolicySchema,
  UpdateFundingRoundRequestSchema,
  buildStageForm,
  legacyFormConfig,
  raisingState,
  sectionScope,
} from '../src/index';

const policy = {
  baseCurrency: 'RUB',
  allowedRoundCurrencies: ['RUB'],
  freeAttraction: { enabled: false, amount: null, basis: null },
  paidPackages: { enabled: false },
  limits: { maxTargetPerRound: null },
  operator: {
    manualReviewRequired: false,
    notify: { enabled: false, minTarget: null, recipients: [] },
  },
  fx: { mode: 'none' as const },
};

describe('Условия страны обслуживания', () => {
  it('стартовая политика (сид M081) проходит схему', () => {
    expect(ServiceCountryPolicySchema.safeParse(policy).success).toBe(true);
  });

  it('бесплатную границу нельзя включить без суммы и без базы учёта', () => {
    const noAmount = ServiceCountryPolicySchema.safeParse({
      ...policy,
      freeAttraction: { enabled: true, amount: null, basis: 'per_round' },
    });
    expect(noAmount.success).toBe(false);
    const noBasis = ServiceCountryPolicySchema.safeParse({
      ...policy,
      freeAttraction: { enabled: true, amount: '5000000.00', basis: null },
    });
    expect(noBasis.success).toBe(false);
    expect(JSON.stringify(noBasis.error?.issues)).toContain('база учёта');
    const ok = ServiceCountryPolicySchema.safeParse({
      ...policy,
      freeAttraction: { enabled: true, amount: '5000000.00', basis: 'per_round' },
    });
    expect(ok.success).toBe(true);
  });

  it('базовая валюта обязана быть среди разрешённых; уведомления без получателей не включаются', () => {
    expect(
      ServiceCountryPolicySchema.safeParse({ ...policy, allowedRoundCurrencies: ['USD'] }).success,
    ).toBe(false);
    expect(
      ServiceCountryPolicySchema.safeParse({
        ...policy,
        operator: {
          manualReviewRequired: true,
          notify: { enabled: true, minTarget: null, recipients: [] },
        },
      }).success,
    ).toBe(false);
  });

  it('активация требует основание', () => {
    expect(
      ActivateServiceCountryPolicyRequestSchema.safeParse({ config: policy, reason: 'ok' }).success,
    ).toBe(false);
    expect(
      ActivateServiceCountryPolicyRequestSchema.safeParse({
        config: policy,
        reason: 'новые условия',
      }).success,
    ).toBe(true);
  });
});

describe('Раунд привлечения', () => {
  it('три состояния привлечения: open, paused, none', () => {
    expect(raisingState(null)).toBe('none');
    expect(raisingState({ status: 'draft' })).toBe('none');
    expect(raisingState({ status: 'open' })).toBe('open');
    expect(raisingState({ status: 'paused' })).toBe('paused');
    expect(raisingState({ status: 'closed' })).toBe('none');
  });

  it('closed и cancelled терминальны; paused возвращается в open тем же раундом', () => {
    expect(FUNDING_ROUND_TRANSITIONS.closed).toEqual([]);
    expect(FUNDING_ROUND_TRANSITIONS.cancelled).toEqual([]);
    expect(FUNDING_ROUND_TRANSITIONS.paused).toContain('open');
    expect(FUNDING_ROUND_TRANSITIONS.draft).not.toContain('paused');
  });

  it('частичное сохранение различает «очистить» и «не трогать»', () => {
    const cleared = UpdateFundingRoundRequestSchema.parse({ target: null });
    expect(cleared.target).toBeNull();
    expect('currency' in cleared).toBe(false);
    expect(UpdateFundingRoundRequestSchema.safeParse({ currency: 'rub' }).success).toBe(false);
  });

  it('тизер без раунда — «сейчас не привлекает»', () => {
    const teaser = ProjectTeaserSchema.parse({
      id: '01a0a50c-0000-7000-8000-000000000001',
      title: 'Проект',
      tagline: null,
      stage: 'idea',
      taxonomyId: null,
      geoCountry: null,
      investmentAsk: '1000000.00',
      askCurrency: 'RUB',
      listedAt: null,
    });
    expect(teaser.raising ?? 'none').toBe('none');
  });
});

describe('Раздел раунда в конфигурации формы', () => {
  it('стартовая конфигурация: funding — раунд, остальные — профиль; previous_funding в traction', () => {
    const funding = APPLICATION_FORM_V1.sections.find((s) => s.key === 'funding');
    expect(funding?.scope).toBe('round');
    expect(APPLICATION_FORM_V1.sections.filter((s) => sectionScope(s) === 'round')).toHaveLength(1);
    const moved = APPLICATION_FORM_V1.questions.find((q) => q.key === 'previous_funding');
    expect(moved?.section).toBe('traction');
  });

  it('конфигурации без признака: раздел funding считается раундом (совместимость)', () => {
    expect(sectionScope({ key: 'funding' })).toBe('round');
    expect(sectionScope({ key: 'traction' })).toBe('profile');
    expect(sectionScope({ key: 'funding', scope: 'profile' })).toBe('profile');
    const legacy = legacyFormConfig();
    const view = buildStageForm(legacy, { schemaVersion: 0, stage: 'idea', locale: 'ru-RU' });
    expect(view.sections.find((s) => s.key === 'funding')?.scope).toBe('round');
    expect(view.sections.find((s) => s.key === 'project')?.scope).toBe('profile');
  });
});
