import type { OperationGroup } from '../types';
import { idField, jsonValue, optionalMoney, optionalStr, str, LOCALE_OPTIONS } from './shared';

/** Список через запятую → массив. Пустые элементы отбрасываются. */
function list(values: Parameters<typeof str>[0], name: string): string[] {
  return str(values, name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const adminGroup: OperationGroup = {
  id: 'admin',
  title: 'Администрирование',
  note: 'Роль admin. Часть действий требует второго человека — «четыре глаза».',
  operations: [
    {
      id: 'plans-list',
      title: 'Тарифы',
      method: 'GET',
      path: '/v1/admin/plans',
      summary: 'Версии тарифов. Действующая версия одна — это обеспечивается индексом в БД.',
      needsAuth: true,
      remembers: { planId: 'items.0.id' },
      run: (_values, { api }) => api.http.request({ path: '/admin/plans' }),
    },
    {
      id: 'plan-publish',
      title: 'Опубликовать тариф',
      method: 'POST',
      path: '/v1/admin/plans',
      summary: 'Новая версия тарифа. Задним числом опубликовать нельзя — сервер отвергнет прошлое.',
      needsAuth: true,
      fields: [
        { name: 'code', label: 'Код тарифа', kind: 'text', required: true, placeholder: 't1' },
        {
          name: 'audience',
          label: 'Аудитория',
          kind: 'select',
          required: true,
          defaultValue: 'founder',
          options: [
            { value: 'founder', label: 'founder' },
            { value: 'investor', label: 'investor' },
          ],
        },
        { name: 'name', label: 'Название', kind: 'text', required: true, help: '2–160 символов.' },
        { name: 'price', label: 'Цена', kind: 'number', help: 'Пусто — цена не задана.' },
        {
          name: 'askLimit',
          label: 'Предел запроса',
          kind: 'number',
          help: 'Пусто — без ограничения.',
        },
        {
          name: 'individualPricing',
          label: 'Индивидуальная цена',
          kind: 'checkbox',
          defaultValue: false,
        },
        {
          name: 'billingPeriod',
          label: 'Период',
          kind: 'select',
          defaultValue: 'monthly',
          options: [
            { value: 'monthly', label: 'monthly' },
            { value: 'yearly', label: 'yearly' },
          ],
        },
        { name: 'features', label: 'Состав (JSON)', kind: 'json', defaultValue: '{}' },
        {
          name: 'validFrom',
          label: 'Действует с',
          kind: 'text',
          placeholder: '2026-09-01T00:00:00Z',
        },
      ],
      remembers: { planId: 'id' },
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: '/admin/plans',
          body: {
            code: str(values, 'code'),
            audience: str(values, 'audience'),
            name: str(values, 'name'),
            price: optionalMoney(values, 'price') ?? null,
            askLimit: optionalMoney(values, 'askLimit') ?? null,
            individualPricing:
              values.individualPricing === true || values.individualPricing === 'true',
            billingPeriod: str(values, 'billingPeriod'),
            features: jsonValue(values, 'features'),
            validFrom: optionalStr(values, 'validFrom'),
          },
        }),
    },
    {
      id: 'plan-close',
      title: 'Закрыть тариф',
      method: 'POST',
      path: '/v1/admin/plans/:id/close',
      summary: 'Прекращает действие версии. Основание попадает в журнал вместе с автором.',
      needsAuth: true,
      fields: [
        idField('planId', 'Тариф'),
        {
          name: 'reason',
          label: 'Основание',
          kind: 'textarea',
          required: true,
          help: '3–500 символов.',
        },
        {
          name: 'validTo',
          label: 'Момент закрытия',
          kind: 'text',
          placeholder: 'по умолчанию — сейчас',
        },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/admin/plans/${str(values, 'planId')}/close`,
          body: { reason: str(values, 'reason'), validTo: optionalStr(values, 'validTo') },
        }),
    },
    {
      id: 'subscriptions-list',
      title: 'Подписки пользователей',
      method: 'GET',
      path: '/v1/admin/subscriptions',
      summary: 'Все подписки платформы.',
      needsAuth: true,
      remembers: { subscriptionId: 'items.0.id' },
      run: (_values, { api }) => api.http.request({ path: '/admin/subscriptions' }),
    },
    {
      id: 'subscription-activate',
      title: 'Активировать подписку',
      method: 'POST',
      path: '/v1/admin/subscriptions/:id/activate',
      summary:
        'Активация администратором. Самоактивация со стороны пользователя запрещена триггером.',
      needsAuth: true,
      fields: [
        idField('subscriptionId', 'Подписка'),
        { name: 'reason', label: 'Основание', kind: 'textarea', required: true },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/admin/subscriptions/${str(values, 'subscriptionId')}/activate`,
          body: { reason: str(values, 'reason') },
        }),
    },
    {
      id: 'kyc-queue',
      title: 'Очередь проверок',
      method: 'GET',
      path: '/v1/kyc/queue',
      summary: 'Заявки на проверку личности. Постраничная: пустой курсор — первая страница.',
      needsAuth: true,
      fields: [{ name: 'cursor', label: 'Курсор', kind: 'text' }],
      remembers: { verificationId: 'items.0.id' },
      run: (values, { api }) => {
        const cursor = optionalStr(values, 'cursor');
        return api.http.request({
          path: cursor ? `/kyc/queue?cursor=${encodeURIComponent(cursor)}` : '/kyc/queue',
        });
      },
    },
    {
      id: 'kyc-decide',
      title: 'Решение по проверке личности',
      method: 'POST',
      path: '/v1/kyc/verifications/:id/decision',
      summary: 'Одобрение или отказ комплаенса.',
      needsAuth: true,
      fields: [
        idField('verificationId', 'Заявка'),
        {
          name: 'decision',
          label: 'Решение',
          kind: 'select',
          required: true,
          defaultValue: 'approved',
          options: [
            { value: 'approved', label: 'approved — одобрить' },
            { value: 'rejected', label: 'rejected — отказать' },
          ],
        },
        { name: 'reason', label: 'Основание', kind: 'textarea' },
      ],
      run: (values, { api }) => {
        const reason = optionalStr(values, 'reason');
        return api.http.request({
          method: 'POST',
          path: `/kyc/verifications/${str(values, 'verificationId')}/decision`,
          body: reason
            ? { decision: str(values, 'decision'), reason }
            : { decision: str(values, 'decision') },
        });
      },
    },
    {
      id: 'kyb-decide',
      title: 'Решение по проверке юрлица',
      method: 'POST',
      path: '/v1/kyc/kyb/:id/decision',
      summary: 'Допуск юрлица как эмитента.',
      needsAuth: true,
      fields: [
        idField('entityId', 'Юрлицо'),
        {
          name: 'decision',
          label: 'Решение',
          kind: 'select',
          required: true,
          defaultValue: 'approved',
          options: [
            { value: 'approved', label: 'approved' },
            { value: 'rejected', label: 'rejected' },
          ],
        },
        { name: 'reason', label: 'Основание', kind: 'textarea' },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/kyc/kyb/${str(values, 'entityId')}/decision`,
          body: { decision: str(values, 'decision'), reason: optionalStr(values, 'reason') },
        }),
    },
    {
      id: 'roles-list',
      title: 'Роли пользователя',
      method: 'GET',
      path: '/v1/admin/users/:id/roles',
      summary: 'Выданные роли.',
      needsAuth: true,
      fields: [idField('userId', 'Пользователь')],
      run: (values, { api }) =>
        api.http.request({
          path: `/admin/users/${encodeURIComponent(str(values, 'userId'))}/roles`,
        }),
    },
    {
      id: 'role-grant',
      title: 'Выдать роль',
      method: 'POST',
      path: '/v1/admin/users/:id/roles',
      summary:
        'Выдать роль СЕБЕ сервер не позволяет. Попробуй свой идентификатор — отказ здесь и есть проверка.',
      needsAuth: true,
      fields: [
        idField('userId', 'Пользователь'),
        {
          name: 'role',
          label: 'Роль',
          kind: 'text',
          required: true,
          defaultValue: 'expert',
          help: 'Например: expert, organizer, admin, compliance.',
        },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/admin/users/${encodeURIComponent(str(values, 'userId'))}/roles`,
          body: { role: str(values, 'role') },
        }),
    },
    {
      id: 'role-revoke',
      title: 'Отозвать роль',
      method: 'DELETE',
      path: '/v1/admin/users/:id/roles/:role',
      summary:
        'После отзыва действия этой роли обязаны отклоняться немедленно, а не по истечении сессии.',
      needsAuth: true,
      fields: [
        idField('userId', 'Пользователь'),
        { name: 'role', label: 'Роль', kind: 'text', required: true },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'DELETE',
          path: `/admin/users/${encodeURIComponent(str(values, 'userId'))}/roles/${str(values, 'role')}`,
        }),
    },
    {
      id: 'flags-list',
      title: 'Фичефлаги',
      method: 'GET',
      path: '/v1/admin/feature-flags',
      summary: 'Переключатели функциональности.',
      needsAuth: true,
      run: (_values, { api }) => api.http.request({ path: '/admin/feature-flags' }),
    },
    {
      id: 'flag-set',
      title: 'Переключить фичефлаг',
      method: 'PATCH',
      path: '/v1/admin/feature-flags/:key',
      summary: 'Изменение флага фиксируется в журнале.',
      needsAuth: true,
      fields: [
        { name: 'key', label: 'Ключ флага', kind: 'text', required: true },
        { name: 'enabled', label: 'Включён', kind: 'checkbox', defaultValue: true },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'PATCH',
          path: `/admin/feature-flags/${encodeURIComponent(str(values, 'key'))}`,
          body: { enabled: values.enabled === true || values.enabled === 'true' },
        }),
    },
    {
      id: 'templates-list',
      title: 'Шаблоны уведомлений',
      method: 'GET',
      path: '/v1/admin/notification-templates',
      summary: 'Тексты уведомлений по каналам и локалям.',
      needsAuth: true,
      remembers: { templateId: 'items.0.id' },
      run: (_values, { api }) => api.http.request({ path: '/admin/notification-templates' }),
    },
    {
      id: 'template-save',
      title: 'Сохранить шаблон',
      method: 'POST',
      path: '/v1/admin/notification-templates',
      summary: 'Создание или обновление шаблона.',
      needsAuth: true,
      fields: [
        {
          name: 'code',
          label: 'Код',
          kind: 'text',
          required: true,
          placeholder: 'project.submitted',
          help: 'Латиница, точки, подчёркивания.',
        },
        {
          name: 'channel',
          label: 'Канал',
          kind: 'select',
          required: true,
          defaultValue: 'email',
          options: [
            { value: 'push', label: 'push' },
            { value: 'telegram', label: 'telegram' },
            { value: 'email', label: 'email' },
            { value: 'sms', label: 'sms' },
            { value: 'inapp', label: 'inapp' },
          ],
        },
        {
          name: 'locale',
          label: 'Локаль',
          kind: 'select',
          options: LOCALE_OPTIONS,
          defaultValue: 'ru-RU',
        },
        { name: 'titleTemplate', label: 'Заголовок', kind: 'text' },
        {
          name: 'bodyTemplate',
          label: 'Текст',
          kind: 'textarea',
          required: true,
          help: '1–4000 символов.',
        },
        {
          name: 'fallbackChain',
          label: 'Запасные каналы',
          kind: 'text',
          placeholder: 'email,sms',
          help: 'Через запятую, максимум 4.',
        },
        { name: 'isCritical', label: 'Критическое', kind: 'checkbox', defaultValue: false },
      ],
      remembers: { templateId: 'id' },
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: '/admin/notification-templates',
          body: {
            code: str(values, 'code'),
            channel: str(values, 'channel'),
            locale: str(values, 'locale'),
            titleTemplate: optionalStr(values, 'titleTemplate') ?? null,
            bodyTemplate: str(values, 'bodyTemplate'),
            fallbackChain: list(values, 'fallbackChain'),
            isCritical: values.isCritical === true || values.isCritical === 'true',
          },
        }),
    },
    {
      id: 'template-deactivate',
      title: 'Отключить шаблон',
      method: 'DELETE',
      path: '/v1/admin/notification-templates/:id',
      summary: 'Шаблон перестаёт применяться.',
      needsAuth: true,
      fields: [idField('templateId', 'Шаблон')],
      run: (values, { api }) =>
        api.http.request({
          method: 'DELETE',
          path: `/admin/notification-templates/${str(values, 'templateId')}`,
        }),
    },
    {
      id: 'content-publish',
      title: 'Опубликовать блок витрины',
      method: 'POST',
      path: '/v1/admin/content/landing',
      summary:
        'Предыдущая версия блока закрывается тем же действием: двух действующих версий быть не может.',
      needsAuth: true,
      fields: [
        {
          name: 'key',
          label: 'Блок',
          kind: 'select',
          required: true,
          defaultValue: 'hero_title',
          options: [
            { value: 'hero_title', label: 'hero_title' },
            { value: 'hero_subtitle', label: 'hero_subtitle' },
            { value: 'hero_cta', label: 'hero_cta' },
            { value: 'about', label: 'about' },
            { value: 'for_founders', label: 'for_founders' },
            { value: 'for_investors', label: 'for_investors' },
            { value: 'disclaimer', label: 'disclaimer' },
            { value: 'banner_primary', label: 'banner_primary' },
            { value: 'banner_secondary', label: 'banner_secondary' },
          ],
        },
        {
          name: 'locale',
          label: 'Локаль',
          kind: 'select',
          options: LOCALE_OPTIONS,
          defaultValue: 'ru-RU',
        },
        { name: 'title', label: 'Заголовок', kind: 'text' },
        { name: 'body', label: 'Текст', kind: 'textarea', required: true },
        {
          name: 'linkUrl',
          label: 'Ссылка',
          kind: 'text',
          placeholder: 'https://example.com',
          help: 'Только https: текст попадает на публичную страницу как есть.',
        },
        { name: 'reason', label: 'Основание правки', kind: 'textarea', required: true },
      ],
      remembers: { landingBlockId: 'id' },
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: '/admin/content/landing',
          body: {
            key: str(values, 'key'),
            locale: str(values, 'locale'),
            title: optionalStr(values, 'title') ?? null,
            body: str(values, 'body'),
            linkUrl: optionalStr(values, 'linkUrl') ?? null,
            reason: str(values, 'reason'),
          },
        }),
    },
    {
      id: 'content-withdraw',
      title: 'Снять блок с витрины',
      method: 'POST',
      path: '/v1/admin/content/landing/:id/withdraw',
      summary: 'Снятие без замены. Витрина обязана остаться читаемой.',
      needsAuth: true,
      fields: [
        idField('landingBlockId', 'Блок'),
        { name: 'reason', label: 'Основание', kind: 'textarea', required: true },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/admin/content/landing/${str(values, 'landingBlockId')}/withdraw`,
          body: { reason: str(values, 'reason') },
        }),
    },
    {
      id: 'content-history',
      title: 'История блоков витрины',
      method: 'GET',
      path: '/v1/admin/content/landing/history',
      summary: 'Кто и когда менял тексты публичной страницы.',
      needsAuth: true,
      run: (_values, { api }) => api.http.request({ path: '/admin/content/landing/history' }),
    },
  ],
};

export const integrationGroup: OperationGroup = {
  id: 'integration',
  title: 'Интеграционный API и вебхуки',
  note: 'Контур для внешних систем. В продуктовые кабинеты не помещается вовсе.',
  operations: [
    {
      id: 'service-accounts-list',
      title: 'Служебные учётные записи',
      method: 'GET',
      path: '/v1/admin/service-accounts',
      summary: 'Клиенты внешних систем и их скоупы.',
      needsAuth: true,
      remembers: { serviceAccountId: 'items.0.id' },
      run: (_values, { api }) => api.http.request({ path: '/admin/service-accounts' }),
    },
    {
      id: 'service-account-create',
      title: 'Создать служебную учётную запись',
      method: 'POST',
      path: '/v1/admin/service-accounts',
      summary: 'Доступ выдаётся под mTLS: отпечаток сертификата обязателен.',
      needsAuth: true,
      fields: [
        { name: 'name', label: 'Название', kind: 'text', required: true },
        {
          name: 'clientId',
          label: 'Идентификатор клиента',
          kind: 'text',
          required: true,
          placeholder: 'partner-crm',
          help: 'Строчные латинские буквы, цифры, точка, дефис, подчёркивание.',
        },
        {
          name: 'scopes',
          label: 'Скоупы',
          kind: 'text',
          required: true,
          defaultValue: 'graduates.read',
          help: 'Через запятую, 1–20 значений.',
        },
        {
          name: 'mtlsCertFingerprint',
          label: 'Отпечаток сертификата',
          kind: 'text',
          required: true,
          help: 'sha256 в hex, 64 символа.',
        },
      ],
      remembers: { serviceAccountId: 'id' },
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: '/admin/service-accounts',
          body: {
            name: str(values, 'name'),
            clientId: str(values, 'clientId'),
            scopes: list(values, 'scopes'),
            mtlsCertFingerprint: str(values, 'mtlsCertFingerprint'),
          },
        }),
    },
    {
      id: 'service-account-rotate',
      title: 'Ротировать секрет учётной записи',
      method: 'POST',
      path: '/v1/admin/service-accounts/:id/rotation',
      summary: 'Прежний секрет обязан перестать действовать сразу после ротации.',
      needsAuth: true,
      fields: [idField('serviceAccountId', 'Учётная запись')],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/admin/service-accounts/${str(values, 'serviceAccountId')}/rotation`,
          body: {},
        }),
    },
    {
      id: 'service-account-status',
      title: 'Включить или отключить учётную запись',
      method: 'POST',
      path: '/v1/admin/service-accounts/:id/status',
      summary: 'Отключённая учётная запись не должна получать токен.',
      needsAuth: true,
      fields: [
        idField('serviceAccountId', 'Учётная запись'),
        { name: 'status', label: 'Статус', kind: 'text', required: true, defaultValue: 'disabled' },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/admin/service-accounts/${str(values, 'serviceAccountId')}/status`,
          body: { status: str(values, 'status') },
        }),
    },
    {
      id: 'integration-token',
      title: 'Получить служебный токен',
      method: 'POST',
      path: '/v1/integration/token',
      summary: 'Токен для внешней системы. Скоуп определяет, что ей будет видно.',
      fields: [
        { name: 'clientId', label: 'Идентификатор клиента', kind: 'text', required: true },
        { name: 'clientSecret', label: 'Секрет', kind: 'password', required: true },
        { name: 'scope', label: 'Скоуп', kind: 'text', defaultValue: 'graduates.read' },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: '/integration/token',
          body: {
            clientId: str(values, 'clientId'),
            clientSecret: str(values, 'clientSecret'),
            scope: optionalStr(values, 'scope'),
          },
        }),
    },
    {
      id: 'integration-graduates',
      title: 'Выпускники',
      method: 'GET',
      path: '/v1/integration/graduates',
      summary:
        'То, что видит внешняя система. Персональных данных здесь быть не должно — это главное, что проверяется.',
      needsAuth: true,
      run: (_values, { api }) => api.http.request({ path: '/integration/graduates' }),
    },
    {
      id: 'integration-passport',
      title: 'Паспорт проекта для внешней системы',
      method: 'GET',
      path: '/v1/integration/projects/:id/passport',
      summary: 'Сверь с паспортом основателя: наружу уходит меньше.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      run: (values, { api }) =>
        api.http.request({ path: `/integration/projects/${str(values, 'projectId')}/passport` }),
    },
    {
      id: 'integration-public-profile',
      title: 'Публичный профиль проекта',
      method: 'GET',
      path: '/v1/integration/projects/:id/public-profile',
      summary: 'Публичная выжимка для партнёров.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      run: (values, { api }) =>
        api.http.request({
          path: `/integration/projects/${str(values, 'projectId')}/public-profile`,
        }),
    },
    {
      id: 'integration-irs',
      title: 'История индекса готовности',
      method: 'GET',
      path: '/v1/integration/projects/:id/irs-history',
      summary: 'Динамика оценки проекта.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      run: (values, { api }) =>
        api.http.request({ path: `/integration/projects/${str(values, 'projectId')}/irs-history` }),
    },
    {
      id: 'integration-listing',
      title: 'Связать с внешней системой',
      method: 'POST',
      path: '/v1/integration/listings',
      summary: 'Соответствие локального проекта записи во внешней системе.',
      needsAuth: true,
      fields: [
        idField('projectId', 'Проект'),
        {
          name: 'remoteSystem',
          label: 'Внешняя система',
          kind: 'text',
          required: true,
          placeholder: 'partner-crm',
        },
        {
          name: 'remoteType',
          label: 'Тип записи',
          kind: 'text',
          required: true,
          placeholder: 'deal',
        },
        {
          name: 'remoteId',
          label: 'Идентификатор во внешней системе',
          kind: 'text',
          required: true,
        },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: '/integration/listings',
          body: {
            projectId: str(values, 'projectId'),
            remoteSystem: str(values, 'remoteSystem'),
            remoteType: str(values, 'remoteType'),
            remoteId: str(values, 'remoteId'),
          },
        }),
    },
    {
      id: 'integration-deals',
      title: 'Сделки для внешней системы',
      method: 'GET',
      path: '/v1/integration/deals',
      summary: 'Обезличенный поток сделок.',
      needsAuth: true,
      run: (_values, { api }) => api.http.request({ path: '/integration/deals' }),
    },
    {
      id: 'webhooks-list',
      title: 'Подписки на события',
      method: 'GET',
      path: '/v1/integration/webhooks',
      summary: 'Зарегистрированные приёмники вебхуков.',
      needsAuth: true,
      remembers: { webhookId: 'items.0.id' },
      run: (_values, { api }) => api.http.request({ path: '/integration/webhooks' }),
    },
    {
      id: 'webhook-create',
      title: 'Подписаться на события',
      method: 'POST',
      path: '/v1/integration/webhooks',
      summary:
        'Только https. Подписка на событие вне выданных скоупов отклоняется — попробуй чужой глагол и увидишь 403.',
      needsAuth: true,
      fields: [
        {
          name: 'url',
          label: 'Адрес приёмника',
          kind: 'text',
          required: true,
          placeholder: 'https://example.com/hook',
          help: 'Внутренние адреса отвергаются: резолв имени проверяется под ограничением по времени.',
        },
        {
          name: 'subscribedVerbs',
          label: 'События',
          kind: 'text',
          required: true,
          defaultValue: 'project.graduated',
          help: 'Через запятую, 1–50 значений.',
        },
      ],
      remembers: { webhookId: 'id' },
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: '/integration/webhooks',
          body: { url: str(values, 'url'), subscribedVerbs: list(values, 'subscribedVerbs') },
        }),
    },
    {
      id: 'webhook-delete',
      title: 'Отписаться от событий',
      method: 'DELETE',
      path: '/v1/integration/webhooks/:id',
      summary: 'После отписки события на этот адрес уходить не должны.',
      needsAuth: true,
      fields: [idField('webhookId', 'Подписка')],
      run: (values, { api }) =>
        api.http.request({
          method: 'DELETE',
          path: `/integration/webhooks/${str(values, 'webhookId')}`,
        }),
    },
  ],
};
