import { describe, expect, it } from 'vitest';
import {
  CreateAssignmentsRequestSchema,
  GrantGoldenTicketRequestSchema,
  NotificationPreferenceSchema,
  REVIEW_DISCREPANCY_THRESHOLD,
  RegisterDeviceRequestSchema,
  SubmitReviewRequestSchema,
  UpdatePreferencesRequestSchema,
} from '@unicorn/contracts';
import { parseOrThrow } from '../src/common/validation';
import { discrepancy } from '../src/experts/experts.service';
import { assertSafePayload, selectPrimaryChannels } from '../src/comms/notifications.service';

/**
 * Юнит-тесты фазы экспертизы, сезонного рейтинга и уведомлений.
 *
 * Проверяется то, что живой прогон показать не может или показывает
 * недостоверно: арифметика расхождения оценок на крайних случаях, выбор канала
 * доставки по конфигурации шаблонов и барьер против ПДн в полезной нагрузке
 * уведомления. Поведение маршрутов проверяется отдельно, прогоном по
 * запущенному серверу.
 */

const FULL_RUBRIC = {
  team: 8,
  product: 8,
  strategy: 8,
  legal: 8,
  finmodel: 8,
  scalability: 8,
};

describe('Расхождение оценок рецензентов', () => {
  it('одна рецензия расхождения не даёт: сравнивать не с чем', () => {
    expect(discrepancy([FULL_RUBRIC])).toBeNull();
    expect(discrepancy([])).toBeNull();
  });

  it('одинаковые рецензии дают ноль', () => {
    expect(discrepancy([FULL_RUBRIC, { ...FULL_RUBRIC }])).toBe(0);
  });

  it('считается по разнице крайних средних, а не по соседним оценкам', () => {
    const low = { ...FULL_RUBRIC, team: 2, product: 2 };
    const mid = { ...FULL_RUBRIC };
    const high = { ...FULL_RUBRIC, team: 10, product: 10, strategy: 10 };
    // low = (2+2+8+8+8+8)/6 = 6, high = (10+10+10+8+8+8)/6 = 9 → 3
    expect(discrepancy([low, mid, high])).toBe(3);
  });

  it('разброс выше порога — тот случай, ради которого нужен третий рецензент', () => {
    const pessimist = { team: 1, product: 1, strategy: 1, legal: 1, finmodel: 1, scalability: 1 };
    const optimist = { team: 9, product: 9, strategy: 9, legal: 9, finmodel: 9, scalability: 9 };
    const score = discrepancy([pessimist, optimist]);
    expect(score).toBe(8);
    expect(score! > REVIEW_DISCREPANCY_THRESHOLD).toBe(true);
  });

  it('лишние ключи в рубрике не учитываются: считаются только объявленные оси', () => {
    const withNoise = { ...FULL_RUBRIC, hype: 100 } as Record<string, number>;
    expect(discrepancy([withNoise, FULL_RUBRIC])).toBe(0);
  });
});

describe('Контракт рецензии', () => {
  it('оценка вне диапазона 0–10 не принимается', () => {
    expect(() =>
      parseOrThrow(SubmitReviewRequestSchema, {
        assignmentId: '018f2b7c-0000-7000-8000-000000000001',
        rubricScores: { ...FULL_RUBRIC, team: 11 },
        recommendation: 'pass',
      }),
    ).toThrow();
  });

  it('неполная рубрика не принимается: пропуск оси — не «ноль», а отсутствие оценки', () => {
    const { scalability: _omitted, ...partial } = FULL_RUBRIC;
    expect(() =>
      parseOrThrow(SubmitReviewRequestSchema, {
        assignmentId: '018f2b7c-0000-7000-8000-000000000001',
        rubricScores: partial,
        recommendation: 'pass',
      }),
    ).toThrow();
  });

  it('посторонние поля отвергаются на границе, а не отбрасываются молча', () => {
    expect(() =>
      parseOrThrow(SubmitReviewRequestSchema, {
        assignmentId: '018f2b7c-0000-7000-8000-000000000001',
        rubricScores: FULL_RUBRIC,
        recommendation: 'pass',
        expertId: '018f2b7c-0000-7000-8000-000000000009',
      }),
    ).toThrow();
  });
});

