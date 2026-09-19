#!/usr/bin/env node
/**
 * Живой прогон сквозного сценария покупки запуска раунда (5.9.7).
 *
 * Проходит путь целиком: выбор пакета → оформление покупки → тестовое
 * подтверждение оплаты → выполнение услуг → открытие раунда. И проверяет
 * ровно те места, где сценарий мог бы соврать:
 *
 *   • замена требуемого пакета допустима только по ЯВНОМУ назначению
 *     администратора — ни цена, ни совпадение состава её не дают;
 *   • открыть платный раунд нельзя, пока покупка не оплачена и услуги по ней
 *     не выполнены; причина отказа называется словами;
 *   • тестовое подтверждение оплаты закрыто флагом и помечает покупку —
 *     обойти оплату им нельзя;
 *   • повторные запросы не создают вторую покупку;
 *   • сумма после покупки не выходит за условия оплаченного пакета.
 *
 * Денег не двигается: оплата подтверждается тестовым действием. Условия
 * страны и флаг возвращаются в исходное состояние даже при падении.
 *
 * Запуск: node scripts/smoke-round-purchase.mjs [--api http://127.0.0.1:4300]
 */
import { CORE_URL } from './lib/ports.mjs';
import { activePolicyConfig, restoreCountryPolicy } from './lib/country-policy.mjs';
import {
  CONSENTS,
  GRID,
  blindIndex,
  closeLeftoverPackages,
  codesFor,
  createProjectWithDraftRound,
  loadDotEnv,
  makePool,
} from './lib/round-pricing-fixture.mjs';

loadDotEnv();

const apiIndex = process.argv.indexOf('--api');
const BASE = apiIndex >= 0 ? process.argv[apiIndex + 1] : CORE_URL;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  OK    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.warn(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

const pool = makePool('unicorn-smoke-round-purchase');

async function sql(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    return { response, json };
  }
  async function json(path, init) {
    const { response, json: body } = await call(path, init);
    if (response.status >= 400) {
      throw new Error(
        `${init?.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`,
      );
    }
    return body;
  }
  return { call, json };
}

const suffix = `${Date.now() % 1e9}`;

async function register(role, tag) {
  const client = makeClient();
  const email = `pur-${tag}-${suffix}@test.local`;
  const password = `Pw-${crypto.randomUUID()}`;
  await client.json('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Тест ${tag}`,
      role,
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { client, email, password, userId: row?.id ?? null };
}

console.warn('\n=== ЖИВОЙ ПРОГОН: ПОКУПКА ЗАПУСКА РАУНДА ===\n');

const founder = await register('founder', 'f');
const adminUser = await register('founder', 'a');
await sql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
  [adminUser.userId],
);
const admin = makeClient();
await admin.json('/v1/auth/login', {
  method: 'POST',
  body: { email: adminUser.email, password: adminUser.password },
});

const codes = codesFor(suffix);
const originalPolicy = await activePolicyConfig(sql, 'ru');
const [flagBefore] = await sql(
  `SELECT enabled FROM audit.feature_flags WHERE key = 'billing.test_payment_confirmation'`,
);

