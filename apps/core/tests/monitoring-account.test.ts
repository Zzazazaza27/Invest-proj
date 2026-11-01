import { describe, expect, it } from 'vitest';
import { TtlFlags, monitoringAccountRoute } from '../src/auth/monitoring-account';

/**
 * Перечень разрешённого служебной учётке мониторинга (2.5; 2.1-W08a):
 * сессия и чтение карточки и материала проекта; всё прочее — отказ. Что
 * проект именно контрольный, проверяет AuthGuard по БД (M155).
 */
const P = '01a19736-7e8e-7039-b2a4-298dfa3417ce';
const M = '01a19736-8a1b-7000-9d2e-0123456789ab';

describe('Учётка мониторинга: перечень разрешённого', () => {
  it('сессия: «кто я» и выход', () => {
    expect(monitoringAccountRoute('GET', '/v1/auth/me').allowed).toBe(true);
    expect(monitoringAccountRoute('POST', '/v1/auth/logout').allowed).toBe(true);
  });

  it('чтение карточки и материала — разрешено, с идентификатором проекта', () => {
    expect(monitoringAccountRoute('GET', `/v1/projects/${P}/investor-view`)).toEqual({
      allowed: true,
      projectId: P,
    });
    expect(monitoringAccountRoute('GET', `/v1/projects/${P}/materials/${M}/content?x=1`)).toEqual({
      allowed: true,
      projectId: P,
    });
  });

  it('изменение профиля, аватар, создание проекта, список, админка — отказ', () => {
    const denied: Array<[string, string]> = [
      ['PATCH', '/v1/me/profile'],
      ['POST', '/v1/me/avatar/upload'],
      ['POST', '/v1/me/avatar'],
      ['DELETE', '/v1/me/avatar'],
      ['POST', '/v1/projects'],
      ['GET', '/v1/projects'],
      ['GET', '/v1/me/profile'],
      ['GET', '/v1/admin/users'],
      ['PUT', `/v1/investor/favorites/${P}`],
      ['POST', '/v1/support'],
    ];
    for (const [method, url] of denied) {
      expect(monitoringAccountRoute(method, url).allowed, `${method} ${url}`).toBe(false);
    }
  });

  it('не GET к разрешённому пути — отказ', () => {
    expect(monitoringAccountRoute('POST', `/v1/projects/${P}/investor-view`).allowed).toBe(false);
    expect(
      monitoringAccountRoute('DELETE', `/v1/projects/${P}/materials/${M}/content`).allowed,
    ).toBe(false);
  });

  it('путь с хвостом или обходом — отказ', () => {
    expect(monitoringAccountRoute('GET', `/v1/projects/${P}/investor-view/../access`).allowed).toBe(
      false,
    );
    expect(monitoringAccountRoute('GET', `/v1/projects/${P}/access`).allowed).toBe(false);
  });
});

describe('Кеш признаков', () => {
  it('в пределах срока не загружает повторно', async () => {
    const flags = new TtlFlags(60_000);
    let loads = 0;
    const load = async () => {
      loads += 1;
      return true;
    };
    await flags.get('u:1', load);
    await flags.get('u:1', load);
    expect(loads).toBe(1);
  });
});
