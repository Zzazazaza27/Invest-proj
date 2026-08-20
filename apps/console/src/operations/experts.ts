import type { OperationGroup } from '../types';
import { idField, jsonValue, num, optionalNum, optionalStr, str } from './shared';

export const expertsGroup: OperationGroup = {
  id: 'experts',
  title: 'Экспертиза',
  note: 'Роль expert. Решение по проекту принимает организатор, а не эксперт и не модель.',
  operations: [
    {
      id: 'expert-assignments',
      title: 'Мои назначения',
      method: 'GET',
      path: '/v1/experts/assignments',
      summary: 'Проекты, назначенные на рецензию текущему эксперту.',
      needsAuth: true,
      remembers: { assignmentId: '0.id' },
      run: (_values, { api }) => api.experts.assignments(),
    },
    {
      id: 'expert-assign',
      title: 'Назначить эксперта на проект',
      method: 'POST',
      path: '/v1/experts/assignments',
      summary:
        'Действие организатора. Эксперт себя назначить не может — это и проверяется отказом.',
      needsAuth: true,
      fields: [
        idField('projectId', 'Проект'),
        idField(
          'expertUserId',
          'Эксперт (идентификатор пользователя)',
          'Идентификатор учётной записи эксперта.',
        ),
        idField('seasonId', 'Сезон'),
      ],
      remembers: { assignmentId: 'id' },
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: '/experts/assignments',
          body: {
            projectId: str(values, 'projectId'),
            expertId: str(values, 'expertUserId'),
            seasonId: str(values, 'seasonId'),
          },
        }),
    },
    {
      id: 'expert-decision',
      title: 'Принять или отклонить назначение',
      method: 'POST',
      path: '/v1/experts/assignments/:id/decision',
      summary:
        'Отказ — законный исход: рецензент, который не может оценить проект честно, обязан иметь способ это сказать.',
      needsAuth: true,
      fields: [
        idField('assignmentId', 'Назначение'),
        {
          name: 'decision',
          label: 'Решение',
          kind: 'select',
          required: true,
          defaultValue: 'accepted',
          options: [
            { value: 'accepted', label: 'accepted — принять' },
            { value: 'declined', label: 'declined — отказаться' },
          ],
        },
      ],
      run: (values, { api }) =>
        api.experts.decideAssignment(
          str(values, 'assignmentId'),
          str(values, 'decision') as 'accepted' | 'declined',
        ),
    },
    {
      id: 'expert-review',
      title: 'Сдать рецензию',
      method: 'POST',
      path: '/v1/experts/reviews',
      summary: 'Оценки по шести осям, каждая 0–10. Рецензия ссылается на версию-снимок заявки.',
      needsAuth: true,
      fields: [
        idField('assignmentId', 'Назначение'),
        { name: 'team', label: 'Команда (0–10)', kind: 'number', required: true, defaultValue: 7 },
        {
          name: 'product',
          label: 'Продукт (0–10)',
          kind: 'number',
          required: true,
          defaultValue: 7,
        },
        {
          name: 'strategy',
          label: 'Стратегия (0–10)',
          kind: 'number',
          required: true,
          defaultValue: 6,
        },
        { name: 'legal', label: 'Право (0–10)', kind: 'number', required: true, defaultValue: 6 },
        {
          name: 'finmodel',
          label: 'Финмодель (0–10)',
          kind: 'number',
          required: true,
          defaultValue: 6,
        },
        {
          name: 'scalability',
          label: 'Масштабируемость (0–10)',
          kind: 'number',
          required: true,
          defaultValue: 8,
        },
        { name: 'comment', label: 'Комментарий', kind: 'textarea', help: 'До 8000 символов.' },
        {
          name: 'recommendation',
          label: 'Рекомендация',
          kind: 'select',
          required: true,
          defaultValue: 'pass',
          options: [
            { value: 'pass', label: 'pass — дальше' },
            { value: 'fail', label: 'fail — отклонить' },
            { value: 'needs_review', label: 'needs_review — нужен разбор' },
          ],
        },
      ],
      run: (values, { api }) =>
        api.experts.submitReview({
          assignmentId: str(values, 'assignmentId'),
          rubricScores: {
            team: num(values, 'team'),
            product: num(values, 'product'),
            strategy: num(values, 'strategy'),
            legal: num(values, 'legal'),
            finmodel: num(values, 'finmodel'),
            scalability: num(values, 'scalability'),
          },
          comment: optionalStr(values, 'comment'),
          recommendation: str(values, 'recommendation') as never,
        }),
    },
    {
      id: 'expert-reviews-list',
      title: 'Рецензии по проекту',
      method: 'GET',
      path: '/v1/experts/projects/:id/reviews',
      summary:
        'Сданные рецензии. Основателю они видны не в сыром виде — сверь, что именно раскрывается.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      run: (values, { api }) =>
        api.http.request({ path: `/experts/projects/${str(values, 'projectId')}/reviews` }),
    },
    {
      id: 'expert-conflict',
      title: 'Заявить конфликт интересов',
      method: 'POST',
      path: '/v1/experts/conflicts',
      summary: 'Эксперт обязан заявить связь с проектом. Дальше решение принимает организатор.',
      needsAuth: true,
      fields: [
        idField('projectId', 'Проект'),
        { name: 'description', label: 'Описание конфликта', kind: 'textarea', required: true },
      ],
      remembers: { conflictId: 'id' },
      run: (values, { api }) =>
        api.experts.declareConflict({
          projectId: str(values, 'projectId'),
          description: str(values, 'description'),
        }),
    },
    {
      id: 'expert-conflicts-list',
      title: 'Конфликты по проекту',
      method: 'GET',
      path: '/v1/experts/projects/:id/conflicts',
      summary: 'Заявленные конфликты и их разрешение.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      remembers: { conflictId: 'items.0.id' },
      run: (values, { api }) =>
        api.http.request({ path: `/experts/projects/${str(values, 'projectId')}/conflicts` }),
    },
    {
      id: 'expert-conflict-resolve',
      title: 'Разрешить конфликт',
      method: 'POST',
      path: '/v1/experts/conflicts/:id/resolution',
      summary: 'Действие организатора: отвести эксперта или признать конфликт несущественным.',
      needsAuth: true,
      fields: [
        idField('conflictId', 'Конфликт'),
        {
          name: 'resolution',
          label: 'Решение',
          kind: 'text',
          required: true,
          defaultValue: 'recused',
          help: 'Например: recused (отвод), dismissed (несущественно).',
        },
        { name: 'reason', label: 'Обоснование', kind: 'textarea' },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/experts/conflicts/${str(values, 'conflictId')}/resolution`,
          body: {
            resolution: str(values, 'resolution'),
            reason: optionalStr(values, 'reason'),
          },
        }),
    },
    {
      id: 'expert-consensus',
      title: 'Зафиксировать консенсус',
      method: 'POST',
      path: '/v1/experts/consensus',
      summary:
        'Итоговое решение по проекту — принимает ЧЕЛОВЕК, а не модель. Ключевой контроль всей экспертизы.',
      needsAuth: true,
      fields: [
        idField('projectId', 'Проект'),
        idField('seasonId', 'Сезон'),
        {
          name: 'decision',
          label: 'Решение',
          kind: 'text',
          required: true,
          defaultValue: 'pass',
          help: 'pass / fail / needs_review.',
        },
        { name: 'rationale', label: 'Обоснование', kind: 'textarea', required: true },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: '/experts/consensus',
          body: {
            projectId: str(values, 'projectId'),
            seasonId: str(values, 'seasonId'),
            decision: str(values, 'decision'),
            rationale: str(values, 'rationale'),
          },
        }),
    },
  ],
};

export const seasonsGroup: OperationGroup = {
  id: 'seasons',
  title: 'Сезон и воронка',
  note: 'Роль организатора. Квоты и расписание этапов — серверные ограничения, не подсказки интерфейса.',
  operations: [
    {
      id: 'season-current',
      title: 'Текущий сезон',
      method: 'GET',
      path: '/v1/seasons/current',
      summary: 'Активный сезон или `null`.',
      remembers: { seasonId: 'id' },
      run: (_values, { api }) => api.currentSeason(),
    },
    {
      id: 'season-status',
      title: 'Сменить статус сезона',
      method: 'POST',
      path: '/v1/seasons/:id/status',
      summary: 'Открытие и закрытие сезона. Порядок переходов проверяет сервер.',
      needsAuth: true,
      fields: [
        idField('seasonId', 'Сезон'),
        {
          name: 'status',
          label: 'Новый статус',
          kind: 'text',
          required: true,
          help: 'Например: open, closed, archived.',
        },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/seasons/${str(values, 'seasonId')}/status`,
          body: { status: str(values, 'status') },
        }),
    },
    {
      id: 'season-funnel-get',
      title: 'Настройки воронки',
      method: 'GET',
      path: '/v1/seasons/:id/funnel',
      summary: 'Квоты этапов и расписание.',
      needsAuth: true,
      fields: [idField('seasonId', 'Сезон')],
      run: (values, { api }) => api.seasons.funnel(str(values, 'seasonId')),
    },
    {
      id: 'season-funnel-set',
      title: 'Задать воронку',
      method: 'POST',
      path: '/v1/seasons/:id/funnel',
      summary:
        'Квота — предел, который сервер обязан соблюдать: перевод сверх неё отклоняется, а не «предупреждается».',
      needsAuth: true,
      fields: [
        idField('seasonId', 'Сезон'),
        {
          name: 'quotas',
          label: 'Квоты (JSON)',
          kind: 'json',
          defaultValue:
            '{"ai_review": 100, "expert_review": 50, "bootcamp": 20, "finalist": 10, "graduated": 5}',
        },
        {
          name: 'schedule',
          label: 'Расписание этапов (JSON)',
          kind: 'json',
          defaultValue: '{}',
          help: 'Момент открытия этапа. Раньше него проект перевести нельзя.',
        },
      ],
      run: (values, { api }) =>
        api.seasons.setFunnel(str(values, 'seasonId'), {
          quotas: jsonValue(values, 'quotas') as never,
          schedule: jsonValue(values, 'schedule') as never,
        }),
    },
    {
      id: 'season-stage',
      title: 'Перевести проект по этапу',
      method: 'POST',
      path: '/v1/seasons/:id/projects/:projectId/stage',
      summary: 'Движение по воронке. Золотой билет позволяет обойти квоту — и расходуется.',
      needsAuth: true,
      fields: [
        idField('seasonId', 'Сезон'),
        idField('projectId', 'Проект'),
        {
          name: 'status',
          label: 'Этап',
          kind: 'select',
          required: true,
          defaultValue: 'expert_review',
          options: [
            { value: 'ai_review', label: 'ai_review — машинная проверка' },
            { value: 'expert_review', label: 'expert_review — экспертиза' },
            { value: 'bootcamp', label: 'bootcamp — буткемп' },
            { value: 'finalist', label: 'finalist — финалист' },
            { value: 'graduated', label: 'graduated — выпускник' },
            { value: 'rejected', label: 'rejected — отклонён' },
          ],
        },
        {
          name: 'reason',
          label: 'Обоснование',
          kind: 'textarea',
          required: true,
          help: '3–500 символов.',
        },
        {
          name: 'useGoldenTicket',
          label: 'Использовать золотой билет',
          kind: 'checkbox',
          defaultValue: false,
        },
      ],
      run: (values, { api }) =>
        api.seasons.advanceStage(str(values, 'seasonId'), str(values, 'projectId'), {
          status: str(values, 'status') as never,
          reason: str(values, 'reason'),
          useGoldenTicket: values.useGoldenTicket === true || values.useGoldenTicket === 'true',
        }),
    },
    {
      id: 'season-rating',
      title: 'Рейтинг сезона',
      method: 'GET',
      path: '/v1/seasons/:id/rating',
      summary: 'Считается сервером по рецензиям, а не редактируется руками.',
      needsAuth: true,
      fields: [idField('seasonId', 'Сезон')],
      run: (values, { api }) => api.rating(str(values, 'seasonId')),
    },
    {
      id: 'season-rating-refresh',
      title: 'Пересчитать рейтинг',
      method: 'POST',
      path: '/v1/seasons/:id/rating/refresh',
      summary: 'Принудительный пересчёт после появления новых рецензий.',
      needsAuth: true,
      fields: [idField('seasonId', 'Сезон')],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/seasons/${str(values, 'seasonId')}/rating/refresh`,
          body: {},
        }),
    },
    {
      id: 'season-tickets-list',
      title: 'Золотые билеты',
      method: 'GET',
      path: '/v1/seasons/:id/golden-tickets',
      summary: 'Выданные билеты и их расход.',
      needsAuth: true,
      fields: [idField('seasonId', 'Сезон')],
      run: (values, { api }) =>
        api.http.request({ path: `/seasons/${str(values, 'seasonId')}/golden-tickets` }),
    },
    {
      id: 'season-ticket-grant',
      title: 'Выдать золотой билет',
      method: 'POST',
      path: '/v1/seasons/:id/golden-tickets',
      summary: 'Право обойти квоту этапа. Выдаёт организатор, расходуется однократно.',
      needsAuth: true,
      fields: [
        idField('seasonId', 'Сезон'),
        idField('projectId', 'Проект'),
        { name: 'reason', label: 'Обоснование', kind: 'textarea', required: true },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/seasons/${str(values, 'seasonId')}/golden-tickets`,
          body: { projectId: str(values, 'projectId'), reason: str(values, 'reason') },
        }),
    },
  ],
};

