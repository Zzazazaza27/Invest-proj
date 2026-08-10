import { describe, expect, it } from 'vitest';
import {
  AcceptOfferRequestSchema,
  AddProductLinkSchema,
  CreateSubscriptionRequestSchema,
  ERROR_STATUS,
  ErrorCode,
  MoneyAmountSchema,
  NotificationPreferenceSchema,
  RegisterRequestSchema,
  REQUIRED_CONSENT_KINDS,
  ScoreSchema,
  fromMinorUnits,
  problemTypeUri,
  toMinorUnits,
  uuidv7,
  UuidSchema,
} from '../src/index.ts';

describe('UUIDv7', () => {
  it('соответствует формату и версии 7', () => {
    for (let i = 0; i < 100; i += 1) {
      const id = uuidv7();
      expect(UuidSchema.safeParse(id).success).toBe(true);
      expect(id[14]).toBe('7');
      expect(['8', '9', 'a', 'b']).toContain(id[19]);
    }
  });

  it('монотонен даже при генерации внутри одной миллисекунды', () => {
    const ids = Array.from({ length: 500 }, () => uuidv7());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Деньги', () => {
  it('отвергает то, что не является корректной суммой', () => {
    for (const bad of ['0', '-5', '1.234', 'abc', '', '1e5', ' 1.00', '1.']) {
      expect(MoneyAmountSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('принимает корректные суммы', () => {
    for (const good of ['1', '1.5', '1.50', '999999999999.99', '0.01']) {
      expect(MoneyAmountSchema.safeParse(good).success).toBe(true);
    }
  });

  it('перевод в копейки и обратно не теряет точность', () => {
    // 0.1 + 0.2 в плавающей точке даёт 0.30000000000000004 — здесь этого не происходит.
    expect(toMinorUnits('0.10') + toMinorUnits('0.20')).toBe(30n);
    expect(fromMinorUnits(30n)).toBe('0.30');
    expect(fromMinorUnits(toMinorUnits('999999999999.99'))).toBe('999999999999.99');
  });

  it('вознаграждение 10%/5% от 1 000 000 считается точно', () => {
    const base = toMinorUnits('1000000.00');
    expect(fromMinorUnits((base * 10n) / 100n)).toBe('100000.00');
    expect(fromMinorUnits((base * 5n) / 100n)).toBe('50000.00');
  });
});

describe('Регистрация: блокирующие акцепты', () => {
  const base = {
    email: 'founder@example.com',
    password: 'correct-horse-battery-staple',
    displayName: 'Основатель',
    role: 'founder' as const,
    locale: 'ru-RU' as const,
  };

  const allConsents = REQUIRED_CONSENT_KINDS.map((kind) => ({
    kind,
    version: 'v1',
    locale: 'ru-RU' as const,
  }));

  it('проходит при полном наборе акцептов', () => {
    expect(RegisterRequestSchema.safeParse({ ...base, consents: allConsents }).success).toBe(true);
  });

  it('НЕ проходит без акцепта условий вознаграждения', () => {
    const without = allConsents.filter((c) => c.kind !== 'commission_terms');
    const result = RegisterRequestSchema.safeParse({ ...base, consents: without });
    expect(result.success).toBe(false);
  });

  it.each(REQUIRED_CONSENT_KINDS)('НЕ проходит без акцепта %s', (missing) => {
    const without = allConsents.filter((c) => c.kind !== missing);
    expect(RegisterRequestSchema.safeParse({ ...base, consents: without }).success).toBe(false);
  });

  it('требует email или телефон', () => {
    const { email: _email, ...noContact } = base;
    expect(RegisterRequestSchema.safeParse({ ...noContact, consents: allConsents }).success).toBe(
      false,
    );
  });

  it('отвергает слишком короткий пароль', () => {
    expect(
      RegisterRequestSchema.safeParse({ ...base, password: 'short', consents: allConsents })
        .success,
    ).toBe(false);
  });

  it('отвергает роль, которую нельзя выбрать самому', () => {
    expect(
      RegisterRequestSchema.safeParse({ ...base, role: 'admin', consents: allConsents }).success,
    ).toBe(false);
  });
});

describe('Инвестиционное предложение', () => {
  const valid = {
    offerId: '019feb5f-43fe-77e7-b3c3-f0fa999cf06f',
    contractAmount: '1000000.00',
    currency: 'RUB' as const,
    idempotencyKey: 'idem-0123456789abcdef',
    acknowledgedFeeDisclosure: true as const,
    acknowledgedRulesVersion: 'platform_rules_v1',
  };

  it('проходит при явном подтверждении раскрытия условий', () => {
    expect(AcceptOfferRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('НЕ проходит без подтверждения раскрытия условий вознаграждения', () => {
    expect(
      AcceptOfferRequestSchema.safeParse({ ...valid, acknowledgedFeeDisclosure: false }).success,
    ).toBe(false);
  });

  it('требует ключ идемпотентности', () => {
    const { idempotencyKey: _k, ...withoutKey } = valid;
    expect(AcceptOfferRequestSchema.safeParse(withoutKey).success).toBe(false);
  });
});

describe('Подписка: тариф резолвит сервер', () => {
  it('основатель передаёт проект, а не план', () => {
    const ok = CreateSubscriptionRequestSchema.safeParse({
      audience: 'founder',
      projectId: '019feb5f-43fe-77e7-b3c3-f0fa999cf06f',
      idempotencyKey: 'idem-0123456789abcdef',
    });
    expect(ok.success).toBe(true);
    // planId в контракте отсутствует — подставить чужой тариф нельзя.
    expect(Object.keys(ok.success ? ok.data : {})).not.toContain('planId');
  });

  it('инвестор не передаёт проект', () => {
    expect(
      CreateSubscriptionRequestSchema.safeParse({
        audience: 'investor',
        projectId: '019feb5f-43fe-77e7-b3c3-f0fa999cf06f',
        idempotencyKey: 'idem-0123456789abcdef',
      }).success,
    ).toBe(true); // лишнее поле игнорируется, но и не влияет на резолв
  });
});

describe('SSRF-фильтр внешних ссылок', () => {
  it.each([
    'http://example.com/x',
    'https://127.0.0.1/x',
    'https://localhost/x',
    'https://10.1.2.3/x',
    'https://192.168.0.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://metadata.internal/x',
  ])('отвергает %s', (url) => {
    expect(
      AddProductLinkSchema.safeParse({
        projectId: '019feb5f-43fe-77e7-b3c3-f0fa999cf06f',
        url,
      }).success,
    ).toBe(false);
  });

  it('принимает обычный внешний https', () => {
    expect(
      AddProductLinkSchema.safeParse({
        projectId: '019feb5f-43fe-77e7-b3c3-f0fa999cf06f',
        url: 'https://example.com/product',
      }).success,
    ).toBe(true);
  });
});

describe('Уведомления', () => {
  it.each(['security', 'billing'] as const)('тему %s нельзя отключить', (topic) => {
    expect(
      NotificationPreferenceSchema.safeParse({ channel: 'email', topic, enabled: false }).success,
    ).toBe(false);
  });

  it('обычную тему отключить можно', () => {
    expect(
      NotificationPreferenceSchema.safeParse({
        channel: 'email',
        topic: 'marketing',
        enabled: false,
      }).success,
    ).toBe(true);
  });
});

describe('Оценка требует источников', () => {
  const base = {
    axis: 'market' as const,
    value: 70,
    confidenceLow: 60,
    confidenceHigh: 80,
    explanation: 'обоснование',
    modelVersion: 'v0.1-heuristic',
    computedAt: '2026-08-10T10:00:00.000Z',
  };

  it('без источников не проходит', () => {
    expect(ScoreSchema.safeParse({ ...base, sources: [] }).success).toBe(false);
  });

  it('с источником проходит', () => {
    expect(
      ScoreSchema.safeParse({ ...base, sources: [{ type: 'deck', ref: 'p.12' }] }).success,
    ).toBe(true);
  });
});

describe('Коды ошибок', () => {
  it('каждому коду сопоставлен HTTP-статус', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ERROR_STATUS[code], `нет статуса для ${code}`).toBeGreaterThanOrEqual(400);
    }
  });

  it('type — валидный URI', () => {
    expect(problemTypeUri(ErrorCode.NOT_FOUND)).toBe('https://unicorn.vc/problems/not_found');
  });
});
