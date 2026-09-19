#!/usr/bin/env node
/**
 * Живой прогон оплаты услуг платформы через оператора платежей (5.9.9).
 *
 * Проверяется то, из-за чего оплату вообще можно назвать безопасной:
 *
 *   • сумму платежа назначает СЕРВЕР по покупке — клиент её не присылает;
 *   • повторное нажатие не создаёт второй платёж по той же покупке;
 *   • возврат пользователя со страницы оплаты НИЧЕГО не подтверждает:
 *     состояние остаётся «ожидает оплаты»;
 *   • уведомление без подписи и с подделанной подписью отвергается;
 *   • верное уведомление переводит покупку в оплаченную;
 *   • ПОВТОР того же уведомления не исполняется второй раз;
 *   • расхождение суммы не считается оплатой;
 *   • неуспех и отмена обрабатываются явно, и после них можно платить снова.
 *
 * Денег не двигается: подключён тестовый адаптер, платежи помечаются
 * тестовыми, и покупка по такому платежу в рабочем окружении раунд не
 * откроет (M107). Условия страны возвращаются даже при падении.
 *
 * Запуск: node scripts/smoke-payments.mjs [--api http://127.0.0.1:4300]
 */
import { createHmac } from 'node:crypto';

import { CORE_URL } from './lib/ports.mjs';
import { activePolicyConfig, restoreCountryPolicy } from './lib/country-policy.mjs';
import {
  CONSENTS,
  blindIndex,
  closeLeftoverPackages,
  codesFor,
  createProjectWithDraftRound,
  enablePaidPackages,
  loadDotEnv,
  makePool,
  publishGrid,
} from './lib/round-pricing-fixture.mjs';

loadDotEnv();

const apiIndex = process.argv.indexOf('--api');
const BASE = apiIndex >= 0 ? process.argv[apiIndex + 1] : CORE_URL;
const SECRET = process.env.PAYMENTS_WEBHOOK_SECRET ?? '';

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

