#!/usr/bin/env node
/**
 * Живой прогон исполнения услуги ИИ-разбора по позиции покупки (6.1).
 *
 * Проверяется то, ради чего услуга вообще продаётся: что её действительно
 * выполняют, а не закрывают галочкой.
 *
 *   • услугу платформы НЕЛЬЗЯ отметить выполненной руками — ни через API, ни
 *     напрямую в базе;
 *   • разбор запускается по конкретной оплаченной позиции;
 *   • прогон фиксирует версию заявки и отпечаток входа;
 *   • услуга закрывается только после сохранённого результата;
 *   • повторный запрос не создаёт второго исполнения;
 *   • правка заявки после разбора помечает отчёт как относящийся к прошлой
 *     версии, но не отменяет его;
 *   • отказ, когда контур ИИ не готов, называет причину.
 *
 * Требует запущенного AI-шлюза (порт 8100): node scripts/dev-ai-gateway.mjs
 * Разбор идёт БЕЗ языковой модели (флаг ai.scoring.llm.enabled выключен) —
 * это настоящий расчёт по правилам, а не заглушка.
 *
 * Запуск: node scripts/smoke-service-execution.mjs
 */
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

const BASE = CORE_URL;

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

const pool = makePool('unicorn-smoke-service-execution');
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

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
      signal: AbortSignal.timeout(60_000),
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
  const email = `run-${tag}-${suffix}@test.local`;
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

console.warn('\n=== ЖИВОЙ ПРОГОН: ИСПОЛНЕНИЕ УСЛУГИ ИИ-РАЗБОРА ===\n');

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
const [scoringBefore] = await sql(
  `SELECT enabled FROM audit.feature_flags WHERE key = 'ai.scoring.enabled'`,
);

