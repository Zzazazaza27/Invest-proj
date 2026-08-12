/**
 * Негативные тесты RLS — обязательный гейт CI (Database_Launch.md §15).
 *
 * Каждый тест отвечает на вопрос «может ли роль X добраться до данных, к
 * которым не должна?». Зелёный тест здесь означает «НЕ может».
 *
 * Все проверки выполняются под настоящими сервисными ролями через SET ROLE.
 * Проверка от имени владителя схем доказывала бы права владельца, а не
 * приложения, и была бы зелёной по неверной причине.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from './helpers.ts';
import {
  actAs,
  approveKyc,
  closePool,
  createEntity,
  createInvestorSubscription,
  createOffer,
  createProject,
  createSignedAgreement,
  createUser,
  getPool,
  inRollbackTx,
  uuidv7,
} from './helpers.ts';

afterAll(async () => {
  await closePool();
});

describe('RLS: изоляция проектов', () => {
  it('основатель не видит чужой проект', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const bob = await createUser(c, { role: 'founder' });
      const aliceProject = await createProject(c, alice.id);

      await actAs(c, { userId: bob.id, roles: ['founder'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [aliceProject]);
      expect(rows).toHaveLength(0);
    });
  });

  it('владелец видит свой проект', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const project = await createProject(c, alice.id);

      await actAs(c, { userId: alice.id, roles: ['founder'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [project]);
      expect(rows).toHaveLength(1);
    });
  });

  it('инвестор БЕЗ подписки не видит листинг', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const project = await createProject(c, founder.id, { listed: true });

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [project]);
      expect(rows).toHaveLength(0);
    });
  });

  it('инвестор С подпиской видит листинг', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const project = await createProject(c, founder.id, { listed: true });
      await createInvestorSubscription(c, investor.id);

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [project]);
      expect(rows).toHaveLength(1);
    });
  });

  it('инвестор с подпиской НЕ видит нелистинговый проект', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const project = await createProject(c, founder.id, { listed: false });
      await createInvestorSubscription(c, investor.id);

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [project]);
      expect(rows).toHaveLength(0);
    });
  });

  it('эксперт не видит неназначенный проект', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const expert = await createUser(c, { role: 'expert' });
      const project = await createProject(c, founder.id);

      await actAs(c, { userId: expert.id, roles: ['expert'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [project]);
      expect(rows).toHaveLength(0);
    });
  });
});

describe('RLS: паспорт и скоринг', () => {
  it('инвестор без подписки не видит полный паспорт', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const project = await createProject(c, founder.id, { listed: true });
      await c.query(
        `INSERT INTO scoring.investment_passports (id, project_id, version, jsonb_data,
                                                   disclosure_tier, published_at)
         VALUES (public.uuid_generate_v7(), $1, 1, '{}'::jsonb, 'full', now())`,
        [project],
      );

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query(
        'SELECT id FROM scoring.investment_passports WHERE project_id = $1',
        [project],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it('tier=dataroom не выдаётся инвестору даже с подпиской', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const project = await createProject(c, founder.id, { listed: true });
      await createInvestorSubscription(c, investor.id);
      await c.query(
        `INSERT INTO scoring.investment_passports (id, project_id, version, jsonb_data,
                                                   disclosure_tier, published_at)
         VALUES (public.uuid_generate_v7(), $1, 1, '{}'::jsonb, 'dataroom', now())`,
        [project],
      );

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query(
        'SELECT id FROM scoring.investment_passports WHERE project_id = $1',
        [project],
      );
      expect(rows).toHaveLength(0);
    });
  });
});

describe('RLS: регулируемый инвестконтур', () => {
  it('посторонний не видит чужой договор', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const stranger = await createUser(c, { role: 'investor' });
      await approveKyc(c, investor.id);
      const entity = await createEntity(c, founder.id);
      const project = await createProject(c, founder.id, { listed: true });
      const offer = await createOffer(c, {
        projectId: project,
        entityId: entity,
        createdBy: founder.id,
      });
      const agreement = await createSignedAgreement(c, { offerId: offer, investorId: investor.id });

      await actAs(c, { userId: stranger.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query(
        'SELECT id FROM investments.investment_agreements WHERE id = $1',
        [agreement],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it('инвестор видит СВОЙ договор', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      await approveKyc(c, investor.id);
      const entity = await createEntity(c, founder.id);
      const project = await createProject(c, founder.id, { listed: true });
      const offer = await createOffer(c, {
        projectId: project,
        entityId: entity,
        createdBy: founder.id,
      });
      const agreement = await createSignedAgreement(c, { offerId: offer, investorId: investor.id });

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query(
        'SELECT id FROM investments.investment_agreements WHERE id = $1',
        [agreement],
      );
      expect(rows).toHaveLength(1);
    });
  });

  it('выписка номинального счёта недоступна роли основного API', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { role: 'investor' });
      await c.query(
        `INSERT INTO investments.nominal_account_transactions
           (id, bank_transaction_ref, direction, amount, booked_at, raw_statement_sha256)
         VALUES (public.uuid_generate_v7(), 'ref-rls-1', 'incoming', 1000, now(), digest('s','sha256'))`,
      );

      // app_backend не получает GRANT на банковскую выписку вовсе — защита
      // срабатывает на уровне привилегий, ещё до RLS. Это сильнее, чем
      // «политика вернула ноль строк».
      await actAs(c, { userId: user.id, roles: ['investor'], dbRole: 'app_backend' });
      await expect(
        c.query('SELECT id FROM investments.nominal_account_transactions'),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});

describe('RLS: разделение денежных прав между ролями БД', () => {
  it('app_backend не может подтвердить транш', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      await approveKyc(c, investor.id);
      const entity = await createEntity(c, founder.id);
      const project = await createProject(c, founder.id, { listed: true });
      const offer = await createOffer(c, {
        projectId: project,
        entityId: entity,
        createdBy: founder.id,
      });
      const agreement = await createSignedAgreement(c, { offerId: offer, investorId: investor.id });

      await actAs(c, { userId: null, roles: ['system'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO investments.investment_tranches
             (id, agreement_id, tranche_no, amount, status, transferred_at, confirmed_at)
           VALUES (public.uuid_generate_v7(), $1, 1, 1000, 'confirmed', now(), now())`,
          [agreement],
        ),
      ).rejects.toThrow();
    });
  });

  /**
   * Разделение ролей держится не только на GRANT'ах, но и на том, что
   * логин-пользователь приложения НЕ состоит в сервисных группах: иначе любая
   * ошибка в коде пользовательского контура могла бы выполнить `SET ROLE
   * app_investments` и получить права записи в реестр договоров. Поэтому
   * регулируемые команды ходят отдельным подключением, а не переключением роли.
   */
  it('логин-роль приложения не состоит в сервисных группах', async () => {
    const { rows } = await getPool().query<{ granted: string }>(
      `SELECT g.rolname AS granted
         FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.member
         JOIN pg_roles g ON g.oid = m.roleid
        WHERE r.rolname = 'app_backend_user'
        ORDER BY 1`,
    );
    const granted = rows.map((r) => r.granted);
    // app_public_read — переключение ВНИЗ по привилегиям для публичного каталога.
    expect(granted.sort()).toEqual(['app_backend', 'app_public_read']);
    for (const service of ['app_investments', 'app_billing', 'app_integration']) {
      expect(granted).not.toContain(service);
    }
  });

  it('app_backend не может создать начисление вознаграждения', async () => {
    await inRollbackTx(async (c) => {
      await actAs(c, { userId: null, roles: ['system'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO billing.commission_accruals
             (id, agreement_id, trigger_tranche_id, fee_schedule_id, base_amount,
              investor_fee_pct, issuer_fee_pct)
           VALUES (public.uuid_generate_v7(), public.uuid_generate_v7(), public.uuid_generate_v7(),
                   public.uuid_generate_v7(), 1000, 10, 5)`,
        ),
      ).rejects.toThrow();
    });
  });

  it('ни одна роль приложения не может писать напрямую в журнал событий', async () => {
    for (const role of ['app_backend', 'app_investments', 'app_billing', 'app_integration']) {
      await inRollbackTx(async (c) => {
        await actAs(c, { userId: null, roles: ['system'], dbRole: role });
        await expect(
          c.query(
            `INSERT INTO audit.events (id, verb, actor_role, context_jsonb)
             VALUES (public.uuid_generate_v7(), 'lab.season.opened', 'admin', '{}'::jsonb)`,
          ),
        ).rejects.toThrow();
      });
    }
  });

  it('публичная роль не читает служебные колонки проекта', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      await createProject(c, founder.id, { listed: true });

      await actAs(c, { userId: null, roles: [], dbRole: 'app_public_read' });
      // Разрешённый allowlist читается.
      const allowed = await c.query('SELECT id, title FROM lab.v_public_catalog LIMIT 1');
      expect(allowed.rows.length).toBeGreaterThanOrEqual(0);
      // Служебные колонки — нет.
      await expect(c.query('SELECT teaser_jsonb FROM lab.projects LIMIT 1')).rejects.toThrow();
      await expect(c.query('SELECT status FROM lab.projects LIMIT 1')).rejects.toThrow();
    });
  });

  it('ни одна роль приложения не имеет BYPASSRLS', async () => {
    const { rows } = await getPool().query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname LIKE 'app\\_%' AND rolbypassrls`,
    );
    expect(rows.map((r) => r.rolname)).toEqual([]);
  });
});

describe('RLS: экспертиза и уведомления', () => {
  /** Эксперт с назначением в заданном статусе. Возвращает id проекта и эксперта. */
  async function assignedReviewer(
    c: Client,
    status: string,
  ): Promise<{ projectId: string; expertId: string }> {
    const founder = await createUser(c, { role: 'founder' });
    const expert = await createUser(c, { role: 'expert' });
    const projectId = await createProject(c, founder.id);
    await c.query(
      `INSERT INTO experts.experts (user_id, expertise_tags) VALUES ($1, ARRAY['fintech'])`,
      [expert.id],
    );
    await c.query(
      `INSERT INTO experts.expert_assignments
         (id, project_id, expert_id, assigned_reason, status, due_at)
       VALUES ($1, $2, $3, 'manual', $4, now() + interval '7 days')`,
      [uuidv7(), projectId, expert.id, status],
    );
    return { projectId, expertId: expert.id };
  }

  // Обратный случай — «эксперт не видит неназначенный проект» — уже закрыт в
  // блоке изоляции проектов; здесь проверяется, что назначение доступ ОТКРЫВАЕТ.
  it('назначенный рецензент видит проект — иначе рецензировать нечего', async () => {
    await inRollbackTx(async (c) => {
      const { projectId, expertId } = await assignedReviewer(c, 'accepted');

      await actAs(c, { userId: expertId, roles: ['expert'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [projectId]);
      expect(rows).toHaveLength(1);
    });
  });

  it('отказавшийся от назначения эксперт теряет доступ к проекту', async () => {
    await inRollbackTx(async (c) => {
      const { projectId, expertId } = await assignedReviewer(c, 'declined');

      await actAs(c, { userId: expertId, roles: ['expert'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [projectId]);
      expect(rows).toHaveLength(0);
    });
  });

  it('эксперт не читает чужую рецензию', async () => {
    await inRollbackTx(async (c) => {
      const first = await assignedReviewer(c, 'accepted');
      const intruder = await createUser(c, { role: 'expert' });
      const { rows: assignment } = await c.query<{ id: string }>(
        `SELECT id FROM experts.expert_assignments WHERE expert_id = $1`,
        [first.expertId],
      );
      await c.query(
        `INSERT INTO experts.expert_reviews
           (id, assignment_id, rubric_scores_jsonb, recommendation)
         VALUES ($1, $2, $3::jsonb, 'pass')`,
        [
          uuidv7(),
          assignment[0]!.id,
          JSON.stringify({
            team: 8,
            product: 8,
            strategy: 8,
            legal: 8,
            finmodel: 8,
            scalability: 8,
          }),
        ],
      );

      await actAs(c, { userId: intruder.id, roles: ['expert'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM experts.expert_reviews');
      expect(rows).toHaveLength(0);
    });
  });

  it('пользователь не видит чужих уведомлений и чужих устройств', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const intruder = await createUser(c, { role: 'founder' });
      await c.query(
        `INSERT INTO comms.notifications (id, user_id, channel, template_code, payload_jsonb)
         VALUES ($1, $2, 'push', 'project.scored', '{}'::jsonb)`,
        [uuidv7(), owner.id],
      );
      await c.query(
        `INSERT INTO comms.user_devices (id, user_id, platform, push_provider, push_token)
         VALUES ($1, $2, 'ios', 'apns', $3)`,
        [uuidv7(), owner.id, `tok-${uuidv7()}`],
      );

      await actAs(c, { userId: intruder.id, roles: ['founder'], dbRole: 'app_backend' });
      const notifications = await c.query('SELECT id FROM comms.notifications');
      const devices = await c.query('SELECT id FROM comms.user_devices');
      expect(notifications.rows).toHaveLength(0);
      expect(devices.rows).toHaveLength(0);
    });
  });

  it('роль приложения не может пересчитать рейтинг мимо функции-обёртки', async () => {
    await inRollbackTx(async (c) => {
      await actAs(c, { userId: null, roles: ['admin'], dbRole: 'app_backend' });
      await expect(c.query('REFRESH MATERIALIZED VIEW seasons.mv_season_rating')).rejects.toThrow();
    });
  });

  it('без роли организатора функция пересчёта рейтинга отказывает', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { role: 'founder' });
      await actAs(c, { userId: user.id, roles: ['founder'], dbRole: 'app_backend' });
      await expect(c.query('SELECT seasons.refresh_rating()')).rejects.toThrow(
        /admin or organizer/,
      );
    });
  });
});

describe('RLS: граница интеграционного контура', () => {
  /**
   * Роль `app_integration` обслуживает ВНЕШНИЕ системы. Проверяется не то, что
   * ей доступно, а то, что ей недоступно: персональные данные, деньги и чужая
   * переписка. Отказ здесь — это и есть работающая граница.
   */
  const forbidden: [string, string][] = [
    ['персональные данные пользователей', 'SELECT id FROM identity.users LIMIT 1'],
    ['согласия на публичность', 'SELECT id FROM identity.publication_consents LIMIT 1'],
    ['верификации KYC', 'SELECT id FROM kyc.kyc_verifications LIMIT 1'],
    ['начисления вознаграждения', 'SELECT id FROM billing.commission_accruals LIMIT 1'],
    ['платежи', 'SELECT id FROM billing.payments LIMIT 1'],
    ['очередь уведомлений', 'SELECT id FROM comms.notifications LIMIT 1'],
    ['рецензии экспертов', 'SELECT id FROM experts.expert_reviews LIMIT 1'],
  ];

  for (const [label, query] of forbidden) {
    it(`интеграционная роль не читает: ${label}`, async () => {
      await inRollbackTx(async (c) => {
        await actAs(c, { userId: null, roles: [], dbRole: 'app_integration' });
        await expect(c.query(query)).rejects.toThrow();
      });
    });
  }

  it('интеграционная роль читает проекции, ради которых существует', async () => {
    await inRollbackTx(async (c) => {
      await actAs(c, { userId: null, roles: [], dbRole: 'app_integration' });
      // Позитивный контроль: отказы выше должны означать «нет прав», а не
      // «роль не работает вовсе».
      await expect(c.query('SELECT id FROM lab.projects LIMIT 1')).resolves.toBeDefined();
      await expect(c.query('SELECT id FROM seasons.seasons LIMIT 1')).resolves.toBeDefined();
      await expect(
        c.query('SELECT id FROM scoring.investment_passports LIMIT 1'),
      ).resolves.toBeDefined();
    });
  });

  it('факт согласия доступен интеграции без доступа к самим согласиям', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, founder.id);
      await c.query(
        `INSERT INTO identity.publication_consents
           (id, user_id, project_id, scope, document_version, document_sha256)
         VALUES ($1, $2, $3, 'top100_public', 'v1', digest('doc','sha256'))`,
        [uuidv7(), founder.id, projectId],
      );

      await actAs(c, { userId: null, roles: [], dbRole: 'app_integration' });
      const { rows } = await c.query(
        `SELECT scope, granted_at FROM integration.active_publication_consent($1, 'top100_public')`,
        [projectId],
      );
      expect(rows).toHaveLength(1);
      // Через функцию не достать ни владельца согласия, ни его документ.
      expect(Object.keys(rows[0] as object).sort()).toEqual(['granted_at', 'scope']);
    });
  });

  it('отозванное согласие исчезает из выдачи функции немедленно', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, founder.id);
      const { rows: inserted } = await c.query<{ id: string }>(
        `INSERT INTO identity.publication_consents
           (id, user_id, project_id, scope, document_version, document_sha256)
         VALUES ($1, $2, $3, 'top100_public', 'v1', digest('doc','sha256'))
         RETURNING id`,
        [uuidv7(), founder.id, projectId],
      );
      await c.query('UPDATE identity.publication_consents SET revoked_at = now() WHERE id = $1', [
        inserted[0]!.id,
      ]);

      await actAs(c, { userId: null, roles: [], dbRole: 'app_integration' });
      const { rows } = await c.query(
        `SELECT scope FROM integration.active_publication_consent($1, 'top100_public')`,
        [projectId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it('момент выпуска проставляется триггером и не переписывается', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, founder.id);
      // Проект проходит воронку по шагам. Прыжок `draft -> graduated` запрещён
      // триггером `projects_stage_order` (M025), и тест, который его делал,
      // был зелёным только на устаревшей схеме.
      for (const stage of [
        'submitted',
        'ai_review',
        'expert_review',
        'bootcamp',
        'finalist',
        'graduated',
      ]) {
        await c.query(`UPDATE lab.projects SET status = $2 WHERE id = $1`, [projectId, stage]);
      }
      const first = await c.query<{ graduated_at: Date }>(
        'SELECT graduated_at FROM lab.projects WHERE id = $1',
        [projectId],
      );
      expect(first.rows[0]!.graduated_at).not.toBeNull();

      // Повторное обновление статуса не должно сдвигать точку отсчёта, по
      // которой внешние системы синхронизируются.
      await c.query(`UPDATE lab.projects SET status = 'graduated' WHERE id = $1`, [projectId]);
      const second = await c.query<{ graduated_at: Date }>(
        'SELECT graduated_at FROM lab.projects WHERE id = $1',
        [projectId],
      );
      expect(second.rows[0]!.graduated_at.getTime()).toBe(first.rows[0]!.graduated_at.getTime());
    });
  });
});

