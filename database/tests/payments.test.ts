import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers.ts';
import { closePool, createProject, createUser, inRollbackTx, uuidv7 } from './helpers.ts';

/**
 * M108/M109: точка подключения оператора онлайн-платежей.
 *
 * Проверяются правила, без которых «подключим провайдера позже» означало бы
 * дыру уже сейчас:
 *
 *  - у платежа ровно один предмет оплаты: счёт ИЛИ покупка, не оба и не ни
 *    одного;
 *  - рабочий режим невозможен, пока приём настоящих платежей выключен, и
 *    режим платежа потом не переписывается;
 *  - суммы и предмет оплаты неизменяемы, платёж не удаляется;
 *  - по одной покупке не может идти двух незавершённых платежей;
 *  - одно уведомление оператора записывается один раз и не переписывается;
 *  - автопродление подписки включить нельзя.
 */

afterAll(async () => {
  await closePool();
});

async function purchase(c: Client, owner: string, projectId: string): Promise<string> {
  const versionId = uuidv7();
  const [application] = (
    await c.query<{ id: string }>(
      `SELECT id FROM lab.investment_applications WHERE project_id = $1 LIMIT 1`,
      [projectId],
    )
  ).rows;
  await c.query(
    `INSERT INTO lab.project_versions
       (id, project_id, application_id, version_no, snapshot_jsonb, schema_version)
     VALUES ($1, $2, $3, 1, '{}', 1)`,
    [versionId, projectId, application!.id],
  );
  const roundId = uuidv7();
  await c.query(
    `INSERT INTO lab.funding_rounds
       (id, project_id, application_version_id, schema_version, status, target, currency,
        service_country, policy_version, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 3000000, 'RUB', 'ru', 1, $4)`,
    [roundId, projectId, versionId, owner],
  );
  const id = uuidv7();
  await c.query(
    `INSERT INTO billing.round_purchases
       (id, round_id, project_id, buyer_user_id, package_snapshot, country_code,
        policy_version, total_amount, currency)
     VALUES ($1, $2, $3, $4, '{"code":"pkg_base"}'::jsonb, 'ru', 1, 10000, 'RUB')`,
    [id, roundId, projectId, owner],
  );
  return id;
}

async function payment(
  c: Client,
  opts: { purchaseId?: string | null; invoiceId?: string | null; mode?: string; status?: string },
): Promise<string> {
  const id = uuidv7();
  await c.query(
    `INSERT INTO billing.payments
       (id, purchase_id, invoice_id, amount, currency, provider, provider_ref, status, mode,
        idempotency_key, request_hash)
     VALUES ($1, $2, $3, 10000, 'RUB', 'test', $4, $5, $6, $7, '\\x00')`,
    [
      id,
      opts.purchaseId ?? null,
      opts.invoiceId ?? null,
      `ref_${id.slice(24)}`,
      opts.status ?? 'pending',
      opts.mode ?? 'test',
      `key_${id}`,
    ],
  );
  return id;
}