export const notificationsGroup: OperationGroup = {
  id: 'notifications',
  title: 'Уведомления',
  note: 'В продуктовых кабинетах этого экрана нет вовсе.',
  operations: [
    {
      id: 'notifications-list',
      title: 'Мои уведомления',
      method: 'GET',
      path: '/v1/notifications',
      summary: 'Лента событий пользователя.',
      needsAuth: true,
      fields: [{ name: 'limit', label: 'Сколько вернуть', kind: 'number', defaultValue: 20 }],
      run: (values, { api }) => api.notifications.list({ limit: optionalNum(values, 'limit') }),
    },
    {
      id: 'notifications-preferences',
      title: 'Настройки доставки',
      method: 'GET',
      path: '/v1/notifications/preferences',
      summary: 'Каналы, темы и тихие часы.',
      needsAuth: true,
      run: (_values, { api }) => api.notifications.preferences(),
    },
    {
      id: 'notifications-preferences-set',
      title: 'Изменить настройку доставки',
      method: 'PUT',
      path: '/v1/notifications/preferences',
      summary: 'Одна пара «канал + тема» за раз — этого хватает, чтобы проверить сохранение.',
      needsAuth: true,
      fields: [
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
          name: 'topic',
          label: 'Тема',
          kind: 'select',
          required: true,
          defaultValue: 'all',
          options: [
            { value: 'all', label: 'all' },
            { value: 'projects', label: 'projects' },
            { value: 'deals', label: 'deals' },
            { value: 'billing', label: 'billing' },
            { value: 'experts', label: 'experts' },
            { value: 'seasons', label: 'seasons' },
          ],
        },
        { name: 'enabled', label: 'Включено', kind: 'checkbox', defaultValue: true },
        {
          name: 'quietHoursTz',
          label: 'Часовой пояс тихих часов',
          kind: 'text',
          placeholder: 'Europe/Moscow',
        },
        { name: 'quietFrom', label: 'Тихие часы с', kind: 'text', placeholder: '22:00' },
        { name: 'quietTo', label: 'Тихие часы до', kind: 'text', placeholder: '08:00' },
      ],
      run: (values, { api }) =>
        api.notifications.updatePreferences([
          {
            channel: str(values, 'channel') as never,
            topic: str(values, 'topic') as never,
            enabled: values.enabled === true || values.enabled === 'true',
            quietHoursTz: optionalStr(values, 'quietHoursTz') ?? null,
            quietFrom: optionalStr(values, 'quietFrom') ?? null,
            quietTo: optionalStr(values, 'quietTo') ?? null,
          },
        ]),
    },
    {
      id: 'devices-list',
      title: 'Мои устройства',
      method: 'GET',
      path: '/v1/notifications/devices',
      summary: 'Устройства, зарегистрированные для push.',
      needsAuth: true,
      remembers: { deviceId: '0.id' },
      run: (_values, { api }) => api.notifications.devices(),
    },
    {
      id: 'device-register',
      title: 'Зарегистрировать устройство',
      method: 'POST',
      path: '/v1/notifications/devices',
      summary: 'Привязка push-токена к пользователю.',
      needsAuth: true,
      fields: [
        {
          name: 'platform',
          label: 'Платформа',
          kind: 'select',
          required: true,
          defaultValue: 'web_pwa',
          options: [
            { value: 'ios', label: 'ios' },
            { value: 'android', label: 'android' },
            { value: 'web_pwa', label: 'web_pwa' },
          ],
        },
        {
          name: 'pushProvider',
          label: 'Провайдер',
          kind: 'select',
          required: true,
          defaultValue: 'web_push',
          options: [
            { value: 'fcm', label: 'fcm' },
            { value: 'apns', label: 'apns' },
            { value: 'web_push', label: 'web_push' },
          ],
        },
        {
          name: 'pushToken',
          label: 'Push-токен',
          kind: 'text',
          required: true,
          help: '10–4096 символов.',
          defaultValue: 'console-test-token-0000000000',
        },
        { name: 'deviceName', label: 'Название устройства', kind: 'text', defaultValue: 'Консоль' },
        { name: 'appVersion', label: 'Версия приложения', kind: 'text' },
      ],
      remembers: { deviceId: 'id' },
      run: (values, { api }) =>
        api.notifications.registerDevice({
          platform: str(values, 'platform') as never,
          pushProvider: str(values, 'pushProvider') as never,
          pushToken: str(values, 'pushToken'),
          deviceName: optionalStr(values, 'deviceName'),
          appVersion: optionalStr(values, 'appVersion'),
        }),
    },
    {
      id: 'device-revoke',
      title: 'Отозвать устройство',
      method: 'DELETE',
      path: '/v1/notifications/devices/:id',
      summary: 'После отзыва push на него уходить не должен.',
      needsAuth: true,
      fields: [idField('deviceId', 'Устройство')],
      run: (values, { api }) => api.notifications.revokeDevice(str(values, 'deviceId')),
    },
  ],
};