describe('RLS: покрытие манифеста', () => {
  it('каждая доменная таблица имеет ENABLE + FORCE RLS и хотя бы одну политику', async () => {
    const { rows } = await getPool().query<{ table_name: string; reason: string }>(
      `SELECT n.nspname || '.' || c.relname AS table_name,
              CASE WHEN NOT c.relrowsecurity THEN 'RLS не включён'
                   WHEN NOT c.relforcerowsecurity THEN 'RLS не FORCE'
                   ELSE 'нет ни одной политики' END AS reason
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('identity','kyc','lab','investments','scoring','experts',
                            'seasons','comms','billing','audit','integration')
          AND c.relkind IN ('r','p')
          AND c.relispartition = false
          AND (NOT c.relrowsecurity
               OR NOT c.relforcerowsecurity
               OR NOT EXISTS (SELECT 1 FROM pg_policies p
                              WHERE p.schemaname = n.nspname AND p.tablename = c.relname))
        ORDER BY 1`,
    );
    expect(rows).toEqual([]);
  });

  it('схема соответствует спецификации: 11 схем и 64 таблицы', async () => {
    const schemas = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.schemata
        WHERE schema_name IN ('identity','kyc','lab','investments','scoring','experts',
                              'seasons','comms','billing','audit','integration')`,
    );
    expect(Number(schemas.rows[0]!.count)).toBe(11);

    const tables = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('identity','kyc','lab','investments','scoring','experts',
                            'seasons','comms','billing','audit','integration')
          AND c.relkind IN ('r','p') AND c.relispartition = false`,
    );
    // 60 таблиц по Database_Launch.md + billing.custom_price_proposals (M017):
    // двухшаговое согласование индивидуальной цены нельзя было уместить в саму
    // подписку, не ослабив её CHECK-ограничение на четыре глаза.
    // + integration.deal_commissions (M028): обезличенная проекция сделок для
    // внешних потребителей.
    // + identity.revoked_tokens (M038): точечный отзыв токена, которого рубеж
    // сессий не даёт.
    // + audit.event_archives (M041): след выгрузок журнала в холодное
    // хранилище — без него «выгружено» было бы устным знанием.
    //
    // Число держится вручную намеренно: рост числа таблиц обязан быть
    // осознанным. Ожидание 61 продержалось лишние две миграции только потому,
    // что локальная тестовая БД отставала и проверка была зелёной по неверной
    // причине.
    expect(Number(tables.rows[0]!.count)).toBe(64);
  });
});