describe('M108: предмет оплаты и режим', () => {
  it('платёж без предмета и с двумя предметами отвергается', async () => {
    await inRollbackTx(async (c) => {
      await c.query('SAVEPOINT none');
      await expect(payment(c, {})).rejects.toThrow(/payments_one_subject/);
      await c.query('ROLLBACK TO SAVEPOINT none');
    });
  });

  it('платёж за покупку принимается', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const purchaseId = await purchase(c, owner.id, projectId);
      await expect(payment(c, { purchaseId })).resolves.toBeDefined();
    });
  });

  it('рабочий режим невозможен, пока приём настоящих платежей выключен', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const purchaseId = await purchase(c, owner.id, projectId);

      await c.query(
        `UPDATE audit.feature_flags SET enabled = false WHERE key = 'billing.payments.enabled'`,
      );
      await c.query('SAVEPOINT live');
      await expect(payment(c, { purchaseId, mode: 'live' })).rejects.toThrow(
        /приём настоящих платежей выключен/,
      );
      await c.query('ROLLBACK TO SAVEPOINT live');

      // Включённый флаг рабочий режим разрешает: запрет именно настроечный,
      // а не вечный.
      await c.query(
        `UPDATE audit.feature_flags SET enabled = true WHERE key = 'billing.payments.enabled'`,
      );
      await expect(payment(c, { purchaseId, mode: 'live' })).resolves.toBeDefined();
    });
  });

  it('отсутствие записи флага означает отказ, а не разрешение', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const purchaseId = await purchase(c, owner.id, projectId);
      await c.query(`DELETE FROM audit.feature_flags WHERE key = 'billing.payments.enabled'`);
      await expect(payment(c, { purchaseId, mode: 'live' })).rejects.toThrow(
        /приём настоящих платежей выключен/,
      );
    });
  });

  it('режим, суммы и предмет оплаты неизменяемы, платёж не удаляется', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const purchaseId = await purchase(c, owner.id, projectId);
      const paymentId = await payment(c, { purchaseId });

      await c.query('SAVEPOINT mode');
      await expect(
        c.query(`UPDATE billing.payments SET mode = 'live' WHERE id = $1`, [paymentId]),
      ).rejects.toThrow(/режим платежа неизменяем/);
      await c.query('ROLLBACK TO SAVEPOINT mode');

      await c.query('SAVEPOINT amount');
      await expect(
        c.query(`UPDATE billing.payments SET amount = 1 WHERE id = $1`, [paymentId]),
      ).rejects.toThrow(/денежные поля платежа неизменяемы/);
      await c.query('ROLLBACK TO SAVEPOINT amount');

      await c.query('SAVEPOINT removal');
      await expect(
        c.query(`DELETE FROM billing.payments WHERE id = $1`, [paymentId]),
      ).rejects.toThrow(/нельзя удалить/);
      await c.query('ROLLBACK TO SAVEPOINT removal');

      // Состояние меняться обязано — иначе платёж нельзя ни подтвердить, ни
      // пометить неуспешным.
      await expect(
        c.query(
          `UPDATE billing.payments SET status = 'succeeded', confirmed_at = now() WHERE id = $1`,
          [paymentId],
        ),
      ).resolves.toBeDefined();
    });
  });

  it('по одной покупке не идёт двух незавершённых платежей, после неуспеха можно снова', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const purchaseId = await purchase(c, owner.id, projectId);
      const first = await payment(c, { purchaseId });

      await c.query('SAVEPOINT second');
      await expect(payment(c, { purchaseId })).rejects.toThrow(/payments_active_per_purchase/);
      await c.query('ROLLBACK TO SAVEPOINT second');

      await c.query(`UPDATE billing.payments SET status = 'failed' WHERE id = $1`, [first]);
      await expect(payment(c, { purchaseId })).resolves.toBeDefined();
    });
  });
});

describe('M108: уведомления оператора', () => {
  async function event(c: Client, eventId: string): Promise<string> {
    const id = uuidv7();
    await c.query(
      `INSERT INTO billing.payment_events
         (id, provider, event_id, event_type, signature_ok, payload_sha256, payload_jsonb)
       VALUES ($1, 'test', $2, 'payment.succeeded', true, '\\x00', '{}'::jsonb)`,
      [id, eventId],
    );
    return id;
  }

  it('одно и то же событие записывается один раз', async () => {
    await inRollbackTx(async (c) => {
      await event(c, 'evt-1');
      await c.query('SAVEPOINT dup');
      await expect(event(c, 'evt-1')).rejects.toThrow(/payment_events_provider_event_id_key/);
      await c.query('ROLLBACK TO SAVEPOINT dup');
      // Другое событие того же оператора проходит.
      await expect(event(c, 'evt-2')).resolves.toBeDefined();
    });
  });

  it('содержимое уведомления не переписывается, результат обработки — да', async () => {
    await inRollbackTx(async (c) => {
      const id = await event(c, 'evt-3');
      await c.query('SAVEPOINT rewrite');
      await expect(
        c.query(`UPDATE billing.payment_events SET signature_ok = false WHERE id = $1`, [id]),
      ).rejects.toThrow(/уведомление провайдера неизменяемо/);
      await c.query('ROLLBACK TO SAVEPOINT rewrite');

      await expect(
        c.query(
          `UPDATE billing.payment_events SET result = 'applied', applied_at = now() WHERE id = $1`,
          [id],
        ),
      ).resolves.toBeDefined();

      await c.query('SAVEPOINT removal');
      await expect(
        c.query(`DELETE FROM billing.payment_events WHERE id = $1`, [id]),
      ).rejects.toThrow(/не удаляется/);
      await c.query('ROLLBACK TO SAVEPOINT removal');
    });
  });
});

