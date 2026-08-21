import { describe, expect, it } from 'vitest';
import {
  AcceptOfferRequestSchema,
  AddProductLinkSchema,
  CreateSubscriptionRequestSchema,
  ERROR_STATUS,
  ErrorCode,
  MATERIAL_UPLOAD_RULES,
  MoneyAmountSchema,
  NotificationPreferenceSchema,
  EVENT_PAYLOAD_SCHEMAS,
  EventVerb,
  PublicationConsentRequestSchema,
  RegisterRequestSchema,
  RequestUploadSchema,
  REQUIRED_CONSENT_KINDS,
  verbAllowedByScopes,
  ScoreSchema,
  fromMinorUnits,
  problemTypeUri,
  toMinorUnits,
  uuidv7,
  UuidSchema,
} from '../src/index';

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
    idempotencyKey: 'idem-test-fixture-000000',
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
      idempotencyKey: 'idem-test-fixture-000000',
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
        idempotencyKey: 'idem-test-fixture-000000',
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

describe('RequestUploadSchema — матрица тип ↔ MIME ↔ размер (Ф35, CODE-HIGH-09)', () => {
  const base = {
    projectId: '01890a5d-ac96-774b-bcce-b302099a8057',
    type: 'deck' as const,
    fileName: 'deck.pdf',
    contentType: 'application/pdf' as const,
    sizeBytes: 1024,
  };

  it('pdf как deck проходит', () => {
    expect(RequestUploadSchema.safeParse(base).success).toBe(true);
  });

  it('video/mp4 как deck отвергается', () => {
    expect(RequestUploadSchema.safeParse({ ...base, contentType: 'video/mp4' }).success).toBe(
      false,
    );
  });

  it('png как deck отвергается', () => {
    expect(RequestUploadSchema.safeParse({ ...base, contentType: 'image/png' }).success).toBe(
      false,
    );
  });

  it('pdf как video отвергается', () => {
    expect(RequestUploadSchema.safeParse({ ...base, type: 'video' }).success).toBe(false);
  });

  it('deck больше 50 МБ отвергается контрактом, а не только сервером', () => {
    expect(
      RequestUploadSchema.safeParse({
        ...base,
        sizeBytes: MATERIAL_UPLOAD_RULES.deck.maxBytes + 1,
      }).success,
    ).toBe(false);
  });

  it('video/mp4 как video в пределах лимита проходит', () => {
    expect(
      RequestUploadSchema.safeParse({
        ...base,
        type: 'video',
        contentType: 'video/mp4',
        fileName: 'demo.mp4',
        sizeBytes: MATERIAL_UPLOAD_RULES.video.maxBytes,
      }).success,
    ).toBe(true);
  });
});

describe('Скоупы вебхуков: событие доступно только своему скоупу (Ф42)', () => {
  it('webhooks:manage сам по себе НЕ даёт подписку на денежные события', () => {
    // Ровно находка аудита: аккаунт с одним webhooks:manage подписывался на
    // investment.agreement.created — с суммой договора в payload.
    expect(verbAllowedByScopes('investment.agreement.created', ['webhooks:manage'])).toBe(false);
    expect(verbAllowedByScopes('billing.commission.accrued', ['webhooks:manage'])).toBe(false);
  });

  it('deals:read открывает инвестиционные события', () => {
    expect(verbAllowedByScopes('investment.agreement.created', ['deals:read'])).toBe(true);
    expect(verbAllowedByScopes('investment.first_tranche.confirmed', ['deals:read'])).toBe(true);
  });

  it('graduates:read не открывает деньги, а deals:read — выпускников', () => {
    expect(verbAllowedByScopes('investment.agreement.created', ['graduates:read'])).toBe(false);
    expect(verbAllowedByScopes('lab.project.graduated', ['deals:read'])).toBe(false);
    expect(verbAllowedByScopes('lab.project.graduated', ['graduates:read'])).toBe(true);
  });

  it('внутренние события не открывает ни один скоуп', () => {
    const all = [
      'graduates:read',
      'passport:read',
      'listing:create',
      'deals:read',
      'show:read',
      'seasons:read',
      'webhooks:manage',
    ];
    for (const verb of [
      'identity.user.registered',
      'identity.login.failed',
      'security.new_login',
      'kyc.verification.decided',
      'admin.feature_flag.changed',
    ]) {
      expect(verbAllowedByScopes(verb, all), verb).toBe(false);
    }
  });

  it('пустой набор скоупов не открывает ничего', () => {
    expect(verbAllowedByScopes('lab.project.graduated', [])).toBe(false);
  });
});

/**
 * Согласие на публичный контур.
 *
 * Список раскрываемых полей до Ф50 был свободным текстом: пятьдесят строк по
 * 64 символа. Его читает медиаконтур и исполняет — значит он обязан быть
 * словарём, а не пересказом.
 */
describe('согласие на публикацию', () => {
  const base = {
    projectId: uuidv7(),
    scope: 'final_live' as const,
    documentVersion: 'v1',
  };

  it('поле вне словаря раскрытия не принимается', () => {
    const parsed = PublicationConsentRequestSchema.safeParse({
      ...base,
      disclosedFields: ['passport_scan'],
    });
    expect(parsed.success).toBe(false);
  });

  it('известные поля принимаются, пустой список — тоже', () => {
    // Позитивный контроль: отказ выше означает «слово не из словаря», а не
    // «схема отвергает любой список».
    expect(
      PublicationConsentRequestSchema.safeParse({
        ...base,
        disclosedFields: ['project_title', 'founder_photo'],
      }).success,
    ).toBe(true);
    // Пустой список — законное «снимать можно, данные проекта не раскрывать».
    expect(PublicationConsentRequestSchema.safeParse({ ...base, disclosedFields: [] }).success).toBe(
      true,
    );
  });

  it('неизвестная область согласия отвергается', () => {
    expect(
      PublicationConsentRequestSchema.safeParse({
        ...base,
        scope: 'everywhere',
        disclosedFields: [],
      }).success,
    ).toBe(false);
  });

  it('у обоих событий согласия есть схема полезной нагрузки', () => {
    // Реестр объявляет: verb без схемы не публикуется. Выдача согласия жила в
    // перечислении verb'ов без схемы — то есть по собственному правилу реестра
    // публикации не подлежала.
    expect(EVENT_PAYLOAD_SCHEMAS[EventVerb.CONSENT_PUBLICATION_GRANTED]).toBeDefined();
    expect(EVENT_PAYLOAD_SCHEMAS[EventVerb.CONSENT_PUBLICATION_REVOKED]).toBeDefined();
  });
});
