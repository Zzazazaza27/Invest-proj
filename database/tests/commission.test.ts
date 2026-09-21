import { afterAll, describe, expect, it } from 'vitest';
import { closePool, createUser, inRollbackTx, uuidv7 } from './helpers.ts';

/**
 * M096 (5.9.3): условия вознаграждения и зачёт услуг.
 *
 * Проверяется то, из-за чего модель менялась:
 *
 *  - ставка одна, доли складываются в неё. Версия, где доли не сходятся с
 *    общей ставкой, не записывается — иначе «сколько всего берёт платформа»
 *    зависело бы от того, какое поле читать;
 *  - денежные условия действующей версии неизменяемы;
 *  - начисление нельзя создать в обход команды подтверждения транша;
 *  - зачёт услуг выключен: правило не утверждено, и запись запрещена базой,
 *    а не только сервисом.
 */

afterAll(async () => {
  await closePool();
});

async function publishTerms(
  c: Parameters<typeof createUser>[0],
  opts: { total: number; investor: number; issuer: number },
): Promise<string> {
  const id = uuidv7();
  await c.query(
    `INSERT INTO billing.fee_schedules
       (id, code, version, total_pct, investor_fee_pct, issuer_fee_pct,
        rules_version, reason, valid_from)
     VALUES ($1, $2, 1, $3, $4, $5, 'v1', 'проверка правил ставки', now())`,
    [id, `fee_${id.slice(24)}`, opts.total, opts.investor, opts.issuer],
  );
  return id;
}

describe('M096: условия вознаграждения', () => {
  it('доли сторон обязаны складываться в общую ставку', async () => {
    await inRollbackTx(async (c) => {
      await expect(publishTerms(c, { total: 15, investor: 10, issuer: 5 })).resolves.toBeDefined();

      await c.query('SAVEPOINT mismatch');
      await expect(publishTerms(c, { total: 15, investor: 10, issuer: 4 })).rejects.toThrow(
        /fee_schedules_shares_sum/,
      );
      await c.query('ROLLBACK TO SAVEPOINT mismatch');

      // И в другую сторону: доли больше общей ставки — тоже не условия.
      await expect(publishTerms(c, { total: 10, investor: 10, issuer: 5 })).rejects.toThrow(
        /fee_schedules_shares_sum/,
      );
    });
  });

  it('денежные условия действующей версии не переписываются', async () => {
    await inRollbackTx(async (c) => {
      const id = await publishTerms(c, { total: 15, investor: 10, issuer: 5 });

      await c.query('SAVEPOINT rewrite');
      await expect(
        c.query('UPDATE billing.fee_schedules SET total_pct = 20 WHERE id = $1', [id]),
      ).rejects.toThrow(/immutable/);
      await c.query('ROLLBACK TO SAVEPOINT rewrite');

      // Закрыть версию датой можно: это не переписывание условий.
      await expect(
        c.query(
          `UPDATE billing.fee_schedules SET valid_to = now() + interval '1 day' WHERE id = $1`,
          [id],
        ),
      ).resolves.toBeDefined();
    });
  });

  it('начисление нельзя создать в обход команды подтверждения транша', async () => {
    await inRollbackTx(async (c) => {
      const [fee] = (
        await c.query<{ id: string }>(
          `SELECT id FROM billing.fee_schedules WHERE code = 'operator_success_fee' LIMIT 1`,
        )
      ).rows;
      await expect(
        c.query(
          `INSERT INTO billing.commission_accruals
             (id, agreement_id, trigger_tranche_id, fee_schedule_id, base_amount, currency,
              total_pct, investor_fee_pct, issuer_fee_pct)
           VALUES ($1, $2, $3, $4, 1000, 'RUB', 15, 10, 5)`,
          [uuidv7(), uuidv7(), uuidv7(), fee!.id],
        ),
      ).rejects.toThrow(/confirm_tranche/);
    });
  });
});

describe('M096: зачёт услуг выключен', () => {
  it('стартовое правило заведено и выключено', async () => {
    await inRollbackTx(async (c) => {
      const { rows } = await c.query<{ is_enabled: boolean; is_active: boolean }>(
        `SELECT is_enabled, is_active FROM billing.fee_offset_rules WHERE is_active`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.is_enabled).toBe(false);
      expect(
        billingOffsetsEnabled(await c.query(`SELECT billing.fee_offsets_enabled() AS on`)),
      ).toBe(false);
    });
  });

  it('запись зачёта запрещена базой, пока правило выключено', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      expect(admin.id).toBeTruthy();
      await expect(
        c.query(
          `INSERT INTO billing.fee_offsets
             (id, accrual_id, purchase_item_id, rule_version, amount, currency, reason)
           VALUES ($1, $2, $3, 1, 100, 'RUB', 'попытка зачёта при выключенном правиле')`,
          [uuidv7(), uuidv7(), uuidv7()],
        ),
      ).rejects.toThrow(/зачёт услуг выключен/);
    });
  });
});

function billingOffsetsEnabled(result: { rows: { on: boolean }[] }): boolean {
  return result.rows[0]!.on;
}