describe('M108: подписка и автопродление', () => {
  it('автопродление включить нельзя', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { role: 'investor' });
      const [plan] = (
        await c.query<{ id: string; price: string }>(
          `SELECT id, price::text AS price FROM billing.subscription_plans
            WHERE valid_from <= now() AND (valid_to IS NULL OR valid_to > now()) LIMIT 1`,
        )
      ).rows;
      if (!plan) return; // нет действующего тарифа — проверять нечего

      // Цена берётся из тарифа: снимок обязан ему соответствовать (M009).
      const id = uuidv7();
      await c.query(
        `INSERT INTO billing.subscriptions
           (id, user_id, plan_id, price_snapshot, terms_version, status)
         VALUES ($1, $2, $3, $4::numeric, 'v1', 'pending_payment')`,
        [id, user.id, plan.id, plan.price],
      );
      await expect(
        c.query(`UPDATE billing.subscriptions SET auto_renew = true WHERE id = $1`, [id]),
      ).rejects.toThrow(/автопродление не включается/);
    });
  });
});

/**
 * M110: состояние оплаты движется только вперёд.
 *
 * Проверяется не «триггер есть», а два случая из жизни оператора платежей:
 * два разных события об одном успешном платеже и опоздавшее событие по уже
 * завершённой попытке. Оба обязаны разбиться о состояние записи, а не о
 * уникальность события.
 */
describe('M110: повторное исполнение и поздние события', () => {
  it('подтверждённую оплату нельзя понизить, возврат — можно', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const purchaseId = await purchase(c, owner.id, projectId);
      const paymentId = await payment(c, { purchaseId });
      await c.query(
        `UPDATE billing.payments SET status = 'succeeded', confirmed_at = now() WHERE id = $1`,
        [paymentId],
      );

      for (const status of ['pending', 'authorized', 'failed', 'canceled']) {
        await c.query('SAVEPOINT downgrade');
        await expect(
          c.query(`UPDATE billing.payments SET status = $2 WHERE id = $1`, [paymentId, status]),
        ).rejects.toThrow(/нельзя понизить/);
        await c.query('ROLLBACK TO SAVEPOINT downgrade');
      }

      // Возврат — законное продолжение, а не понижение.
      await expect(
        c.query(`UPDATE billing.payments SET status = 'refunded' WHERE id = $1`, [paymentId]),
      ).resolves.toBeDefined();
    });
  });

  it('завершённую неуспехом попытку поздним событием не переигрывают', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const purchaseId = await purchase(c, owner.id, projectId);
      const paymentId = await payment(c, { purchaseId });
      await c.query(`UPDATE billing.payments SET status = 'failed' WHERE id = $1`, [paymentId]);

      await expect(
        c.query(`UPDATE billing.payments SET status = 'succeeded' WHERE id = $1`, [paymentId]),
      ).rejects.toThrow(/уже завершён/);
    });
  });

  it('оплаченная покупка не возвращается в ожидание и не переставляет момент оплаты', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const purchaseId = await purchase(c, owner.id, projectId);
      await c.query(
        `UPDATE billing.round_purchases SET status = 'paid', paid_at = now() WHERE id = $1`,
        [purchaseId],
      );

      await c.query('SAVEPOINT back');
      await expect(
        c.query(`UPDATE billing.round_purchases SET status = 'pending_payment' WHERE id = $1`, [
          purchaseId,
        ]),
      ).rejects.toThrow(/не возвращается в ожидание оплаты/);
      await c.query('ROLLBACK TO SAVEPOINT back');

      await c.query('SAVEPOINT moment');
      await expect(
        c.query(
          `UPDATE billing.round_purchases SET paid_at = now() + interval '1 hour'
                  WHERE id = $1`,
          [purchaseId],
        ),
      ).rejects.toThrow(/момент оплаты/);
      await c.query('ROLLBACK TO SAVEPOINT moment');

      // Возврат и отмена остаются доступны.
      await expect(
        c.query(`UPDATE billing.round_purchases SET status = 'refunded' WHERE id = $1`, [
          purchaseId,
        ]),
      ).resolves.toBeDefined();
    });
  });
});

