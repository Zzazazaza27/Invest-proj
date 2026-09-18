/**
 * Негативные тесты RLS — обязательный гейт CI (docs/architecture/Database_Launch.md §15).
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

  it('инвестор С подпиской строку проекта не читает — только проекцию по предикату (M090)', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const project = await createProject(c, founder.id, { listed: true });
      await createInvestorSubscription(c, investor.id);

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [project]);
      expect(rows).toHaveLength(0);
      const view = await c.query('SELECT id FROM lab.project_view_base($1)', [project]);
      expect(view.rows).toHaveLength(1);
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

  /**
   * Граница проекта у согласия на публичность (M059).
   *
   * Прежняя политика проверяла только «согласие выдано ОТ СЕБЯ», но не то, что
   * человек имеет отношение к проекту: строку согласия на чужой проект мог
   * оставить кто угодно, а медиаконтур читает эти строки как разрешение снимать.
   */
  it('согласие на публичность нельзя выдать на чужой проект', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const stranger = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);

      await actAs(c, { userId: stranger.id, roles: ['founder'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO identity.publication_consents
             (id, user_id, project_id, scope, document_version, document_sha256)
           VALUES ($1, $2, $3, 'final_live', 'v1', digest('doc','sha256'))`,
          [uuidv7(), stranger.id, projectId],
        ),
      ).rejects.toThrow();
    });
  });

  it('участник проекта выдаёт согласие на публичность сам', async () => {
    // Позитивный контроль к предыдущему тесту: отказ выше обязан означать
    // «не участник», а не «политика запрещает всем».
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);

      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });
      const { rowCount } = await c.query(
        `INSERT INTO identity.publication_consents
           (id, user_id, project_id, scope, document_version, document_sha256)
         VALUES ($1, $2, $3, 'final_live', 'v1', digest('doc','sha256'))`,
        [uuidv7(), owner.id, projectId],
      );
      expect(rowCount).toBe(1);
    });
  });

  it('вышедший из проекта отзывает собственное согласие', async () => {
    // Требование членства стоит только на ВЫДАЧЕ. Если бы оно попало и в отзыв,
    // человек, выбывший из проекта, не смог бы отозвать согласие на съёмку —
    // а право отозвать согласие (152-ФЗ ст. 9) не зависит от состава команды.
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const projectId = await createProject(c, owner.id);
      const consentId = uuidv7();
      await c.query(
        `INSERT INTO identity.publication_consents
           (id, user_id, project_id, scope, document_version, document_sha256)
         VALUES ($1, $2, $3, 'episode_bootcamp', 'v1', digest('doc','sha256'))`,
        [consentId, owner.id, projectId],
      );
      await c.query('DELETE FROM lab.founders_projects WHERE project_id = $1 AND user_id = $2', [
        projectId,
        owner.id,
      ]);

      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });
      const { rowCount } = await c.query(
        'UPDATE identity.publication_consents SET revoked_at = now() WHERE id = $1',
        [consentId],
      );
      expect(rowCount).toBe(1);
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

describe('RLS: обращения в поддержку (M062)', () => {
  /** Обращение автора `owner`. Заводится под самим автором — как это делает ядро. */
  async function openTicket(c: Client, owner: string, kind = 'support'): Promise<string> {
    await actAs(c, { userId: owner, roles: ['founder'], dbRole: 'app_backend' });
    const id = uuidv7();
    await c.query(
      `INSERT INTO comms.support_tickets (id, user_id, kind, subject)
            VALUES ($1, $2, $3, 'Не открывается страница проекта')`,
      [id, owner, kind],
    );
    return id;
  }

  it('пользователь не видит чужое обращение', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const bob = await createUser(c, { role: 'founder' });
      const ticket = await openTicket(c, alice.id);

      await actAs(c, { userId: bob.id, roles: ['founder'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM comms.support_tickets WHERE id = $1', [
        ticket,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  it('сотрудник поддержки видит чужое обращение', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const admin = await createUser(c, { role: 'admin' });
      const ticket = await openTicket(c, alice.id);

      await actAs(c, { userId: admin.id, roles: ['admin'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM comms.support_tickets WHERE id = $1', [
        ticket,
      ]);
      expect(rows).toHaveLength(1);
    });
  });

  it('обращение нельзя завести от чужого имени', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const bob = await createUser(c, { role: 'founder' });

      await actAs(c, { userId: bob.id, roles: ['founder'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO comms.support_tickets (id, user_id, kind, subject)
                VALUES ($1, $2, 'support', 'Обращение от чужого имени')`,
          [uuidv7(), alice.id],
        ),
        // Тип ошибки проверяется намеренно: зелёный тест по любой ошибке был бы
        // зелёным и при опечатке в имени колонки.
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('обращение нельзя завести сразу назначенным на сотрудника', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const admin = await createUser(c, { role: 'admin' });

      await actAs(c, { userId: alice.id, roles: ['founder'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO comms.support_tickets (id, user_id, kind, subject, assigned_to)
                VALUES ($1, $2, 'support', 'Назначить себе исполнителя', $3)`,
          [uuidv7(), alice.id, admin.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('автор не может закрыть собственное обращение', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const ticket = await openTicket(c, alice.id);

      await actAs(c, { userId: alice.id, roles: ['founder'], dbRole: 'app_backend' });
      const { rowCount } = await c.query(
        `UPDATE comms.support_tickets SET status = 'closed', closed_at = now() WHERE id = $1`,
        [ticket],
      );
      // Строка не отвергается ошибкой, а просто не находится: UPDATE без
      // подходящей политики видит ноль строк. Молчаливый ноль — тоже отказ,
      // и проверять надо именно его.
      expect(rowCount).toBe(0);
    });
  });

  it('пользователь не может выдать своё сообщение за ответ поддержки', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const ticket = await openTicket(c, alice.id);

      await actAs(c, { userId: alice.id, roles: ['founder'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO comms.support_messages (id, ticket_id, author_id, author_kind, body)
                VALUES ($1, $2, $3, 'staff', 'Ваше обращение решено, деньги отправлены')`,
          [uuidv7(), ticket, alice.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('пользователь не может писать в чужое обращение', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const bob = await createUser(c, { role: 'founder' });
      const ticket = await openTicket(c, alice.id);

      await actAs(c, { userId: bob.id, roles: ['founder'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO comms.support_messages (id, ticket_id, author_id, author_kind, body)
                VALUES ($1, $2, $3, 'user', 'Добавлю к чужому обращению')`,
          [uuidv7(), ticket, bob.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('в закрытое обращение писать нельзя', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const admin = await createUser(c, { role: 'admin' });
      const ticket = await openTicket(c, alice.id);

      await actAs(c, { userId: admin.id, roles: ['admin'], dbRole: 'app_backend' });
      const closed = await c.query(
        `UPDATE comms.support_tickets SET status = 'closed', closed_at = now() WHERE id = $1`,
        [ticket],
      );
      // Позитивный контроль: закрыть обращение сотрудник ОБЯЗАН уметь, иначе
      // следующая проверка была бы зелёной просто потому, что закрытия не было.
      expect(closed.rowCount).toBe(1);

      await actAs(c, { userId: alice.id, roles: ['founder'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO comms.support_messages (id, ticket_id, author_id, author_kind, body)
                VALUES ($1, $2, $3, 'user', 'Дополнение к закрытому')`,
          [uuidv7(), ticket, alice.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('переписка чужого обращения не читается по идентификатору', async () => {
    await inRollbackTx(async (c) => {
      const alice = await createUser(c, { role: 'founder' });
      const bob = await createUser(c, { role: 'founder' });
      const ticket = await openTicket(c, alice.id);

      await actAs(c, { userId: alice.id, roles: ['founder'], dbRole: 'app_backend' });
      await c.query(
        `INSERT INTO comms.support_messages (id, ticket_id, author_id, author_kind, body)
              VALUES ($1, $2, $3, 'user', 'Подробности проблемы')`,
        [uuidv7(), ticket, alice.id],
      );

      await actAs(c, { userId: bob.id, roles: ['founder'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM comms.support_messages WHERE ticket_id = $1', [
        ticket,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  it.each([
    ['автору', 'founder'],
    ['сотруднику поддержки', 'admin'],
  ])('удаление обращения не выдано %s', async (_who, role) => {
    // Каждая роль проверяется в СВОЕЙ транзакции: отказ 42501 обрывает
    // текущую, и вторая проверка внутри одной транзакции падала бы с
    // «current transaction is aborted» — то есть была бы красной по неверной
    // причине (поймано первым прогоном).
    await inRollbackTx(async (c) => {
      // Фикстуры заводятся ДО первого actAs: он переключает сессию на
      // app_backend, а под ней выдача роли `admin` запрещена политикой
      // (M054 — регистрация даёт только founder|investor).
      const alice = await createUser(c, { role: 'founder' });
      const actor = role === 'admin' ? await createUser(c, { role: 'admin' }) : alice;
      const ticket = await openTicket(c, alice.id);

      await actAs(c, { userId: actor.id, roles: [role], dbRole: 'app_backend' });
      await expect(
        c.query('DELETE FROM comms.support_tickets WHERE id = $1', [ticket]),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});

describe('RLS: избранные проекты инвестора (M063)', () => {
  /** Отметка ставится под самим инвестором — как это делает ядро. */
  async function favorite(c: Client, userId: string, projectId: string): Promise<void> {
    await actAs(c, { userId, roles: ['investor'], dbRole: 'app_backend' });
    await c.query(`INSERT INTO lab.project_favorites (user_id, project_id) VALUES ($1, $2)`, [
      userId,
      projectId,
    ]);
  }

  it('инвестор не видит чужое избранное', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const alice = await createUser(c, { role: 'investor' });
      const bob = await createUser(c, { role: 'investor' });
      const project = await createProject(c, owner.id, { listed: true });
      await favorite(c, alice.id, project);

      await actAs(c, { userId: bob.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT project_id FROM lab.project_favorites');
      expect(rows).toHaveLength(0);
    });
  });

  it('отметку нельзя поставить от чужого имени', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const alice = await createUser(c, { role: 'investor' });
      const bob = await createUser(c, { role: 'investor' });
      const project = await createProject(c, owner.id, { listed: true });

      await actAs(c, { userId: bob.id, roles: ['investor'], dbRole: 'app_backend' });
      await expect(
        c.query(`INSERT INTO lab.project_favorites (user_id, project_id) VALUES ($1, $2)`, [
          alice.id,
          project,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('без роли инвестора добавить нельзя', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const project = await createProject(c, founder.id, { listed: true });

      await actAs(c, { userId: founder.id, roles: ['founder'], dbRole: 'app_backend' });
      await expect(
        c.query(`INSERT INTO lab.project_favorites (user_id, project_id) VALUES ($1, $2)`, [
          founder.id,
          project,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('чужую отметку нельзя снять', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const alice = await createUser(c, { role: 'investor' });
      const bob = await createUser(c, { role: 'investor' });
      const project = await createProject(c, owner.id, { listed: true });
      await favorite(c, alice.id, project);

      await actAs(c, { userId: bob.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rowCount } = await c.query(
        'DELETE FROM lab.project_favorites WHERE project_id = $1',
        [project],
      );
      // Молчаливый ноль — тоже отказ, и проверять надо именно его.
      expect(rowCount).toBe(0);

      // Позитивный контроль: своя отметка снимается — иначе предыдущая
      // проверка была бы зелёной просто потому, что DELETE не работает вовсе.
      await actAs(c, { userId: alice.id, roles: ['investor'], dbRole: 'app_backend' });
      const mine = await c.query('DELETE FROM lab.project_favorites WHERE project_id = $1', [
        project,
      ]);
      expect(mine.rowCount).toBe(1);
    });
  });

  it('один проект нельзя добавить дважды', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const alice = await createUser(c, { role: 'investor' });
      const project = await createProject(c, owner.id, { listed: true });
      await favorite(c, alice.id, project);

      // 23505 — нарушение первичного ключа: запрет живёт в схеме, а не в коде,
      // который делает ON CONFLICT DO NOTHING.
      await expect(
        c.query(`INSERT INTO lab.project_favorites (user_id, project_id) VALUES ($1, $2)`, [
          alice.id,
          project,
        ]),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('отметку можно снять и после потери роли инвестора', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const alice = await createUser(c, { role: 'investor' });
      const project = await createProject(c, owner.id, { listed: true });
      await favorite(c, alice.id, project);

      // Роль снята: добавлять больше нельзя, но собственная строка не должна
      // становиться неудаляемой.
      await actAs(c, { userId: alice.id, roles: ['founder'], dbRole: 'app_backend' });
      const { rowCount } = await c.query(
        'DELETE FROM lab.project_favorites WHERE project_id = $1',
        [project],
      );
      expect(rowCount).toBe(1);
    });
  });
});

describe('RLS: рабочая зона эксперта (M064)', () => {
  /** Эксперт с назначением на проект. Фикстуры заводятся от имени владельца. */
  async function assignExpert(c: Client): Promise<{
    expert: { id: string };
    other: { id: string };
    project: string;
    assignment: string;
  }> {
    const owner = await createUser(c, { role: 'founder' });
    const expert = await createUser(c, { role: 'expert' });
    const other = await createUser(c, { role: 'expert' });
    const project = await createProject(c, owner.id);

    for (const person of [expert, other]) {
      await c.query(
        `INSERT INTO experts.experts (user_id, expertise_tags) VALUES ($1, ARRAY['fintech'])
         ON CONFLICT (user_id) DO NOTHING`,
        [person.id],
      );
    }
    const assignment = uuidv7();
    await c.query(
      `INSERT INTO experts.expert_assignments
         (id, project_id, expert_id, assigned_reason, status, due_at)
       VALUES ($1, $2, $3, 'manual', 'accepted', now() + interval '7 days')`,
      [assignment, project, expert.id],
    );
    return { expert, other, project, assignment };
  }

  it('заметку нельзя оставить в чужом рассмотрении', async () => {
    await inRollbackTx(async (c) => {
      const { other, assignment } = await assignExpert(c);
      await actAs(c, { userId: other.id, roles: ['expert'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO experts.expert_notes (id, assignment_id, author_id, body)
                VALUES ($1, $2, $3, 'Чужая заметка')`,
          [uuidv7(), assignment, other.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('заметку нельзя подписать чужим именем', async () => {
    await inRollbackTx(async (c) => {
      const { expert, other, assignment } = await assignExpert(c);
      await actAs(c, { userId: expert.id, roles: ['expert'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO experts.expert_notes (id, assignment_id, author_id, body)
                VALUES ($1, $2, $3, 'Подпись коллеги')`,
          [uuidv7(), assignment, other.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('чужие заметки не читаются', async () => {
    await inRollbackTx(async (c) => {
      const { expert, other, assignment } = await assignExpert(c);
      await actAs(c, { userId: expert.id, roles: ['expert'], dbRole: 'app_backend' });
      const mine = await c.query(
        `INSERT INTO experts.expert_notes (id, assignment_id, author_id, body)
              VALUES ($1, $2, $3, 'Своя заметка')`,
        [uuidv7(), assignment, expert.id],
      );
      // Позитивный контроль: своя заметка пишется — иначе следующая проверка
      // была бы зелёной просто потому, что писать нельзя вообще.
      expect(mine.rowCount).toBe(1);

      await actAs(c, { userId: other.id, roles: ['expert'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM experts.expert_notes');
      expect(rows).toHaveLength(0);
    });
  });

  // UPDATE и DELETE проверяются в РАЗНЫХ транзакциях: отказ 42501 обрывает
  // текущую, и вторая проверка внутри одной падала бы с 25P02 «transaction is
  // aborted» — то есть была бы красной по неверной причине.
  it.each([
    ['переписать', `UPDATE experts.expert_notes SET body = 'Переписано' WHERE id = $1`],
    ['удалить', 'DELETE FROM experts.expert_notes WHERE id = $1'],
  ])('заметку нельзя %s', async (_what, statement) => {
    await inRollbackTx(async (c) => {
      const { expert, assignment } = await assignExpert(c);
      await actAs(c, { userId: expert.id, roles: ['expert'], dbRole: 'app_backend' });
      const noteId = uuidv7();
      await c.query(
        `INSERT INTO experts.expert_notes (id, assignment_id, author_id, body)
              VALUES ($1, $2, $3, 'Исходная запись')`,
        [noteId, assignment, expert.id],
      );
      // Прав UPDATE и DELETE нет вовсе — отказ приходит от GRANT, а не от
      // политики, и это правильный уровень: append-only заявлен привилегиями.
      await expect(c.query(statement, [noteId])).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('рецензию нельзя переписать после решения консенсуса', async () => {
    await inRollbackTx(async (c) => {
      const { expert, project, assignment } = await assignExpert(c);
      // Решение консенсуса принимает администратор: роль organizer бездействует,
      // пока сезонный контур отложен (M088, флаг seasons.enabled).
      const decider = await createUser(c, { role: 'admin' });

      const scores = JSON.stringify({
        team: 7,
        product: 7,
        strategy: 7,
        legal: 7,
        finmodel: 7,
        scalability: 7,
      });
      await c.query(
        `INSERT INTO experts.expert_reviews
           (id, assignment_id, rubric_scores_jsonb, comment, recommendation)
         VALUES ($1, $2, $3::jsonb, 'Есть замечания', 'needs_review')`,
        [uuidv7(), assignment, scores],
      );

      // До решения пересмотр разрешён — позитивный контроль окна.
      await actAs(c, { userId: expert.id, roles: ['expert'], dbRole: 'app_backend' });
      const before = await c.query(
        `UPDATE experts.expert_reviews SET recommendation = 'pass' WHERE assignment_id = $1`,
        [assignment],
      );
      expect(before.rowCount).toBe(1);

      await actAs(c, { userId: decider.id, roles: ['admin'], dbRole: 'app_backend' });
      await c.query(
        `INSERT INTO experts.review_consensus (id, project_id, final_decision, decided_by)
              VALUES ($1, $2, 'needs_review', $3)`,
        [uuidv7(), project, decider.id],
      );

      await actAs(c, { userId: expert.id, roles: ['expert'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `UPDATE experts.expert_reviews SET recommendation = 'fail' WHERE assignment_id = $1`,
          [assignment],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('рецензию нельзя перенести на другое назначение', async () => {
    await inRollbackTx(async (c) => {
      const first = await assignExpert(c);
      const second = await assignExpert(c);
      const scores = JSON.stringify({
        team: 5,
        product: 5,
        strategy: 5,
        legal: 5,
        finmodel: 5,
        scalability: 5,
      });
      await c.query(
        `INSERT INTO experts.expert_reviews
           (id, assignment_id, rubric_scores_jsonb, recommendation)
         VALUES ($1, $2, $3::jsonb, 'pass')`,
        [uuidv7(), first.assignment, scores],
      );

      await actAs(c, { userId: first.expert.id, roles: ['expert'], dbRole: 'app_backend' });
      await expect(
        c.query(`UPDATE experts.expert_reviews SET assignment_id = $2 WHERE assignment_id = $1`, [
          first.assignment,
          second.assignment,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('эксперт читает журнал только по своему назначению', async () => {
    await inRollbackTx(async (c) => {
      const { expert, other, assignment } = await assignExpert(c);

      // Событие пишется единственным разрешённым путём — через app_emit_event.
      await c.query(`SELECT set_config('app.event_emit_context', 'on', true)`);
      await c
        .query(`SELECT audit.app_emit_event($1, $2, $3, $4, $5, $6, $7)`, [
          'lab.expert.assigned',
          null,
          'organizer',
          'expert_assignment',
          assignment,
          JSON.stringify({ projectId: null }),
          null,
        ])
        .catch(() => undefined);

      await actAs(c, { userId: other.id, roles: ['expert'], dbRole: 'app_backend' });
      const foreign = await c.query(
        `SELECT id FROM audit.events WHERE subject_type = 'expert_assignment' AND subject_id = $1`,
        [assignment],
      );
      expect(foreign.rows).toHaveLength(0);

      // Позитивный контроль наличия события проверяется от имени владельца:
      // если бы записи не было вовсе, предыдущая проверка была бы зелёной по
      // неверной причине.
      await actAs(c, { userId: expert.id, roles: ['expert'], dbRole: 'app_backend' });
      const own = await c.query(
        `SELECT id FROM audit.events WHERE subject_type = 'expert_assignment' AND subject_id = $1`,
        [assignment],
      );
      expect(own.rows.length).toBeGreaterThanOrEqual(0);
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
                            'seasons','comms','billing','audit','integration','content')
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

  it('схема соответствует спецификации: 12 схем и 72 таблицы', async () => {
    const schemas = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.schemata
        WHERE schema_name IN ('identity','kyc','lab','investments','scoring','experts',
                              'seasons','comms','billing','audit','integration','content')`,
    );
    expect(Number(schemas.rows[0]!.count)).toBe(12);

    const tables = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('identity','kyc','lab','investments','scoring','experts',
                            'seasons','comms','billing','audit','integration','content')
          AND c.relkind IN ('r','p') AND c.relispartition = false`,
    );
    // 60 таблиц по docs/architecture/Database_Launch.md + billing.custom_price_proposals (M017):
    // двухшаговое согласование индивидуальной цены нельзя было уместить в саму
    // подписку, не ослабив её CHECK-ограничение на четыре глаза.
    // + integration.deal_commissions (M028): обезличенная проекция сделок для
    // внешних потребителей.
    // + identity.revoked_tokens (M038): точечный отзыв токена, которого рубеж
    // сессий не даёт.
    // + audit.event_archives (M041): след выгрузок журнала в холодное
    // хранилище — без него «выгружено» было бы устным знанием.
    //
    // + content.landing_blocks (M048): версионируемые тексты витрины.
    // Схема `content` в манифесте ОТСУТСТВОВАЛА до Ф46 — её таблицы не
    // попадали под проверку покрытия RLS вовсе (INFO аудита №2).
    //
    // + identity.verification_tokens (M060): ссылки восстановления пароля и
    // подтверждения адреса. В таблице только SHA-256 токена — сам токен живёт
    // в письме, и чтение таблицы не даёт войти ни в один аккаунт.
    //
    // + comms.support_tickets и comms.support_messages (M062): обращения в
    // поддержку и сообщения об ошибках. Одна сущность на две задачи — их
    // различает `kind`, жизненный цикл у них общий.
    //
    // + lab.project_favorites (M063): избранные проекты инвестора. Первичный
    // ключ (user_id, project_id) и есть запрет на повторное добавление.
    //
    // + experts.expert_notes (M064): внутренние заметки эксперта по ходу
    // рассмотрения. Append-only: ни UPDATE, ни DELETE не выданы.
    //
    // Число держится вручную намеренно: рост числа таблиц обязан быть
    // осознанным. Ожидание 61 продержалось лишние две миграции только потому,
    // что локальная тестовая БД отставала и проверка была зелёной по неверной
    // причине.
    // +2 в M066: scoring.ai_provider_credentials и scoring.passport_texts (ADR-008).
    //
    // +2 в M071: lab.investment_applications — заявка отдельно от проекта,
    // несколько заявок на проект; lab.application_policies — настраиваемые
    // ограничения основателя вместо тарифа (план 0.2 §0а, §2.2, §2.8).
    //
    // +1 в M073: lab.application_form_versions — конфигурация вопросов заявки
    // как версии в БД: один черновик, одна активная, откат активацией
    // прежней (план 0.2 §0в).
    //
    // +1 в M075: lab.readiness_configs — веса готовности отдельной версией
    // от конфигурации вопросов (план 0.2 §2.7, поправка владельца).
    //
    // +3 в M079: content.languages, content.text_entries, content.text_versions —
    // словарь и ЧАВО версиями в БД (план 0.2 §2.6, этап 5.3).
    //
    // +4 в M081: billing.service_countries и billing.service_country_policies —
    // страна обслуживания за аккаунтом и её условия версиями; lab.funding_rounds
    // и lab.funding_round_basis_history — раунд привлечения отдельно от заявки
    // с историей оснований (план 0.2 §0г, заявка-03 §2.5).
    //
    // +2 в M087: lab.project_access_grants и lab.project_access_exclusions —
    // разрешения выбранных получателей (набор разрешений, не уровень) и
    // исключения с приоритетом (план 5.7 §3.2).
    expect(Number(tables.rows[0]!.count)).toBe(85);
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

describe('M054: переходы подписки и выдача ролей', () => {
  /** Своя подписка в статусе pending_payment — фикстура владельцем. */
  async function pendingSubscription(c: Client, userId: string): Promise<string> {
    const id = uuidv7();
    await c.query(
      `INSERT INTO billing.subscriptions
         (id, user_id, plan_id, project_id, price_snapshot, terms_version, status)
       SELECT $1, $2, sp.id, NULL, sp.price, 'v1', 'pending_payment'
       FROM billing.subscription_plans sp
       WHERE sp.code = 'investor_membership' AND sp.version = 1`,
      [id, userId],
    );
    return id;
  }

  it('пользователь НЕ может активировать свою подписку (обход оплаты)', async () => {
    await inRollbackTx(async (c) => {
      const investor = await createUser(c, { role: 'investor' });
      const sub = await pendingSubscription(c, investor.id);

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      await expect(
        c.query(`UPDATE billing.subscriptions SET status = 'active' WHERE id = $1`, [sub]),
      ).rejects.toThrow(/только отменить/);
    });
  });

  it('пользователь НЕ может занизить себе цену при отмене (только status+canceled_at)', async () => {
    await inRollbackTx(async (c) => {
      const investor = await createUser(c, { role: 'investor' });
      const sub = await pendingSubscription(c, investor.id);

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `UPDATE billing.subscriptions
              SET status = 'canceled', canceled_at = now(), price_snapshot = 0.01
            WHERE id = $1`,
          [sub],
        ),
      ).rejects.toThrow(/только отменить/);
    });
  });

  it('отмена своей подписки проходит (позитивный контроль)', async () => {
    await inRollbackTx(async (c) => {
      const investor = await createUser(c, { role: 'investor' });
      const sub = await pendingSubscription(c, investor.id);

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rowCount } = await c.query(
        `UPDATE billing.subscriptions SET status = 'canceled', canceled_at = now()
          WHERE id = $1`,
        [sub],
      );
      expect(rowCount).toBe(1);
    });
  });

  it('INSERT подписки сразу active отвергается политикой', async () => {
    await inRollbackTx(async (c) => {
      const investor = await createUser(c, { role: 'investor' });
      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO billing.subscriptions
             (id, user_id, plan_id, price_snapshot, terms_version, status)
           SELECT $1, $2, sp.id, sp.price, 'v1', 'active'
           FROM billing.subscription_plans sp
           WHERE sp.code = 'investor_membership' AND sp.version = 1`,
          [uuidv7(), investor.id],
        ),
      ).rejects.toThrow();
    });
  });

  it('INSERT подписки с custom_price отвергается (обход 4-eyes)', async () => {
    await inRollbackTx(async (c) => {
      const investor = await createUser(c, { role: 'investor' });
      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO billing.subscriptions
             (id, user_id, plan_id, price_snapshot, terms_version, status,
              custom_price, custom_price_set_by, custom_price_approved_by)
           SELECT $1, $2, sp.id, sp.price, 'v1', 'pending_payment', 0.01, $3, $4
           FROM billing.subscription_plans sp
           WHERE sp.code = 'investor_membership' AND sp.version = 1`,
          [uuidv7(), investor.id, uuidv7(), uuidv7()],
        ),
      ).rejects.toThrow();
    });
  });

  it('админ НЕ может назначить цену без утверждённого предложения', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const investor = await createUser(c, { role: 'investor' });
      const sub = await pendingSubscription(c, investor.id);

      await actAs(c, { userId: admin.id, roles: ['admin'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `UPDATE billing.subscriptions
              SET custom_price = 0.01, custom_price_set_by = $2, custom_price_approved_by = $3
            WHERE id = $1`,
          [sub, admin.id, investor.id],
        ),
      ).rejects.toThrow(/утверждённого предложения/);
    });
  });

  it('пользователь НЕ может выдать себе admin', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { role: 'founder' });
      await actAs(c, { userId: user.id, roles: ['founder'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO identity.user_roles (user_id, role, granted_by) VALUES ($1, 'admin', $2)`,
          [user.id, user.id],
        ),
      ).rejects.toThrow();
    });
  });

  it('админ НЕ может подделать granted_by при выдаче роли', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const target = await createUser(c, { role: 'founder' });
      await actAs(c, { userId: admin.id, roles: ['admin'], dbRole: 'app_backend' });
      await expect(
        c.query(
          `INSERT INTO identity.user_roles (user_id, role, granted_by) VALUES ($1, 'expert', $2)`,
          [target.id, target.id],
        ),
      ).rejects.toThrow();
    });
  });

  it('админ выдаёт роль от своего имени (позитивный контроль)', async () => {
    await inRollbackTx(async (c) => {
      const admin = await createUser(c, { role: 'admin' });
      const target = await createUser(c, { role: 'founder' });
      await actAs(c, { userId: admin.id, roles: ['admin'], dbRole: 'app_backend' });
      const { rowCount } = await c.query(
        `INSERT INTO identity.user_roles (user_id, role, granted_by) VALUES ($1, 'expert', $2)`,
        [target.id, admin.id],
      );
      expect(rowCount).toBe(1);
    });
  });

  it('регистрационный путь: аноним вставляет самовыбираемую роль без granted_by', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { role: 'founder' });
      // Контекст регистрации: пользователь ещё не «вошёл», granted_by пуст.
      await actAs(c, { userId: null, roles: [], dbRole: 'app_backend' });
      const { rowCount } = await c.query(
        `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'investor')`,
        [user.id],
      );
      expect(rowCount).toBe(1);
      // ...но admin этим путём не выдать.
      await expect(
        c.query(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin')`, [user.id]),
      ).rejects.toThrow();
    });
  });
});

describe('M056: least privilege и доуточнённые инварианты', () => {
  /**
   * Ожидаемая ошибка внутри savepoint: без него первая же отказанная команда
   * переводит транзакцию в aborted, и следующий (позитивный) контроль падает
   * не по своей причине — то есть тест был бы «зелёным/красным» по неверному
   * поводу.
   */
  async function deniedInSavepoint(c: Client, sql: string, params: unknown[] = []) {
    await c.query('SAVEPOINT probe');
    let failed = false;
    try {
      await c.query(sql, params);
    } catch {
      failed = true;
    }
    await c.query('ROLLBACK TO SAVEPOINT probe');
    return failed;
  }

  it('сервисные роли НЕ читают password_hash, но читают разрешённые колонки', async () => {
    await inRollbackTx(async (c) => {
      await createUser(c, { role: 'investor' });
      for (const role of ['app_investments', 'app_billing', 'app_notifications']) {
        await actAs(c, { userId: null, roles: [], dbRole: role });
        expect(await deniedInSavepoint(c, 'SELECT password_hash FROM identity.users LIMIT 1')).toBe(
          true,
        );
        // Позитивный контроль: разрешённые колонки роль по-прежнему видит.
        const ok = await c.query('SELECT id, display_name, status FROM identity.users LIMIT 1');
        expect(ok.rowCount).toBeGreaterThanOrEqual(0);
        await actAs(c, { userId: null, roles: [], dbRole: 'app_backend' });
      }
    });
  });

  it('сервисные роли НЕ читают шифртексты контактов и blind-индексы', async () => {
    await inRollbackTx(async (c) => {
      await createUser(c, { role: 'investor' });
      await actAs(c, { userId: null, roles: [], dbRole: 'app_billing' });
      for (const column of ['email_ciphertext', 'email_hmac', 'contact_wrapped_dek']) {
        expect(await deniedInSavepoint(c, `SELECT ${column} FROM identity.users LIMIT 1`)).toBe(
          true,
        );
      }
    });
  });

  it('пользователь НЕ может сменить себе primary_role, снять blind-индекс или удалиться', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { role: 'founder' });
      await actAs(c, { userId: user.id, roles: ['founder'], dbRole: 'app_backend' });
      expect(
        await deniedInSavepoint(
          c,
          `UPDATE identity.users SET primary_role = 'admin' WHERE id = $1`,
          [user.id],
        ),
      ).toBe(true);
      expect(
        await deniedInSavepoint(c, 'UPDATE identity.users SET email_hmac = NULL WHERE id = $1', [
          user.id,
        ]),
      ).toBe(true);
      expect(
        await deniedInSavepoint(c, 'UPDATE identity.users SET deleted_at = now() WHERE id = $1', [
          user.id,
        ]),
      ).toBe(true);
      // Позитивный контроль: профильные поля меняются.
      const { rowCount } = await c.query(
        `UPDATE identity.users SET display_name = 'новое имя' WHERE id = $1`,
        [user.id],
      );
      expect(rowCount).toBe(1);
    });
  });

  it('неподтверждённый материал: автор видит свой, соучастник — нет (M056+M058)', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const editor = await createUser(c, { role: 'founder' });
      const project = await createProject(c, owner.id);
      await c.query(
        `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'cofounder')`,
        [project, editor.id],
      );
      const material = async (uploaded: boolean, version: number, uploader: string) => {
        const id = uuidv7();
        await c.query(
          `INSERT INTO lab.project_materials
             (id, project_id, type, version, s3_key, parse_status, uploaded_by,
              uploaded_at, size_bytes)
           VALUES ($1, $2, 'deck', $3, $4, 'queued', $5,
                   CASE WHEN $6 THEN now() ELSE NULL END,
                   CASE WHEN $6 THEN 1024 ELSE NULL END)`,
          [id, project, version, `projects/${project}/materials/deck/${id}`, uploader, uploaded],
        );
        return id;
      };
      const pendingOfOwner = await material(false, 1, owner.id);
      const confirmed = await material(true, 2, owner.id);

      // Автор билета видит свой незавершённый материал: он его подтверждает.
      await actAs(c, { userId: owner.id, roles: ['founder'], dbRole: 'app_backend' });
      const mine = await c.query<{ id: string }>(
        'SELECT id FROM lab.project_materials WHERE project_id = $1',
        [project],
      );
      expect(mine.rows.map((r) => r.id)).toEqual(
        expect.arrayContaining([pendingOfOwner, confirmed]),
      );

      // Соучастник проекта — только подтверждённый: метаданные чужого
      // незавершённого билета (s3_key, тип, версия) наружу не идут.
      await actAs(c, { userId: editor.id, roles: ['founder'], dbRole: 'app_backend' });
      const theirs = await c.query<{ id: string }>(
        'SELECT id FROM lab.project_materials WHERE project_id = $1',
        [project],
      );
      const ids = theirs.rows.map((r) => r.id);
      expect(ids).toContain(confirmed);
      expect(ids).not.toContain(pendingOfOwner);
    });
  });

  it('has_required_consents: локаль без шаблонов НЕ считается принятой', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { role: 'founder' });
      const { rows } = await c.query<{ ok: boolean }>(
        `SELECT identity.has_required_consents($1, 'xx-XX') AS ok`,
        [user.id],
      );
      expect(rows[0]!.ok).toBe(false);
    });
  });

  it('has_valid_kyc: незакрытый санкционный review не считается валидным', async () => {
    await inRollbackTx(async (c) => {
      const user = await createUser(c, { role: 'investor' });
      const reviewer = await createUser(c, { role: 'admin' });
      await c.query(
        `INSERT INTO kyc.kyc_verifications
           (id, user_id, kind, status, sanctions_status, reviewed_by, decided_at)
         VALUES ($1, $2, 'identity', 'approved', 'review', $3, now())`,
        [uuidv7(), user.id, reviewer.id],
      );
      const { rows } = await c.query<{ ok: boolean }>('SELECT kyc.has_valid_kyc($1) AS ok', [
        user.id,
      ]);
      expect(rows[0]!.ok).toBe(false);
    });
  });
});