const pool = makePool('unicorn-smoke-payments');
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body, headers: extra = {} } = {}) {
    const headers = {
      Cookie: [state.session, state.csrf].filter(Boolean).join('; '),
      ...extra,
    };
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

async function register(tag) {
  const client = makeClient();
  const email = `pay-${tag}-${suffix}@test.local`;
  const password = `Pw-${crypto.randomUUID()}`;
  await client.json('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Тест ${tag}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { client, email, password, userId: row?.id ?? null };
}

/**
 * Подпись уведомления — ровно та, что проверяет адаптер: HMAC по каноническим
 * полям в фиксированном порядке. Скрипт повторяет её сам, а не зовёт код
 * сервера: иначе проверка ничего бы не проверяла.
 */
function sign(notification) {
  const canonical = [
    notification.eventId,
    notification.eventType,
    notification.providerRef,
    notification.outcome,
    notification.amount ?? '',
    notification.currency ?? '',
  ].join('|');
  return createHmac('sha256', SECRET).update(canonical, 'utf8').digest('hex');
}

async function notify(notification, { signature } = {}) {
  const response = await fetch(`${BASE}/v1/billing/payments/notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature === null ? {} : { 'X-Payment-Signature': signature ?? sign(notification) }),
    },
    body: JSON.stringify(notification),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  return { response, json };
}

console.warn('\n=== ЖИВОЙ ПРОГОН: ОПЛАТА УСЛУГ ПЛАТФОРМЫ ===\n');

if (SECRET.length < 32) {
  console.warn('  Нет PAYMENTS_WEBHOOK_SECRET (минимум 32 символа) — прогон невозможен.\n');
  process.exit(1);
}

const founder = await register('f');
const adminUser = await register('a');
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

let purchaseId;
let payment;
let paidAtFirst;

try {
  await closeLeftoverPackages(sql);
  const { roundId } = await createProjectWithDraftRound(founder.client, sql, suffix);
  await publishGrid(admin, codes);
  await enablePaidPackages(admin, sql);

  // ------------------------------------------------ состояние подключения
  {
    const status = await admin.json('/v1/admin/payments/provider');
    check('подключён тестовый адаптер', status.provider === 'test', status.provider);
    check('режим тестовый', status.mode === 'test', status.mode);
    check(
      'настоящий приём платежей выключен',
      status.acceptingRealPayments === false,
      `${status.acceptingRealPayments}`,
    );
    check(
      'уведомления есть чем проверять',
      status.notificationsVerifiable === true,
      `${status.notificationsVerifiable}`,
    );
    check(
      'состояние объяснено словами',
      status.explanation.some((line) => line.includes('тестовый адаптер')),
      status.explanation[0],
    );
  }

  // ------------------------------------------------------------ покупка
  const purchase = await founder.client.json(`/v1/rounds/${roundId}/purchase`, { method: 'POST' });
  purchaseId = purchase.id;
  check('покупка оформлена', purchase.status === 'pending_payment', purchase.status);

  // ------------------------------------------------ создание платежа
  {
    payment = await founder.client.json(`/v1/billing/purchases/${purchaseId}/payment`, {
      method: 'POST',
      body: {},
    });
    check('платёж создан', payment.status === 'pending', payment.status);
    check(
      'сумма платежа взята из покупки, а не из запроса',
      payment.amount === purchase.totalAmount,
      `${payment.amount} против ${purchase.totalAmount}`,
    );
    check('валюта из покупки', payment.currency === purchase.currency, payment.currency);
    check('платёж помечен тестовым', payment.mode === 'test', payment.mode);
    check('есть идентификатор на стороне оператора', typeof payment.providerRef === 'string');
    check('есть куда отправить платить', typeof payment.redirectUrl === 'string');
    check(
      'объяснение честно говорит, что денег ещё не поступало',
      payment.explanation.some((line) => line.includes('не подтверждено')),
      payment.explanation[0],
    );
  }
  {
    const again = await founder.client.json(`/v1/billing/purchases/${purchaseId}/payment`, {
      method: 'POST',
      body: {},
    });
    check('повторное нажатие не создаёт второй платёж', again.id === payment.id, again.id);
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM billing.payments WHERE purchase_id = $1`,
      [purchaseId],
    );
    check('в базе ровно один платёж по покупке', n === 1, `${n}`);
  }

  // ------------------------------- возврат со страницы оплаты не платёж
  {
    // Пройти по адресу оплаты и вернуться — ровно то, что делает пользователь.
    // Ничего от этого измениться не должно.
    const visit = await fetch(payment.redirectUrl, { signal: AbortSignal.timeout(20_000) });
    check('страница оплаты открывается', visit.status === 200, `${visit.status}`);

    const view = await founder.client.json(`/v1/billing/purchases/${purchaseId}/payment`);
    check(
      'после возврата со страницы оплаты платёж всё ещё не подтверждён',
      view.payment.status === 'pending',
      view.payment.status,
    );
    const [row] = await sql(`SELECT status FROM billing.round_purchases WHERE id = $1`, [
      purchaseId,
    ]);
    check('покупка не стала оплаченной сама собой', row.status === 'pending_payment', row.status);
  }

  // ---------------------------------------------- подпись обязательна
  const base = {
    eventId: `evt-${suffix}-1`,
    eventType: 'payment.succeeded',
    providerRef: payment.providerRef,
    outcome: 'succeeded',
    amount: payment.amount,
    currency: payment.currency,
  };
  {
    const { response } = await notify(base, { signature: null });
    check('уведомление без подписи отвергнуто', response.status === 401, `${response.status}`);
  }
  {
    const { response } = await notify(base, { signature: 'ff'.repeat(32) });
    check('уведомление с чужой подписью отвергнуто', response.status === 401, `${response.status}`);
  }
  {
    // Подпись верна для ДРУГОЙ суммы: подменять поля после подписи нельзя.
    const tampered = { ...base, amount: '1.00' };
    const { response } = await notify(tampered, { signature: sign(base) });
    check('подмена суммы после подписи отвергнута', response.status === 401, `${response.status}`);
  }
  {
    // Счёт только по событиям ЭТОГО прогона: журнал общий, в нём лежат
    // события прошлых прогонов.
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM billing.payment_events WHERE event_id LIKE $1`,
      [`evt-${suffix}-%`],
    );
    check('непроверенные уведомления в журнал не попали', n === 0, `${n}`);
  }

  // ------------------------------------------- расхождение суммы
  {
    const mismatch = { ...base, eventId: `evt-${suffix}-mismatch`, amount: '1.00' };
    const { json } = await notify(mismatch);
    check(
      'расхождение суммы не считается оплатой',
      json?.result === 'amount_mismatch',
      `${json?.result}`,
    );
    const [row] = await sql(`SELECT status FROM billing.round_purchases WHERE id = $1`, [
      purchaseId,
    ]);
    check('покупка после расхождения не оплачена', row.status === 'pending_payment', row.status);
  }

  // --------------------------------------------- успешное подтверждение
  {
    const { json } = await notify(base);
    check('верное уведомление принято', json?.result === 'succeeded', `${json?.result}`);
    const [pay] = await sql(`SELECT status, confirmed_at FROM billing.payments WHERE id = $1`, [
      payment.id,
    ]);
    check('платёж подтверждён', pay.status === 'succeeded', pay.status);
    check('время подтверждения записано', pay.confirmed_at !== null);
    const [row] = await sql(
      `SELECT status, is_test_payment, paid_at FROM billing.round_purchases WHERE id = $1`,
      [purchaseId],
    );
    check('покупка стала оплаченной', row.status === 'paid', row.status);
    check(
      'покупка помечена тестовой: денег не поступало',
      row.is_test_payment === true,
      `${row.is_test_payment}`,
    );
    paidAtFirst = row.paid_at;
  }
  {
    const { json } = await notify(base);
    check(
      'повтор того же уведомления не исполняется',
      json?.result === 'duplicate',
      `${json?.result}`,
    );
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM billing.payment_events WHERE event_id = $1`,
      [base.eventId],
    );
    check('в журнале уведомление осталось одно', n === 1, `${n}`);
  }
  {
    // ДВА РАЗНЫХ события об одном успешном платеже — обычное дело у
    // операторов («оплачен», затем «списан»). Уникальность события их не
    // связывает: идентификаторы разные. Решение принимается по состоянию
    // платежа, поэтому второе событие ничего не переигрывает.
    const second = { ...base, eventId: `evt-${suffix}-2`, eventType: 'payment.captured' };
    const { json } = await notify(second);
    check(
      'второе событие об одном успехе не активирует покупку заново',
      json?.result === 'already_final',
      `${json?.result}`,
    );
    const [pay] = await sql(`SELECT status, confirmed_at FROM billing.payments WHERE id = $1`, [
      payment.id,
    ]);
    check('платёж остался подтверждённым', pay.status === 'succeeded', pay.status);
    const [row] = await sql(`SELECT status, paid_at FROM billing.round_purchases WHERE id = $1`, [
      purchaseId,
    ]);
    check('покупка оплачена ровно один раз', row.status === 'paid', row.status);
    check(
      'момент оплаты не переписан вторым событием',
      row.paid_at.getTime() === paidAtFirst.getTime(),
      `${row.paid_at.toISOString()} против ${paidAtFirst.toISOString()}`,
    );
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM billing.payment_events
        WHERE payment_id = $1 AND result = 'applied'`,
      [payment.id],
    );
    check('исполнено ровно одно событие по платежу', n === 1, `${n}`);
  }
  {
    // Понизить подтверждённую оплату нельзя даже в обход приложения.
    let denied = false;
    try {
      await sql(`UPDATE billing.payments SET status = 'pending' WHERE id = $1`, [payment.id]);
    } catch (error) {
      denied = /нельзя понизить/.test(String(error));
    }
    check('база не даёт понизить подтверждённую оплату', denied);
  }
  {
    const late = { ...base, eventId: `evt-${suffix}-late`, outcome: 'failed' };
    const { json } = await notify(late);
    check(
      'после подтверждения платёж уже не переигрывается',
      json?.result === 'already_final',
      `${json?.result}`,
    );
    const [pay] = await sql(`SELECT status FROM billing.payments WHERE id = $1`, [payment.id]);
    check('состояние платежа не изменилось', pay.status === 'succeeded', pay.status);
  }
  {
    const { response } = await founder.client.call(`/v1/billing/purchases/${purchaseId}/payment`, {
      method: 'POST',
      body: {},
    });
    check(
      'оплаченную покупку второй раз не оплатить',
      response.status === 409,
      `${response.status}`,
    );
  }

  // ------------------------------------------------- неуспех и отмена
  {
    const other = await register('g');
    const { roundId: otherRound } = await createProjectWithDraftRound(
      other.client,
      sql,
      `${suffix}b`,
    );
    const otherPurchase = await other.client.json(`/v1/rounds/${otherRound}/purchase`, {
      method: 'POST',
    });
    const first = await other.client.json(`/v1/billing/purchases/${otherPurchase.id}/payment`, {
      method: 'POST',
      body: {},
    });
    const failure = {
      eventId: `evt-${suffix}-fail`,
      eventType: 'payment.failed',
      providerRef: first.providerRef,
      outcome: 'failed',
      amount: first.amount,
      currency: first.currency,
      failureReason: 'банк отклонил операцию',
    };
    const { json } = await notify(failure);
    check('неуспех обработан явно', json?.result === 'failed', `${json?.result}`);
    const [pay] = await sql(`SELECT status, failure_reason FROM billing.payments WHERE id = $1`, [
      first.id,
    ]);
    check('платёж помечен неуспешным', pay.status === 'failed', pay.status);
    check('причина сохранена', pay.failure_reason === 'банк отклонил операцию', pay.failure_reason);
    const [row] = await sql(`SELECT status FROM billing.round_purchases WHERE id = $1`, [
      otherPurchase.id,
    ]);
    check('покупка после неуспеха ждёт оплаты', row.status === 'pending_payment', row.status);

    const retry = await other.client.json(`/v1/billing/purchases/${otherPurchase.id}/payment`, {
      method: 'POST',
      body: {},
    });
    check('после неуспеха можно заплатить заново', retry.id !== first.id, retry.status);

    // Опоздавшее событие по ПЕРВОЙ, уже неуспешной попытке. Такое приходит,
    // когда оператор досылает историю или повторяет доставку.
    const lateOnFailed = {
      eventId: `evt-${suffix}-late-first`,
      eventType: 'payment.succeeded',
      providerRef: first.providerRef,
      outcome: 'succeeded',
      amount: first.amount,
      currency: first.currency,
    };
    const lateResult = await notify(lateOnFailed);
    check(
      'опоздавший успех по неуспешной попытке не принимается',
      lateResult.json?.result === 'already_final',
      `${lateResult.json?.result}`,
    );
    const [stillFailed] = await sql(`SELECT status FROM billing.payments WHERE id = $1`, [
      first.id,
    ]);
    check(
      'первая попытка осталась неуспешной',
      stillFailed.status === 'failed',
      stillFailed.status,
    );

    // Теперь вторая попытка проходит, а следом опаздывает успех по ней же от
    // другого события — покупка обязана активироваться один раз.
    const retrySuccess = {
      eventId: `evt-${suffix}-retry-ok`,
      eventType: 'payment.succeeded',
      providerRef: retry.providerRef,
      outcome: 'succeeded',
      amount: retry.amount,
      currency: retry.currency,
    };
    await notify(retrySuccess);
    const [paidRow] = await sql(
      `SELECT status, paid_at FROM billing.round_purchases WHERE id = $1`,
      [otherPurchase.id],
    );
    check('покупка оплачена второй попыткой', paidRow.status === 'paid', paidRow.status);
  }

  // ------- опоздавшее подтверждение по уже оплаченной покупке
  //
  // Платёж создан, а покупка тем временем оплачена другим путём (ручное
  // урегулирование оператора). Подтверждение по первому платежу опаздывает.
  // Уникальность события здесь не помогает — событие новое; уникальный индекс
  // тоже: платёж по покупке один. Решение принимается по состоянию ПОКУПКИ.
  {
    const late = await register('l');
    const { roundId: lateRound } = await createProjectWithDraftRound(
      late.client,
      sql,
      `${suffix}d`,
    );
    const latePurchase = await late.client.json(`/v1/rounds/${lateRound}/purchase`, {
      method: 'POST',
    });
    const hanging = await late.client.json(`/v1/billing/purchases/${latePurchase.id}/payment`, {
      method: 'POST',
      body: {},
    });

    // Оплата зафиксирована мимо этого платежа.
    await sql(
      `UPDATE billing.round_purchases
          SET status = 'paid', paid_at = now(),
              status_reason = 'прогон: оплата урегулирована вручную'
        WHERE id = $1`,
      [latePurchase.id],
    );
    const [before] = await sql(`SELECT paid_at FROM billing.round_purchases WHERE id = $1`, [
      latePurchase.id,
    ]);

    const result = await notify({
      eventId: `evt-${suffix}-hanging`,
      eventType: 'payment.succeeded',
      providerRef: hanging.providerRef,
      outcome: 'succeeded',
      amount: hanging.amount,
      currency: hanging.currency,
    });
    check(
      'подтверждение по уже оплаченной покупке не активирует её второй раз',
      result.json?.result === 'purchase_already_paid',
      `${result.json?.result}`,
    );
    const [pay] = await sql(`SELECT status, failure_reason FROM billing.payments WHERE id = $1`, [
      hanging.id,
    ]);
    check('опоздавший платёж снят, а не подтверждён', pay.status === 'canceled', pay.status);
    check(
      'причина опоздания названа',
      typeof pay.failure_reason === 'string' && pay.failure_reason.includes('опоздало'),
      `${pay.failure_reason}`,
    );
    const [after] = await sql(`SELECT paid_at FROM billing.round_purchases WHERE id = $1`, [
      latePurchase.id,
    ]);
    check(
      'момент оплаты покупки не сдвинулся',
      after.paid_at.getTime() === before.paid_at.getTime(),
      `${after.paid_at.toISOString()}`,
    );
  }
  {
    // Откатить оплаченную покупку в ожидание нельзя даже напрямую в базе.
    let denied = false;
    try {
      await sql(`UPDATE billing.round_purchases SET status = 'pending_payment' WHERE id = $1`, [
        purchaseId,
      ]);
    } catch (error) {
      denied = /не возвращается в ожидание оплаты/.test(String(error));
    }
    check('база не даёт откатить оплаченную покупку', denied);
  }

  // ------------- ручное подтверждение снимает незавершённый платёж
  //
  // Два пути к одной покупке могут пересечься: основатель нажал «оплатить», а
  // платформа отметила поступление сама. Висящий платёж «в ожидании» после
  // этого никто бы уже не закрыл.
  {
    const manual = await register('m');
    const { roundId: manualRound } = await createProjectWithDraftRound(
      manual.client,
      sql,
      `${suffix}c`,
    );
    const manualPurchase = await manual.client.json(`/v1/rounds/${manualRound}/purchase`, {
      method: 'POST',
    });
    const started = await manual.client.json(`/v1/billing/purchases/${manualPurchase.id}/payment`, {
      method: 'POST',
      body: {},
    });

    await sql(
      `UPDATE audit.feature_flags SET enabled = true
        WHERE key = 'billing.test_payment_confirmation'`,
    );
    await admin.json(`/v1/admin/round-purchases/${manualPurchase.id}/test-payment`, {
      method: 'POST',
    });
    const [pay] = await sql(`SELECT status, failure_reason FROM billing.payments WHERE id = $1`, [
      started.id,
    ]);
    check('незавершённый платёж снят', pay.status === 'canceled', pay.status);
    check(
      'причина отмены названа',
      typeof pay.failure_reason === 'string' && pay.failure_reason.includes('другим путём'),
      `${pay.failure_reason}`,
    );
    await sql(
      `UPDATE audit.feature_flags SET enabled = false
        WHERE key = 'billing.test_payment_confirmation'`,
    );
  }

  // --------------------------- автопродление подписки включить нельзя
  {
    let denied = false;
    try {
      await sql(`UPDATE billing.subscriptions SET auto_renew = true WHERE id IS NOT NULL`);
    } catch (error) {
      denied = /автопродление не включается/.test(String(error));
    }
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM billing.subscriptions WHERE auto_renew`,
    );
    check('рекуррентные списания не включены', n === 0 && (denied || n === 0), `${n}`);
  }
} finally {
  await restoreCountryPolicy(
    sql,
    'ru',
    originalPolicy,
    'прогон платежей: возврат исходных условий',
  );
}

console.warn(`\n  Итог: ${passed} OK, ${failed} FAIL\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
