import { describe, expect, it } from 'vitest';
import {
  PROJECT_TRANSITIONS,
  SeasonFunnelConfigSchema,
  UpsertNotificationTemplateSchema,
  type ProjectStatus,
} from '@unicorn/contracts';
import { assertNoPersonalPlaceholders } from '../src/admin/templates.service';
import { collectRoutes, routesToPaths } from '../src/health/openapi.routes';
import { Public, Roles } from '../src/auth/guards';
import { Controller, Get, Post } from '@nestjs/common';

describe('воронка проекта', () => {
  it('движется вперёд ровно на один этап', () => {
    // Порядок этапов дублируется здесь намеренно: если таблица переходов
    // изменится, тест обязан упасть, а не подстроиться под неё.
    const forward: [ProjectStatus, ProjectStatus][] = [
      ['submitted', 'ai_review'],
      ['ai_review', 'expert_review'],
      ['expert_review', 'bootcamp'],
      ['bootcamp', 'finalist'],
      ['finalist', 'graduated'],
    ];
    for (const [from, to] of forward) {
      expect(PROJECT_TRANSITIONS[from]).toContain(to);
    }
  });

  it('не позволяет перепрыгнуть этап', () => {
    expect(PROJECT_TRANSITIONS.submitted).not.toContain('bootcamp');
    expect(PROJECT_TRANSITIONS.expert_review).not.toContain('graduated');
    expect(PROJECT_TRANSITIONS.draft).not.toContain('expert_review');
  });

  it('не имеет обратного хода', () => {
    const order: ProjectStatus[] = [
      'draft',
      'submitted',
      'ai_review',
      'expert_review',
      'bootcamp',
      'finalist',
      'graduated',
    ];
    for (const [index, status] of order.entries()) {
      for (const target of PROJECT_TRANSITIONS[status]) {
        const targetIndex = order.indexOf(target);
        // Выход из воронки (rejected/archived) в порядке отсутствует и проверке
        // на движение назад не подлежит: это не шаг по воронке.
        if (targetIndex >= 0) expect(targetIndex).toBeGreaterThan(index);
      }
    }
  });

  it('отказ доступен с рабочих этапов, но не из терминальных', () => {
    expect(PROJECT_TRANSITIONS.expert_review).toContain('rejected');
    expect(PROJECT_TRANSITIONS.graduated).not.toContain('rejected');
    expect(PROJECT_TRANSITIONS.archived).toHaveLength(0);
  });
});

describe('конфигурация воронки сезона', () => {
  it('принимает пустую конфигурацию как «без ограничений»', () => {
    const parsed = SeasonFunnelConfigSchema.parse({});
    expect(parsed.quotas).toEqual({});
    expect(parsed.schedule).toEqual({});
  });

  it('отвергает нулевую и отрицательную квоту', () => {
    // Квота 0 закрыла бы этап навсегда через настройку, а не решением.
    expect(SeasonFunnelConfigSchema.safeParse({ quotas: { bootcamp: 0 } }).success).toBe(false);
    expect(SeasonFunnelConfigSchema.safeParse({ quotas: { bootcamp: -1 } }).success).toBe(false);
    expect(SeasonFunnelConfigSchema.safeParse({ quotas: { bootcamp: 12 } }).success).toBe(true);
  });

  it('не принимает произвольные этапы', () => {
    const parsed = SeasonFunnelConfigSchema.parse({ quotas: { unknown_stage: 5 } });
    expect(parsed.quotas).not.toHaveProperty('unknown_stage');
  });
});

describe('шаблоны уведомлений', () => {
  it('пропускает доменные плейсхолдеры', () => {
    expect(() =>
      assertNoPersonalPlaceholders({
        titleTemplate: 'Этап сезона {{season_number}}',
        bodyTemplate: 'Проект «{{project_title}}» переведён на {{stage_title}}.',
      }),
    ).not.toThrow();
  });

  it('запрещает персональные данные в тексте', () => {
    for (const placeholder of ['full_name', 'phone', 'email', 'passport_number', 'card']) {
      expect(() =>
        assertNoPersonalPlaceholders({ bodyTemplate: `Здравствуйте, {{${placeholder}}}` }),
      ).toThrow();
    }
  });

  it('ловит персональный плейсхолдер и в заголовке', () => {
    expect(() =>
      assertNoPersonalPlaceholders({
        titleTemplate: 'Счёт для {{full_name}}',
        bodyTemplate: 'Текст без подстановок',
      }),
    ).toThrow();
  });

  it('не даёт назвать шаблон произвольной строкой', () => {
    const base = { channel: 'push', bodyTemplate: 'текст' };
    expect(
      UpsertNotificationTemplateSchema.safeParse({ ...base, code: 'Плохой Код' }).success,
    ).toBe(false);
    expect(UpsertNotificationTemplateSchema.safeParse({ ...base, code: 'season.ok' }).success).toBe(
      true,
    );
  });
});

// -------------------------------------------------------- перечень маршрутов
@Controller('demo')
class DemoController {
  @Public()
  @Get('open')
  open() {
    return null;
  }

  @Roles('admin')
  @Post(':id/close')
  close() {
    return null;
  }
}

describe('перечень маршрутов для описания API', () => {
  it('снимает путь, метод и требования доступа с декораторов', () => {
    const routes = collectRoutes([DemoController], 'v1');
    expect(routes).toHaveLength(2);

    const open = routes.find((r) => r.path === '/v1/demo/open');
    expect(open?.method).toBe('get');
    expect(open?.auth).toBe('public');

    const close = routes.find((r) => r.path === '/v1/demo/:id/close');
    expect(close?.method).toBe('post');
    expect(close?.auth).toBe('session');
    expect(close?.roles).toEqual(['admin']);
  });

  it('переводит параметры пути в форму OpenAPI', () => {
    const paths = routesToPaths(collectRoutes([DemoController], 'v1'));
    expect(Object.keys(paths)).toContain('/v1/demo/{id}/close');
  });

  it('объявляет security у каждой операции', () => {
    const paths = routesToPaths(collectRoutes([DemoController], 'v1')) as Record<
      string,
      Record<string, { security?: unknown }>
    >;
    for (const operations of Object.values(paths)) {
      for (const operation of Object.values(operations)) {
        expect(operation).toHaveProperty('security');
      }
    }
    // Публичный маршрут объявляет ПУСТОЙ список схем — это утверждение
    // «доступ открыт», а не отсутствие информации о доступе.
    expect(paths['/v1/demo/open']!.get!.security).toEqual([]);
  });
});
