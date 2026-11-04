import { Controller, Get } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import * as contracts from '@fifth/contracts';
import { API_VERSION, INTEGRATION_SCOPES } from '@fifth/contracts';
import { z } from 'zod';
import { Ctx, Public } from '../auth/guards';
import { errors } from '../common/errors';
import type { RequestContext } from '../db/unit-of-work';
import {
  collectRoutes,
  routesToPaths,
  type ControllerClass,
  type RouteDescriptor,
} from './openapi.routes';

/**
 * Машиночитаемое описание API.
 *
 * Схемы НЕ описываются здесь заново: они выводятся из `@fifth/contracts` —
 * тех же самых объектов, которыми сервер валидирует запросы. Ручной OpenAPI
 * расходится с реальностью на первом же изменении и становится вреднее, чем
 * его отсутствие: клиент верит документу, а сервер живёт по коду.
 *
 * Перечень маршрутов снимается с живого графа контроллеров (`DiscoveryService`)
 * вместе с требованиями доступа: способ аутентификации, роли, скоуп и
 * необходимость второго фактора. Что по-прежнему НЕ выводится — связь
 * конкретного маршрута с конкретной схемой тела: валидация вызывается внутри
 * обработчика, и такая связь была бы догадкой, а не фактом.
 */
@Public()
@Controller('openapi.json')
export class OpenApiController {
  /**
   * `DiscoveryService`, а не импорт списка контроллеров из модуля: импорт дал бы
   * цикл (модуль объявляет этот контроллер), а список, переписанный руками,
   * разошёлся бы с модулем незаметно.
   */
  constructor(private readonly discovery: DiscoveryService) {}

  /**
   * Описание отдаётся ТОЛЬКО по сессии. Всегда, а не только в production.
   *
   * Документ перечисляет все маршруты, включая административные и
   * интеграционные, вместе с требованиями доступа. Анониму это карта поверхности
   * атаки, полученная одним запросом (SEC-21).
   *
   * Почему не «только в production». Условие было завязано на NODE_ENV, и
   * 2026-09-13 выяснилось, чем это кончается: на боевом стенде стоял
   * `NODE_ENV=development`, и https://vgorkakh.ru/v1/openapi.json отдавал 117
   * маршрутов кому угодно. Защита была написана, но снята одним значением
   * переменной — ровно как три рубежа вокруг служебной консоли.
   *
   * Разработке это не мешает: локально сессия есть, описание открывается. Цена
   * ошибки в конфигурации при этом падает до нуля — спрашиваем сессию, а не
   * окружение.
   *
   * Отказ — 404, а не 403: 403 подтвердил бы, что документ существует.
   */
  @Get()
  document(@Ctx() ctx: RequestContext): Record<string, unknown> {
    if (!ctx.userId) {
      throw errors.notFound({ subject: 'openapi' });
    }
    const controllers = this.discovery
      .getControllers()
      .map((wrapper) => wrapper.metatype)
      .filter((metatype): metatype is ControllerClass => typeof metatype === 'function');
    return buildOpenApiDocument(collectRoutes(controllers, API_VERSION));
  }
}

/**
 * Собирает документ из экспортированных zod-схем.
 *
 * Берутся только схемы (`*Schema`): константы, функции и типы в описание не
 * попадают. Схема, которую не удалось преобразовать, пропускается с пометкой —
 * молча выкинуть её значило бы отдать клиенту неполный документ без единого
 * признака неполноты.
 */
export function buildOpenApiDocument(
  routes: readonly RouteDescriptor[] = [],
): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  const skipped: string[] = [];

  for (const [name, value] of Object.entries(contracts)) {
    if (!name.endsWith('Schema') || !isZodSchema(value)) continue;
    try {
      schemas[name.replace(/Schema$/, '')] = z.toJSONSchema(value, {
        // Ссылки на общие определения делают документ короче, но заставляют
        // клиента резолвить $ref по своему дереву. Для публикуемого контракта
        // самодостаточность важнее размера.
        io: 'output',
        unrepresentable: 'any',
      });
    } catch {
      skipped.push(name);
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Пятый элемент — API',
      version: API_VERSION,
      description:
        'Типы запросов и ответов, выведенные из @fifth/contracts — тех же схем, ' +
        'которыми сервер валидирует вход, и перечень маршрутов, снятый с графа ' +
        'контроллеров вместе с требованиями доступа. Связь конкретного маршрута ' +
        'с конкретной схемой тела не выводится: валидация вызывается внутри ' +
        'обработчика, и такая связь была бы догадкой.',
    },
    servers: [{ url: `/${API_VERSION}` }],
    paths: routesToPaths(routes),
    components: {
      schemas,
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'ul_session',
          description: 'Сессия пользователя. Небезопасные методы требуют заголовок X-CSRF-Token.',
        },
        integration: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Токен сервисного клиента Integration API. Права выражены скоупами: ' +
            INTEGRATION_SCOPES.join(', '),
        },
      },
    },
    // Неполнота объявляется в самом документе, а не остаётся known issue.
    'x-schemas-skipped': skipped,
    'x-routes-total': routes.length,
    'x-integration-scopes': INTEGRATION_SCOPES,
  };
}

function isZodSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}