try {
  await closeLeftoverPackages(sql);
  const { roundId, project } = await createProjectWithDraftRound(founder.client, sql, suffix);
  const projectId = project.id;
  await publishGrid(admin, codes);

  // Услуга разбора: выполняет ПЛАТФОРМА, а не сотрудник.
  const [svc] = await sql(`SELECT id FROM billing.round_services WHERE code = $1`, [codes.svcBase]);
  await admin.json(`/v1/admin/round-services/${svc.id}`, {
    method: 'PATCH',
    body: {
      executionKind: 'rules_analysis',
      reason: 'прогон 6.1: услугу выполняет платформа',
    },
  });
  {
    const services = await admin.json('/v1/admin/round-services');
    const found = services.items.find((s) => s.code === codes.svcBase);
    check(
      'услуга помечена разбором по правилам',
      found?.executionKind === 'rules_analysis',
      `${found?.executionKind}`,
    );
  }

  // ------ услуга с обещанием ИИ-анализа не продаётся, пока её нечем выполнить
  {
    const created = await admin.json('/v1/admin/round-services', {
      method: 'POST',
      body: { code: `${codes.svcOther}_llm`, name: 'ИИ-анализ заявки (прогон)' },
    });
    const { response, json } = await admin.call(`/v1/admin/round-services/${created.id}`, {
      method: 'PATCH',
      body: {
        executionKind: 'llm_analysis',
        isImplemented: true,
        reason: 'прогон: попытка продать ИИ-анализ без модели',
      },
    });
    check(
      'услугу с обещанием ИИ-анализа нельзя пометить реализованной',
      response.status >= 400,
      `${response.status}`,
    );
    check(
      'отказ называет, чего не хватает',
      JSON.stringify(json).includes('ключ провайдера'),
      JSON.stringify(json?.errors ?? json?.detail ?? json).slice(0, 140),
    );
  }

  await enablePaidPackages(admin, sql);
  const purchase = await founder.client.json(`/v1/rounds/${roundId}/purchase`, { method: 'POST' });
  const aiItem = purchase.items.find((i) => i.serviceCode === codes.svcBase);
  check('позиция услуги разбора есть в покупке', aiItem !== undefined, `${aiItem?.title}`);

  // -------------------------------------- до оплаты запускать нечего
  {
    const { json } = await founder.client.call(`/v1/billing/purchases/items/${aiItem.id}/run`, {
      method: 'POST',
    });
    check(
      'до оплаты разбор не запускается',
      JSON.stringify(json).includes('не оплачена'),
      JSON.stringify(json?.detail ?? json).slice(0, 120),
    );
  }

  // -------------------------------------------------------- оплата
  await sql(
    `UPDATE audit.feature_flags SET enabled = true WHERE key = 'billing.test_payment_confirmation'`,
  );
  await admin.json(`/v1/admin/round-purchases/${purchase.id}/test-payment`, { method: 'POST' });
  await sql(
    `UPDATE audit.feature_flags SET enabled = false WHERE key = 'billing.test_payment_confirmation'`,
  );

  // ------------------- отметить услугу платформы руками нельзя
  {
    const { response, json } = await admin.call(
      `/v1/admin/round-purchases/items/${aiItem.id}/fulfillment`,
      { method: 'POST', body: { status: 'fulfilled', note: 'прогон: попытка закрыть галочкой' } },
    );
    check(
      'услугу платформы нельзя закрыть отметкой через API',
      response.status >= 400,
      `${response.status}`,
    );
    check(
      'отказ объясняет, что нужен разбор',
      JSON.stringify(json).includes('после успешного разбора'),
      JSON.stringify(json?.errors ?? json?.detail ?? json).slice(0, 140),
    );
  }
  {
    let denied = false;
    try {
      await sql(
        `UPDATE billing.round_purchase_items
            SET fulfillment_status = 'fulfilled', fulfillment_note = 'напрямую в базе'
          WHERE id = $1`,
        [aiItem.id],
      );
    } catch (error) {
      denied = /после успешного разбора/.test(String(error));
    }
    check('и напрямую в базе тоже нельзя', denied);
  }

  // ------------------------------------------------ запуск разбора
  let run = null;
  {
    const { response, json } = await founder.client.call(
      `/v1/billing/purchases/items/${aiItem.id}/run`,
      { method: 'POST' },
    );
    if (response.status >= 400) {
      check(
        'если контур ИИ не готов — отказ называет причину',
        JSON.stringify(json).length > 0,
        JSON.stringify(json?.detail ?? json).slice(0, 200),
      );
      throw new Error(`разбор не запустился: ${JSON.stringify(json?.detail ?? json)}`);
    }
    run = json;
    check('разбор завершился успехом', run.status === 'succeeded', `${run.status}`);
    check(
      'разбор выполнен без языковой модели и назван честно',
      run.engine === 'heuristic' &&
        run.explanation.some((line) => line.includes('без языковой модели')),
      `${run.engine}`,
    );
    check('исполнение не помечено тестовым', run.isTest === false);
    check('результат сохранён', typeof run.resultRef === 'string', `${run.resultRef}`);
    check('отпечаток входа зафиксирован', /^[0-9a-f]{64}$/.test(run.inputSha256 ?? ''));
    check('версия заявки зафиксирована', run.inputVersionNo !== null, `№${run.inputVersionNo}`);
    check(
      'ответы анкеты участвовали в разборе',
      run.includesAnswers === true,
      `${run.includesAnswers}`,
    );
    check(
      'род заказанного разбора записан',
      run.requiredKind === 'rules_analysis',
      `${run.requiredKind}`,
    );
    check(
      'отчёт назван анализом ответов поданной версии',
      run.explanation.some((line) => line.includes('по ответам поданной версии')),
      run.explanation.join(' | ').slice(0, 140),
    );
    check(
      'объяснение говорит, что отчёт не даёт одобрения',
      run.explanation.some((line) => line.includes('не означает одобрения')),
      run.explanation.at(-1),
    );
  }
  {
    const [item] = await sql(
      `SELECT fulfillment_status, fulfillment_note FROM billing.round_purchase_items
        WHERE id = $1`,
      [aiItem.id],
    );
    check(
      'услуга закрыта результатом',
      item.fulfillment_status === 'fulfilled',
      item.fulfillment_status,
    );
    check(
      'в основании отметки назван разбор',
      item.fulfillment_note.includes('разбор выполнен платформой'),
      item.fulfillment_note,
    );
  }

  // ------------------ происхождение хранится в САМОМ паспорте
  {
    const [passport] = await sql(
      `SELECT project_version_id, input_sha256, includes_answers, input_sources
         FROM scoring.investment_passports WHERE id = $1`,
      [run.resultRef],
    );
    check(
      'паспорт несёт версию заявки',
      passport?.project_version_id === run.inputVersionId,
      `${passport?.project_version_id}`,
    );
    check(
      'паспорт несёт отпечаток входа',
      passport?.input_sha256 === run.inputSha256,
      `${passport?.input_sha256}`.slice(0, 16),
    );
    check('паспорт помечен как сделанный по ответам', passport?.includes_answers === true);
    check(
      'источник каждого поля записан',
      passport?.input_sources?.title === 'version' && passport?.input_sources?.taxonomy === 'card',
      JSON.stringify(passport?.input_sources ?? {}).slice(0, 120),
    );
    check(
      'поле без источника помечено absent, а не выдумано',
      passport?.input_sources?.launchCountry === 'absent',
      `${passport?.input_sources?.launchCountry}`,
    );
  }
  {
    // Текст, ушедший в разбор, содержит вопросы и ответы.
    const [checkpoint] = await sql(
      `SELECT state_jsonb FROM audit.node_checkpoints
        WHERE node_name = 'input_snapshot'
          AND state_jsonb->>'inputSha256' = $1 LIMIT 1`,
      [run.inputSha256],
    );
    const snapshot = checkpoint?.state_jsonb?.snapshot ?? {};
    // Текст собран парами «вопрос — ответ» по разделам: проверяем, что в нём
    // есть и раздел, и формулировка первого вопроса, и сам ответ.
    const first = snapshot.answers?.[0];
    check(
      'в текст заявки вошли разделы, формулировки вопросов и ответы',
      typeof snapshot.summary === 'string' &&
        snapshot.summary.includes('## ') &&
        snapshot.summary.includes(first?.question ?? ' ') &&
        snapshot.summary.includes(first?.text ?? ' '),
      `${snapshot.summary}`.slice(0, 90),
    );
    check(
      'ответы перечислены отдельным списком',
      Array.isArray(snapshot.answers) && snapshot.answers.length > 0,
      `${snapshot.answers?.length}`,
    );
    check(
      'метаданные содержат поля из снимка',
      snapshot.metadata && 'useOfFunds' in snapshot.metadata && 'businessType' in snapshot.metadata,
      Object.keys(snapshot.metadata ?? {}).join(','),
    );
  }

  // -------------------------------- повтор не создаёт второго исполнения
  {
    const again = await founder.client.json(`/v1/billing/purchases/items/${aiItem.id}/run`, {
      method: 'POST',
    });
    check('повторный запуск возвращает тот же прогон', again.id === run.id, again.id);
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM billing.purchase_item_runs WHERE item_id = $1`,
      [aiItem.id],
    );
    check('второго исполнения не появилось', n === 1, `${n}`);
  }
  {
    // Второй успешный прогон по той же позиции запрещён и на уровне данных.
    let denied = false;
    try {
      await sql(
        `INSERT INTO billing.purchase_item_runs
           (id, item_id, purchase_id, project_id, kind, status, input_sha256, result_ref,
            result_kind, engine)
         SELECT public.uuid_generate_v7(), r.item_id, r.purchase_id, r.project_id, 'ai_analysis',
                'succeeded', r.input_sha256, r.result_ref, 'passport', 'heuristic'
           FROM billing.purchase_item_runs r WHERE r.id = $1`,
        [run.id],
      );
    } catch (error) {
      denied = /purchase_item_runs_done/.test(String(error));
    }
    check('база не допускает второго успешного прогона по позиции', denied);
  }
  {
    // Завершённый прогон не переигрывается.
    let denied = false;
    try {
      await sql(`UPDATE billing.purchase_item_runs SET status = 'running' WHERE id = $1`, [run.id]);
    } catch (error) {
      denied = /не переигрывается/.test(String(error));
    }
    check('завершённый прогон не переигрывается', denied);
  }

  // ------------------ правка заявки: отчёт остаётся отчётом о прошлом
  {
    // Правка идёт ЧЕРЕЗ ИНТЕРФЕЙС основателя, а не запросом в базу: так
    // проверяется настоящий путь, а не выдуманное состояние.
    await founder.client.json(`/v1/projects/${projectId}`, {
      method: 'PATCH',
      body: { tagline: `Уточнение после разбора ${suffix}` },
    });
    const list = await founder.client.json(`/v1/billing/purchases/${purchase.id}/service-runs`);
    const found = list.items.find((i) => i.itemId === aiItem.id);
    check(
      'после правки заявки отчёт помечен как относящийся к прошлой версии',
      found?.run?.inputChangedSince === true,
      `${found?.run?.inputChangedSince}`,
    );
    check(
      'и это сказано словами',
      found?.run?.explanation.some((line) => line.includes('заявка изменилась')),
      found?.run?.explanation.join(' | ').slice(0, 160),
    );
    check(
      'повторно запустить разбор всё равно нельзя: услуга оплачена один раз',
      found?.canStart === false && found?.blocker?.includes('уже выполнен'),
      `${found?.blocker}`,
    );
  }

  // -------------------- выключенный контур отказывает с причиной
  {
    const other = await register('o');
    const { roundId: otherRound } = await createProjectWithDraftRound(
      other.client,
      sql,
      `${suffix}b`,
    );
    const otherPurchase = await other.client.json(`/v1/rounds/${otherRound}/purchase`, {
      method: 'POST',
    });
    const otherItem = otherPurchase.items.find((i) => i.serviceCode === codes.svcBase);
    await sql(
      `UPDATE audit.feature_flags SET enabled = true WHERE key = 'billing.test_payment_confirmation'`,
    );
    await admin.json(`/v1/admin/round-purchases/${otherPurchase.id}/test-payment`, {
      method: 'POST',
    });
    await sql(
      `UPDATE audit.feature_flags SET enabled = false WHERE key = 'billing.test_payment_confirmation'`,
    );

    await sql(`UPDATE audit.feature_flags SET enabled = false WHERE key = 'ai.scoring.enabled'`);
    const { response, json } = await other.client.call(
      `/v1/billing/purchases/items/${otherItem.id}/run`,
      { method: 'POST' },
    );
    check('выключенный контур не запускает разбор', response.status >= 400, `${response.status}`);
    check(
      'отказ называет ИМЕННО причину',
      JSON.stringify(json).includes('ai.scoring.enabled'),
      JSON.stringify(json?.detail ?? json).slice(0, 160),
    );
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM billing.purchase_item_runs WHERE item_id = $1`,
      [otherItem.id],
    );
    check('запись о прогоне не создавалась', n === 0, `${n}`);
    await sql(`UPDATE audit.feature_flags SET enabled = $1 WHERE key = 'ai.scoring.enabled'`, [
      scoringBefore?.enabled ?? true,
    ]);
  }
} finally {
  await sql(`UPDATE audit.feature_flags SET enabled = $1 WHERE key = 'ai.scoring.enabled'`, [
    scoringBefore?.enabled ?? true,
  ]);
  await restoreCountryPolicy(sql, 'ru', originalPolicy, 'прогон 6.1: возврат исходных условий');
}

console.warn(`\n  Итог: ${passed} OK, ${failed} FAIL\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
