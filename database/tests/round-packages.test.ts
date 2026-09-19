import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers.ts';
import { actAs, closePool, createProject, createUser, inRollbackTx, uuidv7 } from './helpers.ts';

/**
 * M095 (5.9.1): структуры разовой оплаты запуска раунда.
 *
 * Проверяется не «таблицы созданы», а правила, без которых расчёт был бы
 * произволом:
 *
 *  - в пакет и в докупку попадает только РЕАЛИЗОВАННАЯ услуга;
 *  - действующие диапазоны сумм не пересекаются внутри страны, а версии
 *    одного кода — по времени: иначе «подходящий пакет» неоднозначен;
 *  - денежные условия действующей версии неизменяемы, объявление на будущее
 *    править можно;
 *  - покупка и её позиции — исторический факт: ни снимок, ни суммы не
 *    меняются, удалить нельзя;
 *  - предложение читает любой вошедший, пишет только администратор; покупку
 *    видит команда проекта, посторонний — нет.
 */

afterAll(async () => {
  await closePool();
});

async function service(c: Client, admin: string, implemented = true): Promise<string> {
  const id = uuidv7();
  await c.query(
    `INSERT INTO billing.round_services (id, code, name, is_implemented, created_by)
     VALUES ($1, $2, 'Проверка пакета', $3, $4)`,
    [id, `svc_${id.slice(24)}`, implemented, admin],
  );
  return id;
}

async function pkg(
  c: Client,
  admin: string,
  opts: {
    code?: string;
    min?: number;
    max?: number | null;
    from?: string;
    to?: string | null;
  } = {},
): Promise<string> {
  const id = uuidv7();
  await c.query(
    `INSERT INTO billing.round_packages
       (id, code, version, country_code, name, price, currency, min_target, max_target,
        valid_from, valid_to, reason, created_by)
     VALUES ($1, $2, 1, 'ru', 'Пакет', 10000, 'RUB', $3, $4, $5, $6, 'проверка', $7)`,
    [
      id,
      opts.code ?? `pkg_${id.slice(24)}`,
      opts.min ?? 0,
      opts.max === undefined ? 1_000_000 : opts.max,
      opts.from ?? new Date(Date.now() - 86_400_000).toISOString(),
      opts.to ?? null,
      admin,
    ],
  );
  return id;
}

describe('M095: услуги и пакеты', () => {
  it('нереализованную услугу нельзя включить в пакет и нельзя продать отдельно', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const planned = await service(c, admin.id, false);
      const packageId = await pkg(c, admin.id);

      await c.query('SAVEPOINT in_package');
      await expect(
        c.query(
          `INSERT INTO billing.round_package_services (package_id, service_id) VALUES ($1, $2)`,
          [packageId, planned],
        ),
      ).rejects.toThrow(/реализованной/);
      await c.query('ROLLBACK TO SAVEPOINT in_package');

      await expect(
        c.query(
          `INSERT INTO billing.round_service_offers
             (id, service_id, country_code, version, price, currency, valid_from, reason, created_by)
           VALUES ($1, $2, 'ru', 1, 5000, 'RUB', now(), 'проверка', $3)`,
          [uuidv7(), planned, admin.id],
        ),
      ).rejects.toThrow(/реализованной/);
    });
  });

  it('реализованная услуга включается в пакет', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const ready = await service(c, admin.id, true);
      const packageId = await pkg(c, admin.id);
      await expect(
        c.query(
          `INSERT INTO billing.round_package_services (package_id, service_id) VALUES ($1, $2)`,
          [packageId, ready],
        ),
      ).resolves.toBeDefined();
    });
  });

  it('пересекающиеся диапазоны сумм в одной стране отвергаются', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      await pkg(c, admin.id, { min: 0, max: 1_000_000 });
      await expect(pkg(c, admin.id, { min: 500_000, max: 2_000_000 })).rejects.toThrow(
        /диапазоны суммы пересекаются/,
      );
    });
  });

  it('соседние диапазоны без пересечения принимаются', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      await pkg(c, admin.id, { min: 0, max: 1_000_000 });
      await expect(pkg(c, admin.id, { min: 1_000_000, max: null })).resolves.toBeDefined();
    });
  });

  it('версии одного кода не пересекаются по времени', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const code = 'pkg_same_code';
      await pkg(c, admin.id, { code, min: 0, max: 1_000_000 });
      // Тот же код, другой диапазон — но период тот же.
      const id = uuidv7();
      await expect(
        c.query(
          `INSERT INTO billing.round_packages
             (id, code, version, country_code, name, price, currency, min_target, max_target,
              valid_from, reason, created_by)
           VALUES ($1, $2, 2, 'ru', 'Пакет', 20000, 'RUB', 2000000, NULL, now() - interval '1 day',
                   'проверка', $3)`,
          [id, code, admin.id],
        ),
      ).rejects.toThrow(/пересечение периодов/);
    });
  });

  it('действующую версию переписать нельзя, будущую — можно', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const active = await pkg(c, admin.id, { min: 0, max: 1_000_000 });
      await c.query('SAVEPOINT rewrite_active');
      await expect(
        c.query('UPDATE billing.round_packages SET price = 1 WHERE id = $1', [active]),
      ).rejects.toThrow(/неизменяема/);
      await c.query('ROLLBACK TO SAVEPOINT rewrite_active');

      const future = await pkg(c, admin.id, {
        min: 5_000_000,
        max: null,
        from: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await expect(
        c.query('UPDATE billing.round_packages SET price = 12345 WHERE id = $1', [future]),
      ).resolves.toBeDefined();
      await expect(
        c.query('DELETE FROM billing.round_packages WHERE id = $1', [future]),
      ).resolves.toBeDefined();
    });
  });
});