describe('Контракт назначения', () => {
  const projectId = '018f2b7c-0000-7000-8000-000000000002';

  it('пустой список экспертов не принимается', () => {
    expect(() =>
      parseOrThrow(CreateAssignmentsRequestSchema, {
        projectId,
        expertIds: [],
        dueAt: '2026-09-01T00:00:00Z',
      }),
    ).toThrow();
  });

  it('срок обязателен и разбирается как момент времени', () => {
    expect(() =>
      parseOrThrow(CreateAssignmentsRequestSchema, {
        projectId,
        expertIds: ['018f2b7c-0000-7000-8000-000000000003'],
        dueAt: 'завтра',
      }),
    ).toThrow();
  });
});

describe('Контракт золотого билета', () => {
  it('причина обязательна: непрозрачная привилегия обесценивает рейтинг', () => {
    expect(() =>
      parseOrThrow(GrantGoldenTicketRequestSchema, {
        projectId: '018f2b7c-0000-7000-8000-000000000004',
        reason: 'ок',
      }),
    ).toThrow();
  });
});

describe('Предпочтения уведомлений', () => {
  it('темы security и billing отключить нельзя', () => {
    for (const topic of ['security', 'billing'] as const) {
      expect(
        NotificationPreferenceSchema.safeParse({ channel: 'email', topic, enabled: false }).success,
      ).toBe(false);
    }
  });

  it('маркетинг отключается свободно', () => {
    expect(
      NotificationPreferenceSchema.safeParse({
        channel: 'email',
        topic: 'marketing',
        enabled: false,
      }).success,
    ).toBe(true);
  });

  it('пакет предпочтений ограничен по размеру: тело запроса не безразмерно', () => {
    const item = { channel: 'push', topic: 'projects', enabled: true };
    expect(() =>
      parseOrThrow(UpdatePreferencesRequestSchema, { items: Array(101).fill(item) }),
    ).toThrow();
  });
});

describe('Регистрация устройства', () => {
  it('пустой push-токен не принимается', () => {
    expect(() =>
      parseOrThrow(RegisterDeviceRequestSchema, {
        platform: 'ios',
        pushProvider: 'apns',
        pushToken: '',
      }),
    ).toThrow();
  });

  it('неизвестная платформа не принимается', () => {
    expect(() =>
      parseOrThrow(RegisterDeviceRequestSchema, {
        platform: 'symbian',
        pushProvider: 'apns',
        pushToken: 'a'.repeat(32),
      }),
    ).toThrow();
  });
});

describe('Выбор канала доставки', () => {
  it('запасной канал не получает собственной строки в очереди', () => {
    const templates = [
      { channel: 'push', fallback_chain: ['telegram', 'email'] },
      { channel: 'email', fallback_chain: [] },
    ];
    expect(selectPrimaryChannels(templates)).toEqual(['push']);
  });

  it('единственный канал первичен', () => {
    expect(selectPrimaryChannels([{ channel: 'email', fallback_chain: [] }])).toEqual(['email']);
  });

  it('несколько независимых каналов дают несколько строк', () => {
    const templates = [
      { channel: 'email', fallback_chain: [] },
      { channel: 'sms', fallback_chain: [] },
    ];
    expect(selectPrimaryChannels(templates)).toEqual(['email', 'sms']);
  });

  it('циклическая конфигурация не оставляет очередь пустой', () => {
    const templates = [
      { channel: 'push', fallback_chain: ['email'] },
      { channel: 'email', fallback_chain: ['push'] },
    ];
    expect(selectPrimaryChannels(templates)).toEqual(['email']);
  });

  it('шаблонов нет — каналов нет, и это должно быть видно вызывающему', () => {
    expect(selectPrimaryChannels([])).toEqual([]);
  });
});

describe('Полезная нагрузка уведомления', () => {
  it('безопасная нагрузка проходит', () => {
    expect(() =>
      assertSafePayload({ project_title: 'Проект', decision: 'pass', irs: 72 }),
    ).not.toThrow();
  });

  it('персональные данные не уходят стороннему провайдеру', () => {
    for (const key of ['email', 'phone_number', 'passportSeries', 'user_full_name', 'inn']) {
      expect(() => assertSafePayload({ [key]: 'x' })).toThrow();
    }
  });

  it('секреты и токены в нагрузку не кладутся', () => {
    expect(() => assertSafePayload({ push_token: 'abc' })).toThrow();
    expect(() => assertSafePayload({ secret: 'abc' })).toThrow();
  });

  it('вложенные объекты отвергаются: их содержимое никто не проверял', () => {
    expect(() => assertSafePayload({ project: { title: 'Проект' } })).toThrow();
  });

  it('слишком длинное значение отвергается', () => {
    expect(() => assertSafePayload({ project_title: 'а'.repeat(501) })).toThrow();
  });
});