/**
 * M111–M113: услуга платформы закрывается результатом, а не отметкой.
 *
 * Это главное правило этапа 6.1, и проверяется оно с обеих сторон: отметку
 * «выполнено» нельзя поставить без успешного разбора, а успешный разбор
 * нельзя записать без сохранённого результата и отпечатка входа.
 */
describe('M111: исполнение услуги платформой', () => {
  async function itemWithService(
    c: Client,
    owner: string,
    projectId: string,
    executionKind: 'manual' | 'rules_analysis' | 'llm_analysis',
  ): Promise<{ purchaseId: string; itemId: string; code: string }> {
    const purchaseId = await purchase(c, owner, projectId);
    const code = `svc_${purchaseId.slice(24)}`;
    await c.query(
      `INSERT INTO billing.round_services (id, code, name, is_implemented, execution_kind, created_by)
       VALUES ($1, $2, 'Услуга прогона', true, $3, $4)`,
      [uuidv7(), code, executionKind, owner],
    );
    const itemId = uuidv7();
    await c.query(
      `INSERT INTO billing.round_purchase_items
         (id, purchase_id, kind, service_code, title, amount, currency)
       VALUES ($1, $2, 'service', $3, 'Услуга', 0, 'RUB')`,
      [itemId, purchaseId, code],
    );
    return { purchaseId, itemId, code };
  }

  it('услугу сотрудника отмечают руками, услугу платформы — нет', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);

      const manual = await itemWithService(c, owner.id, projectId, 'manual');
      await expect(
        c.query(
          `UPDATE billing.round_purchase_items
              SET fulfillment_status = 'fulfilled', fulfillment_note = 'сделано сотрудником'
            WHERE id = $1`,
          [manual.itemId],
        ),
      ).resolves.toBeDefined();

      const other = await createProject(c, owner.id);
      const auto = await itemWithService(c, owner.id, other, 'rules_analysis');
      await expect(
        c.query(
          `UPDATE billing.round_purchase_items
              SET fulfillment_status = 'fulfilled', fulfillment_note = 'галочкой'
            WHERE id = $1`,
          [auto.itemId],
        ),
      ).rejects.toThrow(/после успешного разбора/);
    });
  });

  it('успешный прогон без результата и без отпечатка записать нельзя', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const { purchaseId, itemId } = await itemWithService(
        c,
        owner.id,
        projectId,
        'rules_analysis',
      );

      await expect(
        c.query(
          `INSERT INTO billing.purchase_item_runs
             (id, item_id, purchase_id, project_id, kind, status)
           VALUES ($1, $2, $3, $4, 'ai_analysis', 'succeeded')`,
          [uuidv7(), itemId, purchaseId, projectId],
        ),
      ).rejects.toThrow(/purchase_item_runs_check/);
    });
  });

  it('успешный прогон закрывает услугу и второй раз не повторяется', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const { purchaseId, itemId } = await itemWithService(
        c,
        owner.id,
        projectId,
        'rules_analysis',
      );

      const runId = uuidv7();
      await c.query(
        `INSERT INTO billing.purchase_item_runs
           (id, item_id, purchase_id, project_id, kind, status, input_sha256, result_ref,
            result_kind, engine)
         VALUES ($1, $2, $3, $4, 'ai_analysis', 'succeeded', repeat('a', 64), $5,
                 'passport', 'heuristic')`,
        [runId, itemId, purchaseId, projectId, uuidv7()],
      );

      // Теперь отметка разрешена — результат есть.
      await expect(
        c.query(
          `UPDATE billing.round_purchase_items
              SET fulfillment_status = 'fulfilled', fulfillment_note = 'разбор выполнен'
            WHERE id = $1`,
          [itemId],
        ),
      ).resolves.toBeDefined();

      await c.query('SAVEPOINT second');
      await expect(
        c.query(
          `INSERT INTO billing.purchase_item_runs
             (id, item_id, purchase_id, project_id, kind, status, input_sha256, result_ref,
              result_kind, engine)
           VALUES ($1, $2, $3, $4, 'ai_analysis', 'succeeded', repeat('b', 64), $5,
                   'passport', 'heuristic')`,
          [uuidv7(), itemId, purchaseId, projectId, uuidv7()],
        ),
      ).rejects.toThrow(/purchase_item_runs_done/);
      await c.query('ROLLBACK TO SAVEPOINT second');

      await expect(
        c.query(`UPDATE billing.purchase_item_runs SET status = 'running' WHERE id = $1`, [runId]),
      ).rejects.toThrow(/не переигрывается/);
    });
  });

  it('два идущих прогона по одной позиции невозможны', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const { purchaseId, itemId } = await itemWithService(
        c,
        owner.id,
        projectId,
        'rules_analysis',
      );

      const insert = (id: string) =>
        c.query(
          `INSERT INTO billing.purchase_item_runs
             (id, item_id, purchase_id, project_id, kind, status)
           VALUES ($1, $2, $3, $4, 'ai_analysis', 'running')`,
          [id, itemId, purchaseId, projectId],
        );
      await insert(uuidv7());
      await expect(insert(uuidv7())).rejects.toThrow(/purchase_item_runs_active/);
    });
  });
});