describe('RLS: реестр отозванных токенов (M038)', () => {
  it('пользователь не видит отзывы чужих сессий', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const bob = await createUser(c, { role: 'founder' });
      await c.query(
        `INSERT INTO identity.revoked_tokens (jti, user_id, expires_at, reason)
              VALUES ($1, $2, now() + interval '1 hour', 'logout')`,
        [`jti-${uuidv7()}`, alice.id],
      );

      await actAs(c, { userId: bob.id, roles: ['founder'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT jti FROM identity.revoked_tokens WHERE user_id = $1', [
        alice.id,
      ]);
      // Перечень отозванных идентификаторов чужих сессий — сам по себе
      // разведывательная информация: он показывает, когда и сколько раз человек
      // выходил.
      expect(rows).toHaveLength(0);
    });
  });

  it('свои отзывы владелец видит', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const jti = `jti-${uuidv7()}`;
      await c.query(
        `INSERT INTO identity.revoked_tokens (jti, user_id, expires_at, reason)
              VALUES ($1, $2, now() + interval '1 hour', 'logout')`,
        [jti, alice.id],
      );

      await actAs(c, { userId: alice.id, roles: ['founder'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT jti FROM identity.revoked_tokens WHERE jti = $1', [
        jti,
      ]);
      expect(rows).toHaveLength(1);
    });
  });

  it('отозвать чужой токен нельзя', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const bob = await createUser(c, { role: 'founder' });

      await actAs(c, { userId: bob.id, roles: ['founder'], dbRole: 'app_backend' });
      // Иначе достаточно угадать идентификатор чужого токена, чтобы выкинуть
      // человека из его сессии.
      await expect(
        c.query(
          `INSERT INTO identity.revoked_tokens (jti, user_id, expires_at, reason)
                VALUES ($1, $2, now() + interval '1 hour', 'logout')`,
          [`jti-${uuidv7()}`, alice.id],
        ),
      ).rejects.toThrow();
    });
  });

  it('роль приложения не может удалять из реестра вовсе', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const jti = `jti-${uuidv7()}`;
      await c.query(
        `INSERT INTO identity.revoked_tokens (jti, user_id, expires_at, reason)
              VALUES ($1, $2, now() + interval '1 hour', 'logout')`,
        [jti, alice.id],
      );

      await actAs(c, { userId: alice.id, roles: ['founder'], dbRole: 'app_backend' });
      // Снятие записи вернуло бы отозванному токену силу — это и есть обход
      // отзыва, а не «уборка». Права на удаление у роли приложения нет.
      await expect(
        c.query('DELETE FROM identity.revoked_tokens WHERE jti = $1', [jti]),
      ).rejects.toThrow();
    });
  });

  it('уборка убирает истёкшие записи и не трогает действующие', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const active = `jti-${uuidv7()}`;
      const expired = `jti-${uuidv7()}`;
      await c.query(
        `INSERT INTO identity.revoked_tokens (jti, user_id, expires_at, reason)
              VALUES ($1, $2, now() + interval '1 hour', 'logout'),
                     ($3, $2, now() - interval '1 hour', 'logout')`,
        [active, alice.id, expired],
      );

      // Уборка идёт БЕЗ пользовательского контекста — так её и выполняет core.
      // Права уборки принадлежат роли обслуживания (M039), а не доставке
      // уведомлений: та лишь читает реестр на входе.
      await actAs(c, { userId: null, roles: [], dbRole: 'app_maintenance' });
      const { rows } = await c.query<{ jti: string }>(
        'DELETE FROM identity.revoked_tokens WHERE expires_at < now() RETURNING jti',
      );
      // Ровно одна запись: удаление ДЕЙСТВУЮЩЕЙ вернуло бы отозванному токену
      // силу, а ноль записей означало бы, что реестр растёт без уборки.
      expect(rows.map((r) => r.jti)).toEqual([expired]);
    });
  });
});

