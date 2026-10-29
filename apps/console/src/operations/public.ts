import type { OperationGroup } from '../types';
import {
  optionalMoney,
  optionalNum,
  optionalStr,
  str,
  LOCALE_OPTIONS,
  PROJECT_STAGE_OPTIONS,
} from './shared';

/**
 * Публичный контур: то, что доступно без входа.
 *
 * С этой группы начинается любой прогон — она отвечает на вопрос «жив ли
 * стенд вообще» до того, как отказ в аутентификации будет принят за поломку
 * сервера.
 */
export const publicGroup: OperationGroup = {
  id: 'public',
  title: 'Публичное (без входа)',
  note: 'Доступно неаутентифицированному пользователю.',
  operations: [
    {
      id: 'health',
      title: 'Проверка живости',
      method: 'GET',
      path: '/v1/health',
      summary:
        'Отвечает ли ядро. Первое, что стоит вызвать: отказ здесь снимает вопросы к остальному.',
      run: (_values, { api }) => api.health(),
    },
    {
      id: 'taxonomy',
      title: 'Справочник направлений',
      method: 'GET',
      path: '/v1/taxonomy',
      summary:
        'Идентификаторы направлений. Отсюда берётся taxonomyId для создания проекта — угадать его нельзя.',
      remembers: { taxonomyId: '0.id' },
      run: (_values, { api }) => api.taxonomy(),
    },
    {
      id: 'catalog',
      title: 'Каталог проектов',
      method: 'GET',
      path: '/v1/catalog',
      summary: 'Витрина опубликованных проектов. Показывает только то, что разрешено раскрывать.',
      fields: [
        { name: 'q', label: 'Поиск', kind: 'text', placeholder: 'часть названия' },
        {
          name: 'stage',
          label: 'Стадия',
          kind: 'select',
          options: [{ value: '', label: '(любая)' }, ...PROJECT_STAGE_OPTIONS],
        },
        {
          name: 'geoCountry',
          label: 'Страна',
          kind: 'text',
          placeholder: 'RU',
          help: 'ISO 3166-1 alpha-2.',
        },
        { name: 'limit', label: 'Сколько вернуть', kind: 'number', defaultValue: 10 },
      ],
      remembers: { catalogProjectId: 'items.0.id' },
      run: (values, { api }) =>
        api.catalog({
          q: optionalStr(values, 'q'),
          stage: optionalStr(values, 'stage') as never,
          geoCountry: optionalStr(values, 'geoCountry'),
          limit: optionalNum(values, 'limit'),
        }),
    },
    {
      id: 'catalog-item',
      title: 'Карточка проекта в каталоге',
      method: 'GET',
      path: '/v1/catalog/:id',
      summary:
        'Публичная карточка. Сверь её с полной карточкой основателя: наружу не должно уходить лишнего.',
      fields: [
        {
          name: 'catalogProjectId',
          label: 'Идентификатор проекта',
          kind: 'text',
          required: true,
          help: 'Подставляется из блокнота после вызова каталога.',
        },
      ],
      run: (values, { api }) =>
        api.http.request({ path: `/catalog/${str(values, 'catalogProjectId')}` }),
    },
    {
      id: 'landing',
      title: 'Контент витрины',
      method: 'GET',
      path: '/v1/content/landing',
      summary:
        'Блоки публичной страницы. Пустой список — законный ответ: администратор ещё ничего не опубликовал.',
      fields: [
        {
          name: 'locale',
          label: 'Локаль',
          kind: 'select',
          options: LOCALE_OPTIONS,
          defaultValue: 'ru-RU',
        },
      ],
      run: (values, { api }) => api.landingContent(str(values, 'locale')),
    },
    {
      id: 'openapi',
      title: 'Схема OpenAPI',
      method: 'GET',
      path: '/v1/openapi.json',
      summary:
        'Машинный контракт API. По нему новый фронтенд пишется без чтения кода ядра (ADR-002).',
      run: (_values, { api }) => api.http.request({ path: '/openapi.json' }),
    },
  ],
};