try {
  await closeLeftoverPackages(sql);

  // Услуги прогона: обе выполняются вручную сотрудником, поэтому отметка
  // «выполнено» здесь — настоящая работа человека, а не фикция.
  for (const [code, name] of [
    [codes.svcBase, 'Проверка комплектности документов (прогон)'],
    [codes.svcExtra, 'Сверка реквизитов юрлица (прогон)'],
    [codes.svcOther, 'Разбор с экспертом (прогон)'],
  ]) {
    const service = await admin.json('/v1/admin/round-services', {
      method: 'POST',
      body: { code, name },
    });
    await admin.json(`/v1/admin/round-services/${service.id}`, {
      method: 'PATCH',
      body: { isImplemented: true, reason: 'прогон покупки: услуга выполняется вручную' },
    });
  }

  const required = await admin.json('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: codes.pkgSmall,
      countryCode: 'ru',
      name: 'Требуемый (прогон)',
      price: GRID.smallPrice,
      currency: 'RUB',
      minTarget: GRID.smallFrom,
      maxTarget: GRID.smallTo,
      serviceCodes: [codes.svcBase],
      reason: 'прогон покупки: требуемый пакет',
    },
  });
  const alternative = await admin.json('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: codes.pkgFull,
      countryCode: 'ru',
      name: 'Расширенный (прогон)',
      price: GRID.fullPrice,
      currency: 'RUB',
      minTarget: GRID.smallTo,
      maxTarget: GRID.fullTo,
      serviceCodes: [codes.svcBase, codes.svcExtra],
      reason: 'прогон покупки: разрешённая замена',
    },
  });
  const sideways = await admin.json('/v1/admin/round-packages', {
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
      reason: 'прогон покупки: не назначен заменой',
    },
  });
  await admin.json('/v1/admin/round-service-offers', {
    method: 'POST',
    body: {
      serviceCode: codes.svcOther,
      countryCode: 'ru',
      price: GRID.extraPrice,
      currency: 'RUB',
      reason: 'прогон покупки: цена докупки',
    },
  });

  // ------------------------------------------- явные альтернативы
  {
    const result = await admin.json('/v1/admin/round-packages/alternatives', {
      method: 'POST',
      body: {
        packageId: required.id,
        alternativeId: alternative.id,
        reason: 'прогон: расширенный пакет разрешён как замена',
      },
    });
    check('альтернатива назначена явно', result.warning === null, `${result.warning}`);
    const row = result.items.find((p) => p.code === codes.pkgSmall);
    check(
      'альтернатива видна в пакете',
      row?.alternatives?.some((a) => a.code === codes.pkgFull),
      JSON.stringify(row?.alternatives ?? []),
    );
  }
  {
    // «Особый» состава требуемого не покрывает: назначение проходит, но
    // администратор получает предупреждение.
    const result = await admin.json('/v1/admin/round-packages/alternatives', {
      method: 'POST',
      body: {
        packageId: required.id,
        alternativeId: sideways.id,
        reason: 'прогон: проверяем предупреждение о составе',
      },
    });
    check(
      'несовпадение состава — предупреждение, а не отказ',
      typeof result.warning === 'string' && result.warning.includes('не покрывает'),
      `${result.warning}`,
    );
    await admin.json('/v1/admin/round-packages/alternatives/remove', {
      method: 'POST',
      body: {
        packageId: required.id,
        alternativeId: sideways.id,
        reason: 'прогон: убрали лишнюю замену',
      },
    });
  }

  // ------------------------------------------------ платный режим
  await admin.json('/v1/admin/service-countries/ru/policies', {
    method: 'POST',
    body: {
      config: { ...originalPolicy, paidPackages: { enabled: true } },
      reason: 'прогон покупки: включены платные пакеты',
    },
  });

  const { roundId } = await createProjectWithDraftRound(founder.client, sql, suffix);
  console.warn(`  ·     черновик раунда на ${GRID.target} RUB создан`);

  // ---------------------------------------------- сохранение выбора
  {
    const notAllowed = await founder.client.json(
      `/v1/rounds/${roundId}/quote?packageCode=${codes.pkgSide}`,
    );
    check(
      'не назначенный заменой пакет расчёт отклоняет',
      notAllowed.mode === 'blocked' &&
        notAllowed.blockers[0]?.message.includes('не назначен допустимой заменой'),
      notAllowed.blockers[0]?.message,
    );
  }
  {
    await founder.client.json(`/v1/rounds/${roundId}/package-selection`, {
      method: 'PUT',
      body: { packageCode: codes.pkgFull, serviceCodes: [codes.svcOther] },
    });
    const quote = await founder.client.json(`/v1/rounds/${roundId}/quote`);
    check('сохранённый выбор не применяется к расчёту без параметров', quote.mode === 'priced');
    const saved = await sql(
      `SELECT package_code, service_codes FROM billing.round_package_selections WHERE round_id = $1`,
      [roundId],
    );
    check(
      'выбор сохранён и переживает перезагрузку',
      saved[0]?.package_code === codes.pkgFull && saved[0]?.service_codes?.includes(codes.svcOther),
      `${saved[0]?.package_code}`,
    );
  }

  // ------------------------------------------------ оформление покупки
  let purchase = await founder.client.json(`/v1/rounds/${roundId}/purchase`, { method: 'POST' });
  check('покупка оформлена', purchase.status === 'pending_payment', purchase.status);
  check(
    'пакет из сохранённого выбора',
    purchase.packageCode === codes.pkgFull,
    purchase.packageCode,
  );
  check('итог = замена плюс докупка', purchase.totalAmount === '47000.00', purchase.totalAmount);
  check('срок действия покупки без ограничения', purchase.validityDays === 0);
  check(
    'услуги пакета заведены отдельными позициями',
    purchase.items.filter((i) => i.kind === 'service').length >= 3,
    `${purchase.items.length} позиций`,
  );
  check(
    'все позиции ждут выполнения',
    purchase.items.every((i) => i.fulfillmentStatus === 'planned'),
  );
  {
    const again = await founder.client.json(`/v1/rounds/${roundId}/purchase`, { method: 'POST' });
    check('повторное оформление не создаёт вторую покупку', again.id === purchase.id);
  }

  // ------------------------------------------------ открыть нельзя
  const preview = await founder.client.json(`/v1/rounds/${roundId}/open-preview`);
  const openBody = {
    confirmDisclosureVersion: preview.activeFormVersion,
    contentDigest: preview.contentDigest,
  };
  {
    const { response, json } = await founder.client.call(`/v1/rounds/${roundId}/open`, {
      method: 'POST',
      body: openBody,
    });
    check('неоплаченная покупка раунд не открывает', response.status === 400, `${response.status}`);
    check(
      'причина названа: не оплачена',
      JSON.stringify(json?.errors ?? {}).includes('не оплачена'),
      JSON.stringify(json?.errors ?? {}).slice(0, 160),
    );
  }

  // ------------------------------------------------ тестовая оплата
  {
    const { response } = await admin.call(`/v1/admin/round-purchases/${purchase.id}/test-payment`, {
      method: 'POST',
    });
    // 503 — «функция выключена»: честный код для незажжённого флага.
    check('тестовая оплата закрыта флагом', response.status === 503, `статус ${response.status}`);
  }
  await sql(
    `UPDATE audit.feature_flags SET enabled = true WHERE key = 'billing.test_payment_confirmation'`,
  );
  {
    const { response } = await founder.client.call(
      `/v1/admin/round-purchases/${purchase.id}/test-payment`,
      { method: 'POST' },
    );
    check(
      'основатель сам себе оплату не подтверждает',
      response.status === 403,
      `${response.status}`,
    );
  }
  purchase = await admin.json(`/v1/admin/round-purchases/${purchase.id}/test-payment`, {
    method: 'POST',
  });
  check('оплата подтверждена тестом', purchase.status === 'paid', purchase.status);
  check('покупка помечена тестовой', purchase.isTestPayment === true);

  // ------------------------------------------------ услуги не выполнены
  {
    const { response, json } = await founder.client.call(`/v1/rounds/${roundId}/open`, {
      method: 'POST',
      body: openBody,
    });
    check(
      'без выполненных услуг раунд не открывается',
      response.status === 400,
      `${response.status}`,
    );
    check(
      'причина названа: услуги не выполнены',
      JSON.stringify(json?.errors ?? {}).includes('не выполнены'),
      JSON.stringify(json?.errors ?? {}).slice(0, 160),
    );
  }

  // ------------------------------------------------ выполнение услуг
  {
    const { response } = await admin.call(
      `/v1/admin/round-purchases/items/${purchase.items[0].id}/fulfillment`,
      { method: 'POST', body: { status: 'fulfilled', note: '' } },
    );
    check('отметка без основания отклонена', response.status === 400, `${response.status}`);
  }
  for (const item of purchase.items) {
    purchase = await admin.json(`/v1/admin/round-purchases/items/${item.id}/fulfillment`, {
      method: 'POST',
      body: { status: 'fulfilled', note: `выполнено сотрудником: ${item.title}` },
    });
  }
  check(
    'все позиции выполнены',
    purchase.items.every((i) => i.fulfillmentStatus === 'fulfilled'),
  );
  check(
    'препятствий к открытию не осталось',
    purchase.openBlocker === null,
    `${purchase.openBlocker}`,
  );

  // ------------------------------------------------ открытие
  await founder.client.json(`/v1/rounds/${roundId}/open`, { method: 'POST', body: openBody });
  const [round] = await sql(`SELECT status FROM lab.funding_rounds WHERE id = $1`, [roundId]);
  check('раунд открыт после выполнения условий', round?.status === 'open', `${round?.status}`);

  // --------------------------- сумма за пределами оплаченного пакета
  {
    // Купленный пакет — «Расширенный» (850–900 млн). Внутри его диапазона
    // сумму менять можно; за пределами — нет, пока доплата не согласована.
    const inside = await founder.client.call(`/v1/rounds/${roundId}`, {
      method: 'PATCH',
      body: { target: '880000000.00' },
    });
    check(
      'внутри диапазона оплаченного пакета сумма меняется',
      inside.response.status === 200,
      `${inside.response.status}`,
    );
    const { response, json } = await founder.client.call(`/v1/rounds/${roundId}`, {
      method: 'PATCH',
      body: { target: '950000000.00' },
    });
    check(
      'сумма сверх диапазона ОПЛАЧЕННОГО пакета отклонена',
      response.status === 400,
      `${response.status}`,
    );
    check(
      'отказ объясняет, что доплата не согласована',
      JSON.stringify(json?.errors ?? {}).includes('не согласованы'),
      JSON.stringify(json?.errors ?? {}).slice(0, 160),
    );
    const [still] = await sql(
      `SELECT status, target::text AS target FROM lab.funding_rounds WHERE id = $1`,
      [roundId],
    );
    check(
      'раунд и покупка сохранились',
      still?.status === 'open' && still?.target === '880000000.00',
      `${still?.status}, ${still?.target}`,
    );
  }
} finally {
  await sql(`UPDATE audit.feature_flags SET enabled = $1 WHERE key = $2`, [
    flagBefore?.enabled ?? false,
    'billing.test_payment_confirmation',
  ]);
  await restoreCountryPolicy(
    sql,
    'ru',
    originalPolicy,
    'прогон покупки: условия возвращены в исходное состояние',
  );
  await closeLeftoverPackages(sql);
}

console.warn(`\n  Итог: ${passed} OK, ${failed} FAIL\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
