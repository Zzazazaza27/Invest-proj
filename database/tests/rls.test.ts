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
  closePool,
  createProject,
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

  it('инвестор строку проекта не читает — только проекцию по предикату (M090)', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const investor = await createUser(c, { role: 'investor' });
      const project = await createProject(c, founder.id, { listed: true });

      await actAs(c, { userId: investor.id, roles: ['investor'], dbRole: 'app_backend' });
      const { rows } = await c.query('SELECT id FROM lab.projects WHERE id = $1', [project]);
      expect(rows).toHaveLength(0);
      // Проект в режиме «все»: тизер виден, как и анониму, — не шире.
      const view = await c.query('SELECT profile_audience FROM lab.project_view_base($1)', [
        project,
      ]);
      expect(view.rows).toEqual([{ profile_audience: 'public' }]);
    });
  });

  it('удалённые роли (2.1-W05) в сессии не дают ни строк, ни проекций', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const outsider = await createUser(c, { role: 'founder' });
      const hidden = await createProject(c, founder.id, { listed: false });

      // Старый токен мог нести удалённые роли. Ядро их отсекает, но и база не
      // должна давать им ничего, даже если они дошли до GUC.
      await actAs(c, {
        userId: outsider.id,
        roles: ['organizer', 'expert', 'showrunner'],
        dbRole: 'app_backend',
      });
      expect((await c.query('SELECT id FROM lab.projects WHERE id = $1', [hidden])).rows).toEqual(
        [],
      );
      expect((await c.query('SELECT id FROM lab.project_view_base($1)', [hidden])).rows).toEqual(
        [],
      );
      const users = await c.query('SELECT id FROM identity.users');
      expect(users.rows.map((r) => r.id)).toEqual([outsider.id]);
      const roles = await c.query('SELECT user_id FROM identity.user_roles');
      expect(new Set(roles.rows.map((r) => r.user_id))).toEqual(new Set([outsider.id]));
    });
  });
});

