import { Controller, Get } from '@nestjs/common';
import * as contracts from '@unicorn/contracts';
import { API_VERSION, INTEGRATION_SCOPES } from '@unicorn/contracts';
import { z } from 'zod';
import { Public } from '../auth/guards';

/**
 * Машиночитаемое описание API.
 *
 * Схемы НЕ описываются здесь заново: они выводятся из `@unicorn/contracts` —
 * тех же самых объектов, которыми сервер валидирует запросы. Ручной OpenAPI
 * расходится с реальностью на первом же изменении и становится вреднее, чем
 * его отсутствие: клиент верит документу, а сервер живёт по коду.
 *
 * Отсюда следует и ограничение, которое честнее назвать вслух: это описание
 * ТИПОВ, а не полный контракт с перечнем маршрутов и кодов ответа. Перечень
 * маршрутов выводится из декораторов Nest и появится вместе со сквозной
 * генерацией; выдавать неполный документ за полный — тот же самый вред.
 */
@Public()
@Controller('openapi.json')
export class OpenApiController {
  @Get()
  document(): Record<string, unknown> {
    return buildOpenApiDocument();
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
export function buildOpenApiDocument(): Record<string, unknown> {
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
      title: 'UNICORN LAUNCH API',
      version: API_VERSION,
      description:
        'Типы запросов и ответов, выведенные из @unicorn/contracts — тех же схем, ' +
        'которыми сервер валидирует вход. Перечень маршрутов в документ пока не ' +
        'входит: он выводится из декораторов и появится отдельно.',
    },
    servers: [{ url: `/${API_VERSION}` }],
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
    'x-integration-scopes': INTEGRATION_SCOPES,
  };
}

function isZodSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}