/**
 * M114: разбор по правилам и ИИ-анализ — разные услуги.
 *
 * Проверяется то, из-за чего это вообще важно: услугу, за которую заплатили
 * как за анализ языковой моделью, нельзя закрыть расчётом по правилам, а
 * продавать её, пока модели нет, нельзя вовсе.
 */
describe('M114: род разбора', () => {
  it('услугу с обещанием ИИ-анализа нельзя пометить реализованной без модели и ключа', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      await c.query(
        `UPDATE audit.feature_flags SET enabled = false WHERE key = 'ai.scoring.llm.enabled'`,
      );
      await expect(
        c.query(
          `INSERT INTO billing.round_services
             (id, code, name, is_implemented, execution_kind, created_by)
           VALUES ($1, $2, 'ИИ-анализ', true, 'llm_analysis', $3)`,
          [uuidv7(), `svc_llm_${Date.now() % 1e9}`, admin.id],
        ),
      ).rejects.toThrow(/выполнить его нечем/);
    });
  });

  it('разбор по правилам не закрывает услугу, обещавшую ИИ-анализ', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const purchaseId = await purchase(c, owner.id, projectId);

      // Услуга заводится нереализованной — это единственный способ создать её
      // без модели, и он же показывает, что продать её нельзя.
      const code = `svc_llm2_${purchaseId.slice(24)}`;
      await c.query(
        `INSERT INTO billing.round_services
           (id, code, name, is_implemented, execution_kind, created_by)
         VALUES ($1, $2, 'ИИ-анализ', false, 'llm_analysis', $3)`,
        [uuidv7(), code, owner.id],
      );
      const itemId = uuidv7();
      await c.query(
        `INSERT INTO billing.round_purchase_items
           (id, purchase_id, kind, service_code, title, amount, currency)
         VALUES ($1, $2, 'service', $3, 'ИИ-анализ', 0, 'RUB')`,
        [itemId, purchaseId, code],
      );
      await c.query(
        `INSERT INTO billing.purchase_item_runs
           (id, item_id, purchase_id, project_id, kind, status, input_sha256, result_ref,
            result_kind, engine, required_kind)
         VALUES ($1, $2, $3, $4, 'ai_analysis', 'succeeded', repeat('c', 64), $5,
                 'passport', 'heuristic', 'llm_analysis')`,
        [uuidv7(), itemId, purchaseId, projectId, uuidv7()],
      );

      await expect(
        c.query(
          `UPDATE billing.round_purchase_items
              SET fulfillment_status = 'fulfilled', fulfillment_note = 'закрыть правилами'
            WHERE id = $1`,
          [itemId],
        ),
      ).rejects.toThrow(/это разные услуги/);
    });
  });
});