describe('RLS: разделение прав между ролями БД', () => {
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

  it('ни одна роль приложения не может писать напрямую в журнал событий', async () => {
    for (const role of ['app_backend', 'app_investments', 'app_billing', 'app_integration']) {
      await inRollbackTx(async (c) => {
        await actAs(c, { userId: null, roles: ['system'], dbRole: role });
        await expect(
          c.query(
            `INSERT INTO audit.events (id, verb, actor_role, context_jsonb)
             VALUES (public.uuid_generate_v7(), 'lab.project.created', 'admin', '{}'::jsonb)`,
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

describe('RLS: уведомления', () => {
  it('пользователь не видит чужих уведомлений и чужих устройств', async () => {
    await inRollbackTx(async (c) => {
      const owner = await createUser(c, { role: 'founder' });
      const intruder = await createUser(c, { role: 'founder' });
      await c.query(
        `INSERT INTO comms.notifications (id, user_id, channel, template_code, payload_jsonb)
         VALUES ($1, $2, 'push', 'listing.published', '{}'::jsonb)`,
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
});

describe('RLS: граница интеграционного контура', () => {
  /**
   * Роль `app_integration` обслуживает ВНЕШНИЕ системы. Проверяется не то, что
   * ей доступно, а то, что ей недоступно: персональные данные, проверки
   * личности и чужая переписка. Отказ здесь — это и есть работающая граница.
   */
  const forbidden: [string, string][] = [
    ['персональные данные пользователей', 'SELECT id FROM identity.users LIMIT 1'],
    ['верификации KYC', 'SELECT id FROM kyc.kyc_verifications LIMIT 1'],
    ['очередь уведомлений', 'SELECT id FROM comms.notifications LIMIT 1'],
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

describe('RLS: покрытие манифеста', () => {
  it('каждая доменная таблица имеет ENABLE + FORCE RLS и хотя бы одну политику', async () => {
    const { rows } = await getPool().query<{ table_name: string; reason: string }>(
      `SELECT n.nspname || '.' || c.relname AS table_name,
              CASE WHEN NOT c.relrowsecurity THEN 'RLS не включён'
                   WHEN NOT c.relforcerowsecurity THEN 'RLS не FORCE'
                   ELSE 'нет ни одной политики' END AS reason
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('identity','kyc','lab','comms','billing','audit','integration',
                            'content','testing')
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

  it('схема соответствует спецификации: 9 схем и 52 таблицы', async () => {
    const schemas = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.schemata
        WHERE schema_name IN ('identity','kyc','lab','comms','billing','audit','integration',
                              'content','testing')`,
    );
    expect(Number(schemas.rows[0]!.count)).toBe(9);

    const tables = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('identity','kyc','lab','comms','billing','audit','integration',
                            'content','testing')
          AND c.relkind IN ('r','p') AND c.relispartition = false`,
    );
    // 60 таблиц по docs/architecture/Database_Launch.md.
    // − billing.custom_price_proposals (M094): индивидуальная цена жила ради
    // тарифа основателя t5; вместе с отменённой подпиской основателя ушла и она.
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
    // + 6 таблиц разовой оплаты запуска раунда (M095, 5.9.1): каталог услуг,
    // версии пакетов и их состав, цены докупаемых услуг, покупка и её позиции
    // с денежной базой. Продажи выключены; структуры заведены отдельно от
    // расчёта, чтобы цены настраивались до включения оплаты.
    // + 2 таблицы зачёта услуг в вознаграждение (M096, 5.9.3): версии правила
    // и сами зачёты. Расчёт зачёта выключен — правило не утверждено, — и
    // запись запрещена триггером, пока версия правила выключена.
    // + 4 таблицы разделения прав и ручных денежных записей (M097): каталог
    // функциональных полномочий и выданные полномочия, фиксация возврата по
    // траншу и корректировка вознаграждения. Полномочие говорит «что можно
    // делать», назначение на проект — «с какими объектами»; роль expert сама
    // по себе не даёт ни того, ни другого.
    // + 2 таблицы возможностей тарифов инвестора (M100): каталог и состав
    // версий тарифа. Базовый просмотр помечен и к тарифу не привязывается;
    // платные ограничения выключены до утверждения матрицы владельцем.
    // + 1 таблица уведомлений по порогу суммы раунда (M102, 5.9.5). Порог
    // только уведомляет: вознаграждение, доступ и обязательность участия
    // оператора он не меняет.
    // + 2 таблицы сквозного сценария покупки (M103, 5.9.7): явные допустимые
    // альтернативы пакета (назначает администратор, а не вычисляет цена) и
    // сохранённый выбор основателя до оформления покупки.
    // + 1 таблица уведомлений оператора платежей (M108, 5.9.9): сырое
    // уведомление как пришло. Нужна не для истории: UNIQUE по событию — это и
    // есть защита от повторной обработки одного подтверждения оплаты.
    // + 1 таблица исполнения услуги по позиции покупки (M111, 6.1): чем и по
    // какой версии заявки закрыта оплаченная услуга. Без неё «выполнено»
    // означало бы только галочку сотрудника.
    // + 1 таблица расхождений по платежам (M114): проверенное сообщение
    // оператора, которое нельзя ни применить как обычное подтверждение, ни
    // выбросить. Возвратов отсюда не происходит — это материал для сверки.
    // + 1 таблица логотипа и обложки проекта (M119, 7.2). Байты лежат в
    // приватном хранилище; читает строку тот, кому виден проект, — политика
    // стоит на том же предикате аудитории, что и сам проект.
    // + 1 таблица аватара пользователя (M125, 6.4). Своя, а не общая с
    // изображениями проекта: другой владелец (человек, а не проект), другая
    // политика доступа и другой жизненный цикл. Читает запись любой вошедший
    // — аватар видно там же, где видно человека; меняет только владелец.
    // + 5 таблиц тестовых сессий (M129, 6.5): сессия, её участники, шаги,
    // перечень созданных объектов и контексты доступа. Схема `testing`
    // добавлена и в запрос покрытия выше — иначе новые таблицы оказались бы
    // вне манифеста RLS, то есть вне той самой гарантии, ради которой он
    // существует.
    // + 1 таблица попыток завершения загрузки (M147, 2.1-W03): окончательный
    // ключ каждой попытки записывается до копирования, чтобы после сбоя найти
    // и копии, не ставшие итоговым файлом.
    //
    // − 62 таблицы и 4 схемы в M150 (2.1-W05): сезоны, инвестиционный процесс
    // (заявки, анкеты, версии, раунды, сделки, биллинг кроме стран
    // обслуживания), экспертиза, анализ ИИ, согласия на публичный контур,
    // профили инвесторов, проекции сделок и внешние ссылки, служебные
    // журналы агентов ИИ. История выше — как было, итог — 50.
    //
    // + comms.operation_notices (M151, 2.1-W04): отметка «итог операции
    // показан пользователю» — одна на пару «операция — пользователь».
    // + audit.control_objects (M153, 2.1-W08a): контрольные объекты наблюдения.
    expect(Number(tables.rows[0]!.count)).toBe(52);
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

describe('RLS: роль планового обслуживания (M039, M147)', () => {
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
      // С M147 незавершённая загрузка лежит по временному ключу формы, а
      // окончательный ключ появляется только у готового материала.
      `INSERT INTO lab.project_materials
         (id, project_id, type, version, s3_key, upload_key, upload_state,
          uploaded_by, created_at, uploaded_at, size_bytes)
       VALUES ($1, $2, 'deck', $7,
               CASE WHEN $6 THEN $3 ELSE NULL END,
               CASE WHEN $6 THEN NULL ELSE $3 || '/upload' END,
               CASE WHEN $6 THEN 'ready' ELSE 'pending' END, $4,
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

  it('видит загрузки файлов — и незавершённые, и готовые (M147)', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const project = await createProject(c, founder.id);
      const abandoned = await createTicket(c, project, founder.id, 5, false, 1);
      const fresh = await createTicket(c, project, founder.id, 0, false, 2);
      const confirmed = await createTicket(c, project, founder.id, 5, true, 3);

      await actAs(c, { userId: null, roles: [], dbRole: 'app_maintenance' });
      const { rows } = await c.query<{ id: string }>('SELECT id FROM lab.project_materials');
      // Сверке нужны все незавершённые, независимо от возраста, а для
      // повтора — и готовые (уже готовый не завершается второй раз).
      expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([abandoned, fresh, confirmed]));
    });
  });

  it('не может удалить ни один материал (M147: удаления по возрасту нет)', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const project = await createProject(c, founder.id);
      const confirmed = await createTicket(c, project, founder.id, 48, true, 1);
      const abandoned = await createTicket(c, project, founder.id, 48, false, 2);

      await actAs(c, { userId: null, roles: [], dbRole: 'app_maintenance' });
      // Права на DELETE у роли нет вовсе: это и есть защита при откате кода,
      // возвращающем прежнего уборщика.
      await c.query('SAVEPOINT del');
      await expect(
        c.query('DELETE FROM lab.project_materials WHERE id = ANY($1)', [[confirmed, abandoned]]),
      ).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK TO SAVEPOINT del');
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

  it('меняет только незавершённую загрузку, готовую — нет (M147)', async () => {
    await inRollbackTx(async (c) => {
      const founder = await createUser(c, { role: 'founder' });
      const project = await createProject(c, founder.id);
      const confirmed = await createTicket(c, project, founder.id, 1, true, 1);
      const pending = await createTicket(c, project, founder.id, 1, false, 2);

      await actAs(c, { userId: null, roles: [], dbRole: 'app_maintenance' });
      const ready = await c.query(
        `UPDATE lab.project_materials SET last_error = 'проба' WHERE id = $1`,
        [confirmed],
      );
      const open = await c.query(
        `UPDATE lab.project_materials SET last_error = 'проба' WHERE id = $1`,
        [pending],
      );
      expect(ready.rowCount).toBe(0);
      expect(open.rowCount).toBe(1);
    });
  });
});

describe('M054: выдача ролей', () => {
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
          `INSERT INTO identity.user_roles (user_id, role, granted_by) VALUES ($1, 'investor', $2)`,
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
        `INSERT INTO identity.user_roles (user_id, role, granted_by) VALUES ($1, 'investor', $2)`,
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
      for (const role of ['app_notifications']) {
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
      await actAs(c, { userId: null, roles: [], dbRole: 'app_notifications' });
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
             (id, project_id, type, version, s3_key, upload_key, upload_state,
              uploaded_by, uploaded_at, size_bytes)
           VALUES ($1, $2, 'deck', $3,
                   CASE WHEN $6 THEN $4 ELSE NULL END,
                   CASE WHEN $6 THEN NULL ELSE $4 || '/upload' END,
                   CASE WHEN $6 THEN 'ready' ELSE 'pending' END, $5,
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
