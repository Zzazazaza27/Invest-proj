/**
 * Реестр классов данных обязан покрывать базу целиком.
 *
 * Смысл проверки — не в аккуратности, а в безопасности уборки. Любая команда,
 * которая что-то удаляет, спрашивает у реестра «что это за таблица». Таблица,
 * которой в реестре нет, — это либо молчаливое «удалять можно», либо
 * молчаливое «трогать нельзя»; и то и другое решает не человек, а случай.
 * Поэтому новая таблица без записи в реестре роняет прогон.
 */
import { describe, expect, it, afterAll } from 'vitest';
import { closePool, getPool } from './helpers.ts';
import { DATA_CLASSES, PREFIX_CLASSES, classOf, exportableTables } from '../src/data-classes.ts';

afterAll(async () => {
  await closePool();
});

/** Таблицы базы, кроме служебных схем и внутренней кухни pg_partman. */
async function tablesInDatabase(): Promise<string[]> {
  const { rows } = await getPool().query<{ name: string }>(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast','partman')
      ORDER BY 1`,
  );
  return rows.map((r) => r.name);
}

describe('Классы данных: реестр покрывает базу', () => {
  it('каждая таблица отнесена к классу', async () => {
    const missing = (await tablesInDatabase()).filter((name) => classOf(name) === null);
    expect(
      missing,
      `Таблицы без класса данных: ${missing.join(', ')}. ` +
        'Добавьте запись в database/src/data-classes.ts — от неё зависит, ' +
        'удалит ли уборка эти строки.',
    ).toEqual([]);
  });

  it('в реестре нет записей о несуществующих таблицах', async () => {
    const existing = new Set(await tablesInDatabase());
    const stale = Object.keys(DATA_CLASSES).filter((name) => !existing.has(name));
    expect(stale, `Реестр помнит удалённые таблицы: ${stale.join(', ')}`).toEqual([]);
  });

  it('правила по префиксу кого-то покрывают', async () => {
    // Иначе правило живёт как мёртвый код и создаёт ложное чувство покрытия:
    // разделы журнала событий заводит pg_partman, и если их не стало —
    // изменилось что-то существенное, а не оформление реестра.
    const tables = await tablesInDatabase();
    for (const rule of PREFIX_CLASSES) {
      const covered = tables.filter((name) => !DATA_CLASSES[name] && name.startsWith(rule.prefix));
      expect(
        covered.length,
        `правило «${rule.prefix}» не покрывает ни одной таблицы`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('Классы данных: выгрузка содержимого', () => {
  it('выгружаются только таблицы содержимого', () => {
    for (const name of exportableTables()) {
      expect(DATA_CLASSES[name]?.kind, `${name} выгружается, но это не content`).toBe('content');
    }
  });

  it('секреты не выгружаются', () => {
    // Список именной, а не по догадке: таблица с ключами провайдеров или
    // подписями вебхуков не должна попасть в Git даже случайной правкой
    // одного поля в реестре.
    const secretHolders = [
      'scoring.ai_provider_credentials',
      'integration.service_accounts',
      'integration.webhook_endpoints',
    ];
    for (const name of secretHolders) {
      expect(DATA_CLASSES[name]?.exportable, `${name} не должна выгружаться`).toBe(false);
    }
  });

  it('данные людей не попадают в выгрузку', () => {
    // Класс `operational` — это участники и их записи. Ни одна такая таблица
    // не выгружается: комплект содержимого едет в Git.
    const operationalExported = Object.entries(DATA_CLASSES).filter(
      ([, value]) => value.kind === 'operational' && value.exportable === true,
    );
    expect(operationalExported.map(([name]) => name)).toEqual([]);
  });

  it('журнал не относится к удаляемым классам', () => {
    // Хеш-цепочка журнала и неизменяемость акцептов — ограничения базы.
    // Если эти таблицы окажутся в `run` или `operational`, уборка однажды
    // попробует их удалить и упрётся в ограничение уже на проде.
    expect(classOf('audit.events_p20260901')).toBe('journal');
    expect(classOf('identity.consents')).toBe('journal');
    expect(classOf('audit.outbox_events')).toBe('journal');
  });
});
