import { describe, expect, it } from 'vitest';
import { PROJECT_TRANSITIONS, UpsertNotificationTemplateSchema } from '@fifth/contracts';
import { assertNoPersonalPlaceholders } from '../src/admin/templates.service';
import { collectRoutes, routesToPaths } from '../src/health/openapi.routes';
import { Public, Roles } from '../src/auth/guards';
import { Controller, Get, Post } from '@nestjs/common';

describe('статусы проекта', () => {
  it('воронки этапов нет: черновик и отказ ведут только в архив, архив конечен', () => {
    // Сезонная воронка (заявка, разбор ИИ, экспертиза, буткемп, финал,
    // выпуск) удалена в 2.1-W05. Если переход появится снова, тест обязан
    // упасть, а не подстроиться под таблицу.
    expect(PROJECT_TRANSITIONS).toEqual({
      draft: ['archived'],
      rejected: ['archived'],
      archived: [],
    });
  });
});

describe('шаблоны уведомлений', () => {
  it('пропускает доменные плейсхолдеры', () => {
    expect(() =>
      assertNoPersonalPlaceholders({
        titleTemplate: 'Проект {{project_title}}',
        bodyTemplate: 'Проект «{{project_title}}» опубликован {{date}}.',
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