describe('M100: возможности тарифов инвестора', () => {
  it('базовую возможность нельзя включить в тариф', async () => {
    await inRollbackTx(async (c) => {
      const [plan] = (
        await c.query<{ id: string }>(
          `SELECT id FROM billing.subscription_plans WHERE valid_to IS NULL LIMIT 1`,
        )
      ).rows;
      await expect(
        c.query(
          `INSERT INTO billing.plan_capability_links (plan_id, capability, reason)
           VALUES ($1, 'catalog.browse', 'попытка закрыть базовый просмотр')`,
          [plan!.id],
        ),
      ).rejects.toThrow(/базовая/);
    });
  });

  it('нереализованную возможность нельзя включить в тариф', async () => {
    await inRollbackTx(async (c) => {
      const [plan] = (
        await c.query<{ id: string }>(
          `SELECT id FROM billing.subscription_plans WHERE valid_to IS NULL LIMIT 1`,
        )
      ).rows;
      await expect(
        c.query(
          `INSERT INTO billing.plan_capability_links (plan_id, capability, reason)
           VALUES ($1, 'analytics.compare', 'попытка продать несделанное')`,
          [plan!.id],
        ),
      ).rejects.toThrow(/не реализована/);
    });
  });

  it('платное ограничение включить нельзя: матрица не утверждена', async () => {
    await inRollbackTx(async (c) => {
      await expect(
        c.query(
          `UPDATE billing.plan_capabilities SET is_enforced = true WHERE code = 'analytics.compare'`,
        ),
      ).rejects.toThrow(/не утверждена владельцем/);
    });
  });

  it('базовость — настройка: её можно снять и тогда включить в тариф', async () => {
    await inRollbackTx(async (c) => {
      const [plan] = (
        await c.query<{ id: string }>(
          `SELECT id FROM billing.subscription_plans WHERE valid_to IS NULL LIMIT 1`,
        )
      ).rows;

      await c.query('SAVEPOINT while_baseline');
      await expect(
        c.query(
          `INSERT INTO billing.plan_capability_links (plan_id, capability, reason)
           VALUES ($1, 'catalog.favorites', 'пока помечена базовой')`,
          [plan!.id],
        ),
      ).rejects.toThrow(/базовая/);
      await c.query('ROLLBACK TO SAVEPOINT while_baseline');

      // Пометка снимается настройкой — вечного запрета в БД нет.
      await c.query(
        `UPDATE billing.plan_capabilities SET is_baseline = false WHERE code = 'catalog.favorites'`,
      );
      await expect(
        c.query(
          `INSERT INTO billing.plan_capability_links (plan_id, capability, reason)
           VALUES ($1, 'catalog.favorites', 'матрица согласована')`,
          [plan!.id],
        ),
      ).resolves.toBeDefined();
    });
  });

  it('барьер подписки учитывается раньше тарифа', async () => {
    await inRollbackTx(async (c) => {
      const investor = await createUser(c, { role: 'investor' });
      const { rows } = await c.query<{ capability: string; available: boolean; source: string }>(
        `SELECT capability, available, source FROM billing.investor_capabilities($1)`,
        [investor.id],
      );
      const card = rows.find((r) => r.capability === 'project.investor_view');
      const [flag] = (
        await c.query<{ barrier: boolean }>(
          `SELECT lab.investor_access_requires_subscription() AS barrier`,
        )
      ).rows;
      // Разбор первой строки прямо в объявлении не проходит проверку типов:
      // при `noUncheckedIndexedAccess` элемент массива — «значение или
      // undefined». Скалярный SELECT строку возвращает всегда, и пустой
      // результат означал бы отсутствие самой функции — пусть тест скажет об
      // этом словами, а не упадёт на разборе undefined.
      expect(flag, 'lab.investor_access_requires_subscription() не вернула строку').toBeDefined();
      const barrier = flag!.barrier;
      if (barrier) {
        // Барьер включён, членства нет: «доступна» отвечать нельзя.
        expect(card?.available).toBe(false);
        expect(card?.source).toBe('membership_required');
      } else {
        expect(card?.available).toBe(true);
      }
    });
  });

  it('пока ограничения выключены, реализованное доступно всем инвесторам', async () => {
    await inRollbackTx(async (c) => {
      const investor = await createUser(c, { role: 'investor' });
      const { rows } = await c.query<{ capability: string; available: boolean; source: string }>(
        `SELECT capability, available, source FROM billing.investor_capabilities($1)
          ORDER BY capability`,
        [investor.id],
      );
      const codes = rows.map((r) => r.capability);
      expect(codes).toContain('catalog.browse');
      // Источник «plan» не встречается: ничего не закрыто, платить не за что.
      expect(rows.every((r) => r.source !== 'plan')).toBe(true);
      // Базовые и невключённые — доступны.
      expect(rows.find((r) => r.capability === 'catalog.browse')?.available).toBe(true);
      // Нереализованные возможности не выдаются вовсе.
      expect(codes).not.toContain('analytics.compare');
    });
  });
});
