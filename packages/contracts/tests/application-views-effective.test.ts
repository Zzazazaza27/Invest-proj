import { describe, expect, it } from 'vitest';
import { APPLICATION_FORM_V1, buildApplicationPreview, type PreviewSource } from '../src/index';

/**
 * Эффективная видимость (5.7.2): представление строится по карте
 * «ключ → видимость» (строже из активной конфигурации и версии согласия),
 * а не по видимости вопроса в переданной форме. Ключ без карты — `private`.
 */

const form = APPLICATION_FORM_V1;
const params = { schemaVersion: 1, stage: 'mvp' as const, locale: 'ru-RU' };
const source: PreviewSource = {
  core: {
    title: 'Проект',
    stage: 'mvp',
    businessType: 'saas',
    fundingScope: 'project',
    fundingScopeNote: null,
    investmentAsk: null,
    askCurrency: 'RUB',
  },
  answers: {
    problem_statement: 'Боль клиента', // в форме public
    customer_model: 'b2b', // в форме public
    deal_terms: '15% за 17 млн', // в форме investors
  },
  evidence: {},
  project: {
    title: 'Проект',
    tagline: null,
    description: null,
    taxonomyId: null,
    geoCountry: null,
    geoRegion: null,
  },
  round: {
    raising: 'none',
    investmentAsk: null,
    askCurrency: null,
    fundingScope: null,
    fundingScopeNote: null,
  },
};

const keysOf = (sections: { questions: { key: string }[] }[]): string[] =>
  sections.flatMap((s) => s.questions.map((q) => q.key));

describe('buildApplicationPreview — эффективная видимость', () => {
  it('без карты — по форме: анониму public-ответы, инвестору и investors', () => {
    const anon = buildApplicationPreview(form, { ...params, audience: 'public' }, source);
    expect(keysOf(anon.sections)).toEqual(
      expect.arrayContaining(['problem_statement', 'customer_model']),
    );
    expect(keysOf(anon.sections)).not.toContain('deal_terms');
  });

  it('карта строже формы закрывает поле сразу; ключ вне карты — private', () => {
    const view = buildApplicationPreview(
      form,
      {
        ...params,
        audience: 'investors',
        effectiveVisibility: { problem_statement: 'platform', deal_terms: 'investors' },
      },
      source,
    );
    const keys = keysOf(view.sections);
    expect(keys).toContain('deal_terms');
    expect(keys).not.toContain('problem_statement'); // ужесточено до platform
    expect(keys).not.toContain('customer_model'); // нет в карте — private
    expect(view.withheld).toBeGreaterThanOrEqual(2);
  });

  it('карта мягче формы (смягчение администратором после согласия владельца) — открывает по карте', () => {
    // Сама карта приходит из БД уже как «строже из двух»; здесь проверяется,
    // что представление доверяет карте, а не видимости вопроса в форме.
    const view = buildApplicationPreview(
      form,
      { ...params, audience: 'public', effectiveVisibility: { deal_terms: 'public' } },
      source,
    );
    expect(keysOf(view.sections)).toEqual(['deal_terms']);
    expect(view.sections.flatMap((s) => s.questions)[0]!.visibility).toBe('public');
  });
});