describe('M095: покупка — исторический факт', () => {
  async function purchase(c: Client, owner: string, projectId: string): Promise<string> {
    const versionId = uuidv7();
    const [application] = (
      await c.query<{ id: string }>(
        `SELECT id FROM lab.investment_applications WHERE project_id = $1 LIMIT 1`,
        [projectId],
      )
    ).rows;
    await c.query(
      `INSERT INTO lab.project_versions (id, project_id, application_id, version_no, snapshot_jsonb, schema_version)
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
         (id, round_id, project_id, buyer_user_id, package_snapshot, country_code, policy_version,
          total_amount, currency)
       VALUES ($1, $2, $3, $4, '{"code":"pkg_base","version":1,"price":"10000.00"}'::jsonb,
               'ru', 1, 10000, 'RUB')`,
      [id, roundId, projectId, owner],
    );
    await c.query(
      `INSERT INTO billing.round_purchase_items
         (id, purchase_id, kind, title, amount, currency)
       VALUES ($1, $2, 'package', 'Пакет запуска', 10000, 'RUB')`,
      [uuidv7(), id],
    );
    return id;
  }

  it('снимок и суммы покупки неизменяемы, удаление запрещено', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const purchaseId = await purchase(c, owner.id, projectId);

      await c.query('SAVEPOINT rewrite');
      await expect(
        c.query('UPDATE billing.round_purchases SET total_amount = 1 WHERE id = $1', [purchaseId]),
      ).rejects.toThrow(/снимок покупки неизменяем/);
      await c.query('ROLLBACK TO SAVEPOINT rewrite');

      await c.query('SAVEPOINT removal');
      await expect(
        c.query('DELETE FROM billing.round_purchases WHERE id = $1', [purchaseId]),
      ).rejects.toThrow(/нельзя удалить/);
      await c.query('ROLLBACK TO SAVEPOINT removal');

      // Состояние оплаты меняться должно — иначе покупку нельзя ни оплатить,
      // ни отменить.
      await expect(
        c.query(
          `UPDATE billing.round_purchases SET status = 'paid', paid_at = now() WHERE id = $1`,
          [purchaseId],
        ),
      ).resolves.toBeDefined();
    });
  });

  it('позиции покупки не правятся и не удаляются', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const purchaseId = await purchase(c, owner.id, projectId);
      await expect(
        c.query(`UPDATE billing.round_purchase_items SET amount = 1 WHERE purchase_id = $1`, [
          purchaseId,
        ]),
      ).rejects.toThrow(/неизменяемы/);
    });
  });
});

describe('M095: доступ', () => {
  it('предложение читает вошедший, пишет только админ; покупку видит команда', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const owner = await createUser(c, { role: 'founder' });
      const stranger = await createUser(c, { role: 'investor' });
      const projectId = await createProject(c, owner.id);
      const packageId = await pkg(c, admin.id);
      const purchaseId = uuidv7();
      const versionId = uuidv7();
      const [application] = (
        await c.query<{ id: string }>(
          `SELECT id FROM lab.investment_applications WHERE project_id = $1 LIMIT 1`,
          [projectId],
        )
      ).rows;
      await c.query(
        `INSERT INTO lab.project_versions (id, project_id, application_id, version_no, snapshot_jsonb, schema_version)
         VALUES ($1, $2, $3, 1, '{}', 1)`,
        [versionId, projectId, application!.id],
      );
      const roundId = uuidv7();
      await c.query(
        `INSERT INTO lab.funding_rounds
           (id, project_id, application_version_id, schema_version, status, target, currency,
            service_country, policy_version, created_by)
         VALUES ($1, $2, $3, 1, 'draft', 3000000, 'RUB', 'ru', 1, $4)`,
        [roundId, projectId, versionId, owner.id],
      );
      await c.query(
        `INSERT INTO billing.round_purchases
           (id, round_id, project_id, buyer_user_id, package_snapshot, country_code,
            policy_version, total_amount, currency)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 'ru', 1, 10000, 'RUB')`,
        [purchaseId, roundId, projectId, owner.id],
      );

      const asUser = async (userId: string, roles: string[], query: string, params: unknown[]) => {
        await actAs(c, { userId, roles, dbRole: 'app_backend' });
        const { rows } = await c.query(query, params);
        await actAs(c, { userId: null, roles: [] });
        await c.query('RESET ROLE');
        return rows;
      };

      expect(
        await asUser(owner.id, ['founder'], 'SELECT 1 FROM billing.round_packages WHERE id = $1', [
          packageId,
        ]),
      ).toHaveLength(1);

      // Не владелец предложения: политика администратора не пускает строку в
      // UPDATE вовсе, поэтому изменяется ноль строк — отказа в виде ошибки
      // здесь и не должно быть, и это ровно то, что нужно проверить.
      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });
      const attempt = await c.query(
        `UPDATE billing.round_packages SET name = 'Своё название' WHERE id = $1`,
        [packageId],
      );
      expect(attempt.rowCount).toBe(0);
      await actAs(c, { userId: null, roles: [] });
      await c.query('RESET ROLE');

      expect(
        await asUser(owner.id, ['founder'], 'SELECT 1 FROM billing.round_purchases WHERE id = $1', [
          purchaseId,
        ]),
      ).toHaveLength(1);
      expect(
        await asUser(
          stranger.id,
          ['investor'],
          'SELECT 1 FROM billing.round_purchases WHERE id = $1',
          [purchaseId],
        ),
      ).toHaveLength(0);
    });
  });
});
