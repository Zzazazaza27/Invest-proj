import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { INTEGRATION_SCOPE } from '../integration/service-auth';
import { AUTH_SCHEME, IS_PUBLIC, REQUIRED_ROLES, REQUIRES_STEP_UP } from '../auth/guards';

/**
 * Перечень маршрутов для описания API.
 *
 * Источник — тот же граф контроллеров, по которому Nest маршрутизирует запросы:
 * ни один маршрут нельзя забыть внести, потому что вносить нечего. Ручной
 * список расходится с кодом на первом же коммите, а расхождение в документе
 * хуже его отсутствия — клиент верит документу.
 *
 * Здесь описывается ДОСТУП (аутентификация, роли, скоуп, второй фактор), а не
 * тела запросов: тела выводятся из zod-схем в `openapi.controller.ts`. Связать
 * маршрут с конкретной схемой автоматически нельзя — валидация вызывается
 * внутри метода, — и выдумывать эту связь значило бы обещать неверное.
 */
export interface RouteDescriptor {
  method: string;
  path: string;
  controller: string;
  handler: string;
  auth: 'public' | 'session' | 'integration';
  roles: string[];
  scope: string | null;
  stepUp: boolean;
}

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.OPTIONS]: 'options',
  [RequestMethod.HEAD]: 'head',
  [RequestMethod.ALL]: 'all',
};

/** Класс контроллера: конструктор с прототипом, по которому читаются метаданные. */
export type ControllerClass = new (...args: never[]) => object;

/**
 * Собирает маршруты из классов контроллеров.
 *
 * Метаданные читаются напрямую через Reflect, а не через `Reflector`: функция
 * должна работать и вне контекста запроса — её вызывает и сборка документа, и
 * прогон, проверяющий, что у каждого маршрута объявлен способ доступа.
 */
export function collectRoutes(
  controllers: readonly ControllerClass[],
  apiPrefix: string,
): RouteDescriptor[] {
  const routes: RouteDescriptor[] = [];

  for (const controller of controllers) {
    const controllerPath = normalize(
      (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '',
    );
    const prototype = controller.prototype as object;

    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;

      const methodCode = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (methodCode === undefined) continue;

      const methodPath = normalize(
        (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? '',
      );

      // Метаданные метода перекрывают метаданные класса — так же, как это
      // делает `Reflector.getAllAndOverride` в самих guard'ах. Разойтись эти
      // два прочтения не должны: иначе документ описывает не то, что охраняется.
      const isPublic =
        (Reflect.getMetadata(IS_PUBLIC, handler) as boolean | undefined) ??
        (Reflect.getMetadata(IS_PUBLIC, controller) as boolean | undefined) ??
        false;
      const scheme =
        (Reflect.getMetadata(AUTH_SCHEME, handler) as string | undefined) ??
        (Reflect.getMetadata(AUTH_SCHEME, controller) as string | undefined) ??
        null;
      const roles =
        (Reflect.getMetadata(REQUIRED_ROLES, handler) as string[] | undefined) ??
        (Reflect.getMetadata(REQUIRED_ROLES, controller) as string[] | undefined) ??
        [];
      const stepUp =
        (Reflect.getMetadata(REQUIRES_STEP_UP, handler) as boolean | undefined) ??
        (Reflect.getMetadata(REQUIRES_STEP_UP, controller) as boolean | undefined) ??
        false;
      const scope =
        (Reflect.getMetadata(INTEGRATION_SCOPE, handler) as string | undefined) ??
        (Reflect.getMetadata(INTEGRATION_SCOPE, controller) as string | undefined) ??
        null;

      // Пустой путь означает корень версии — `/v1`, а не пустую строку.
      const path = `/${apiPrefix}${controllerPath}${methodPath}`;

      routes.push({
        method: METHOD_NAMES[methodCode] ?? 'get',
        path,
        controller: controller.name,
        handler: name,
        auth: isPublic ? 'public' : scheme === 'service' ? 'integration' : 'session',
        roles,
        scope,
        stepUp,
      });
    }
  }

  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function normalize(path: string): string {
  if (path === '' || path === '/') return '';
  return path.startsWith('/') ? path : `/${path}`;
}

/** Маршруты в форме OpenAPI `paths`. */
export function routesToPaths(routes: readonly RouteDescriptor[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const operation: Record<string, unknown> = {
      operationId: `${route.controller}.${route.handler}`,
      // Секция security — не украшение: по ней клиент понимает, какой токен
      // предъявлять, а ревьюер видит маршрут, оставшийся без охраны.
      security:
        route.auth === 'public'
          ? []
          : route.auth === 'integration'
            ? [{ integration: route.scope ? [route.scope] : [] }]
            : [{ session: [] }],
      responses: {
        '200': { description: 'Успех' },
        ...(route.auth === 'public' ? {} : { '401': { description: 'Не аутентифицирован' } }),
        ...(route.roles.length > 0 || route.scope || route.stepUp
          ? { '403': { description: 'Недостаточно прав' } }
          : {}),
        '429': { description: 'Превышена частота запросов' },
      },
    };
    if (route.roles.length > 0) operation['x-required-roles'] = route.roles;
    if (route.stepUp) operation['x-step-up-required'] = true;

    // Путь в OpenAPI записывается с фигурными скобками: `:id` — синтаксис Nest,
    // а не спецификации.
    const openApiPath = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    paths[openApiPath] ??= {};
    paths[openApiPath]![route.method] = operation;
  }

  return paths;
}
