/**
 * Заявка: правила подсчёта лимитов и условия подачи (план 0.2 §2.8, §2.2).
 * Чистые функции — без БД; интеграция с RLS и CHECK — в database/tests.
 */
import { describe, expect, it } from 'vitest';
import {
  ApplicationPolicySchema,
  CreateApplicationRequestSchema,
  UpdateApplicationRequestSchema,
  UpdateProjectRequestSchema,
  type ApplicationPolicy,
} from '@unicorn/contracts';
import {
  checkSubmission,
  computeLimits,
  evidenceIds,
  exceedsOpenTotal,
  foreignEvidence,
} from '../src/lab/applications.service';
import { strict } from '../src/common/validation';

const policy: ApplicationPolicy = {
  maxApplicationsPerProject: 3,
  maxApplicationsPerAccount: null,
  count: { draft: true, submitted: true, archived: false },
  maxAskPerApplication: '5000000.00',
  maxOpenAskTotalPerProject: null,
};

describe('Политика ограничений: подсчёт', () => {
  it('черновики считаются, архив — нет', () => {
    const limits = computeLimits(1, policy, {
      project: { draft: 1, submitted: 1, archived: 5 },
      account: null,
      openAskTotal: '800000',
    });
    expect(limits.applications).toEqual({ limit: 3, used: 2, remaining: 1 });
    expect(limits.account).toBeNull();
    expect(limits.openAskTotal).toBe('800000.00');
  });

  it('при count.draft = false черновики место не занимают', () => {
    const limits = computeLimits(
      2,
      { ...policy, count: { ...policy.count, draft: false } },
      { project: { draft: 4, submitted: 1, archived: 0 }, account: null, openAskTotal: '0' },
    );
    expect(limits.applications.used).toBe(1);
  });

  it('остаток не уходит в минус, когда политику ужесточили', () => {
    const limits = computeLimits(
      3,
      { ...policy, maxApplicationsPerProject: 1 },
      { project: { draft: 2, submitted: 1, archived: 0 }, account: null, openAskTotal: '0' },
    );
    expect(limits.applications.remaining).toBe(0);
  });

  it('лимит на аккаунт считается только когда задан', () => {
    const on = computeLimits(
      1,
      { ...policy, maxApplicationsPerAccount: 5 },
      {
        project: { draft: 0, submitted: 0, archived: 0 },
        account: { draft: 2, submitted: 2, archived: 9 },
        openAskTotal: '0',
      },
    );
    expect(on.account).toEqual({ limit: 5, used: 4, remaining: 1 });
  });

  it('потолок суммы открытых заявок ловит дробление', () => {
    const capped = { ...policy, maxOpenAskTotalPerProject: '5000000.00' };
    expect(exceedsOpenTotal(capped, '4000000.00', '1000000.00')).toBe(false);
    expect(exceedsOpenTotal(capped, '4000000.00', '1000000.01')).toBe(true);
    expect(exceedsOpenTotal(policy, '99999999.00', '1.00')).toBe(false);
  });
});

describe('Условия подачи', () => {
  it('черновик без суммы сохраняется, но подать нельзя', () => {
    const check = checkSubmission(
      { status: 'draft', investmentAsk: null, fundingScope: 'project', fundingScopeNote: null },
      policy,
    );
    expect(check.canSubmit).toBe(false);
    expect(check.missing.map((m) => m.path)).toEqual(['investmentAsk']);
  });

  it('предмет финансирования без выбора — не ответ: при подаче требуется (M078)', () => {
    const check = checkSubmission(
      { status: 'draft', investmentAsk: '1000000.00', fundingScope: null, fundingScopeNote: null },
      policy,
    );
    expect(check.missing.map((m) => m.path)).toEqual(['fundingScope']);
  });

  it('направление требует уточнения только на подаче', () => {
    const check = checkSubmission(
      {
        status: 'draft',
        investmentAsk: '1000000.00',
        fundingScope: 'direction',
        fundingScopeNote: null,
      },
      policy,
    );
    expect(check.missing.map((m) => m.path)).toEqual(['fundingScopeNote']);
  });

  it('сумма выше потолка политики блокирует подачу', () => {
    const check = checkSubmission(
      {
        status: 'draft',
        investmentAsk: '5000000.01',
        fundingScope: 'project',
        fundingScopeNote: null,
      },
      policy,
    );
    expect(check.canSubmit).toBe(false);
    expect(check.missing[0]!.path).toBe('investmentAsk');
  });

  it('полная заявка проходит', () => {
    const check = checkSubmission(
      {
        status: 'submitted',
        investmentAsk: '5000000.00',
        fundingScope: 'direction',
        fundingScopeNote: 'Запуск Taxi',
      },
      policy,
    );
    expect(check.canSubmit).toBe(true);
  });

  it('незаполненные обязательные вопросы формы мешают подаче; системные не дублируются', () => {
    const check = checkSubmission(
      { status: 'draft', investmentAsk: null, fundingScope: 'project', fundingScopeNote: null },
      policy,
      { missingMandatory: ['problem_statement', 'investment_ask', 'founders'] },
    );
    expect(check.canSubmit).toBe(false);
    expect(check.missing.map((m) => m.path)).toEqual([
      'answers.problem_statement',
      'answers.founders',
      'investmentAsk',
    ]);
  });
});

describe('Контракты заявки', () => {
  it('политика не даёт выключить подсчёт поданных или включить архив', () => {
    expect(
      ApplicationPolicySchema.safeParse({
        ...policy,
        count: { draft: true, submitted: false, archived: false },
      }).success,
    ).toBe(false);
    expect(
      ApplicationPolicySchema.safeParse({
        ...policy,
        count: { draft: true, submitted: true, archived: true },
      }).success,
    ).toBe(false);
  });

  it('создание черновика допускает пустое тело', () => {
    expect(CreateApplicationRequestSchema.safeParse({}).success).toBe(true);
  });

  it('автосохранение различает «очистить» и «не трогать», а мусорный ключ отвергает', () => {
    const cleared = UpdateApplicationRequestSchema.parse({ investmentAsk: null });
    expect(cleared.investmentAsk).toBeNull();
    expect('title' in cleared).toBe(false);
    expect(UpdateApplicationRequestSchema.safeParse({ answers: { 'Bad Key': 1 } }).success).toBe(
      false,
    );
  });

  it('валюта из обновления проекта убрана: поле больше не теряется молча', () => {
    expect(strict(UpdateProjectRequestSchema).safeParse({ askCurrency: 'RUB' }).success).toBe(
      false,
    );
  });
});

describe('Подтверждения: только материалы своего проекта (5.6.0)', () => {
  const mine = '01a0a50c-0000-7000-8000-000000000001';
  const mine2 = '01a0a50c-0000-7000-8000-000000000002';
  const foreign = '01a0a50c-0000-7000-8000-00000000ffff';

  it('собирает идентификаторы без повторов', () => {
    expect(evidenceIds({ a: [mine, mine2], b: [mine] })).toEqual([mine, mine2]);
    expect(evidenceIds({})).toEqual([]);
  });

  it('чужой или незагруженный материал — ошибка у поля вопроса', () => {
    const issues = foreignEvidence({ traction_proof: [mine, foreign], team: [mine2] }, [
      mine,
      mine2,
    ]);
    expect(issues).toEqual([
      { path: 'evidence.traction_proof', message: 'материал не принадлежит проекту' },
    ]);
  });

  it('свои материалы и пустая привязка проходят', () => {
    expect(foreignEvidence({ a: [mine] }, [mine])).toEqual([]);
    expect(foreignEvidence({ a: [] }, [])).toEqual([]);
  });
});