describe('RLS: роль планового обслуживания (M039)', () => {
  /** Билет на загрузку: строка материала без подтверждения. */
  async function createTicket(
    c: Client,
    projectId: string,
    userId: string,
    ageHours: number,
    uploaded: boolean,
    version = 1,
  ): Promise<string> {
    const id = uuidv7();
    await c.query(
      // Размер проставляется вместе с отметкой загрузки, а не отдельно:
      // подтверждённый объект без известного размера — состояние, которого не
      // бывает, и схема его больше не принимает (M047). Помощник создавал
      // именно его — ограничение это и поймало.
      `INSERT INTO lab.project_materials
         (id, project_id, type, version, s3_key, parse_status, uploaded_by, created_at,
          uploaded_at, size_bytes)
       VALUES ($1, $2, 'deck', $7, $3, 'queued', $4,
               now() - ($5 || ' hours')::interval,
               CASE WHEN $6 THEN now() ELSE NULL END,
               CASE WHEN $6 THEN 1024 ELSE NULL END)`,
      [
        id,
        projectId,
        `projects/${projectId}/materials/deck/${id}`,
        userId,
        String(ageHours),
        uploaded,
        version,
      ],
    );
    return id;
  }

  it('видит только брошенные билеты старше часа', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const project = await createProject(c, founder.id);
      const abandoned = await createTicket(c, project, founder.id, 5, false, 1);
      const fresh = await createTicket(c, project, founder.id, 0, false, 2);
      const confirmed = await createTicket(c, project, founder.id, 5, true, 3);

      await actAs(c, { userId: null, roles: [], dbRole: 'app_maintenance' });
      const { rows } = await c.query<{ id: string }>('SELECT id FROM lab.project_materials');
      const visible = rows.map((r) => r.id);
      expect(visible).toContain(abandoned);
      // Свежий билет — возможно, загрузка ещё идёт: подписанная форма живёт
      // до часа. Подтверждённый материал роли обслуживания не виден вовсе.
      expect(visible).not.toContain(fresh);
      expect(visible).not.toContain(confirmed);
    });
  });

  it('не может удалить подтверждённый материал', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const project = await createProject(c, founder.id);
      const confirmed = await createTicket(c, project, founder.id, 48, true);

      await actAs(c, { userId: null, roles: [], dbRole: 'app_maintenance' });
      const { rowCount } = await c.query('DELETE FROM lab.project_materials WHERE id = $1', [
        confirmed,
      ]);
      // Уборка, способная удалить настоящий материал, — это не уборка.
      expect(rowCount).toBe(0);
    });
  });

  it('не может читать проекты и персональные данные', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      await createProject(c, founder.id);

      await actAs(c, { userId: null, roles: [], dbRole: 'app_maintenance' });
      // Роль обслуживания знает только о мусоре, который убирает.
      await expect(c.query('SELECT count(*) FROM lab.projects')).rejects.toThrow();
      await expect(c.query('SELECT count(*) FROM identity.users')).rejects.toThrow();
    });
  });

  it('убирает брошенный билет', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const project = await createProject(c, founder.id);
      const abandoned = await createTicket(c, project, founder.id, 48, false);

      await actAs(c, { userId: null, roles: [], dbRole: 'app_maintenance' });
      const { rowCount } = await c.query('DELETE FROM lab.project_materials WHERE id = $1', [
        abandoned,
      ]);
      // Контроль: политика ограничивает уборку, а не запрещает её.
      expect(rowCount).toBe(1);
    });
  });
});
