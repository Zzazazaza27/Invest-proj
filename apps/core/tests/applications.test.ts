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
import { computeProjectLimits } from '../src/lab/projects.service';
import { strict } from '../src/common/validation';

const policy: ApplicationPolicy = {
  maxProjectsPerAccount: 0,
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

describe('Условия подачи (с 5.6.3 — без суммы: она у раунда)', () => {
  it('черновик без суммы и предмета финансирования подаётся', () => {
    const check = checkSubmission({ status: 'draft' }, policy, { missingMandatory: [] });
    expect(check.canSubmit).toBe(true);
    expect(check.missing).toEqual([]);
  });

  it('незаполненные обязательные вопросы профиля мешают подаче; системные — нет', () => {
    const check = checkSubmission({ status: 'draft' }, policy, {
      missingMandatory: ['stage', 'problem_statement'],
    });
    expect(check.canSubmit).toBe(false);
    expect(check.missing.map((m) => m.path)).toEqual(['answers.problem_statement']);
  });

  it('архивную заявку подать нельзя', () => {
    const check = checkSubmission({ status: 'archived' }, policy);
    expect(check.missing.map((m) => m.path)).toEqual(['status']);
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

describe('Лимит проектов аккаунта', () => {
  it('0 — безлимит: остаток не считается', () => {
    const limits = computeProjectLimits(1, { maxProjectsPerAccount: 0 }, 42);
    expect(limits.projects).toEqual({ limit: 0, used: 42, remaining: null });
    expect(limits.source).toBe('application_policy');
  });

  it('конечный лимит даёт остаток и не уходит в минус', () => {
    expect(computeProjectLimits(1, { maxProjectsPerAccount: 10 }, 3).projects.remaining).toBe(7);
    expect(computeProjectLimits(1, { maxProjectsPerAccount: 2 }, 5).projects.remaining).toBe(0);
  });

  it('политика без поля читается как безлимит', () => {
    const parsed = ApplicationPolicySchema.parse(policy);
    expect(parsed.maxProjectsPerAccount).toBe(0);
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
