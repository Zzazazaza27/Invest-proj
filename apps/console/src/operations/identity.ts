import type { OperationGroup } from '../types';
import { idField, optionalStr, str, LOCALE_OPTIONS } from './shared';

/**
 * Четыре документа, без акцепта которых аккаунт не активируется. Это серверный
 * инвариант (продублирован триггером в БД), а не галочка в интерфейсе — поэтому
 * они передаются вместе с заявкой на регистрацию, а не «потом».
 */
const REQUIRED_CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'] as const;

export const identityGroup: OperationGroup = {
  id: 'identity',
  title: 'Учётная запись и вход',
  note: 'Регистрации в продуктовых кабинетах нет — только здесь.',
  operations: [
    {
      id: 'consent-templates',
      title: 'Действующие версии документов',
      method: 'GET',
      path: '/v1/auth/consents/templates',
      summary:
        'Версии обязательных документов. Публичная: без неё зарегистрироваться нельзя — сервер отвергает акцепт с недействующей версией, а угадать её неоткуда.',
      fields: [
        {
          name: 'locale',
          label: 'Локаль',
          kind: 'select',
          options: LOCALE_OPTIONS,
          defaultValue: 'ru-RU',
        },
      ],
      run: (values, { api }) =>
        api.http.request({
          path: `/auth/consents/templates?locale=${encodeURIComponent(str(values, 'locale'))}`,
        }),
    },
    {
      id: 'register',
      title: 'Регистрация',
      method: 'POST',
      path: '/v1/auth/register',
      summary:
        'Создаёт учётную запись сразу с акцептами четырёх обязательных документов: без них аккаунт не активируется.',
      fields: [
        {
          name: 'email',
          label: 'Email',
          kind: 'text',
          placeholder: 'user@example.com',
          help: 'Нужен email ИЛИ телефон — сервер отвергнет заявку без обоих.',
        },
        {
          name: 'phone',
          label: 'Телефон',
          kind: 'text',
          placeholder: '+79990000000',
          help: 'Формат E.164.',
        },
        {
          name: 'password',
          label: 'Пароль',
          kind: 'password',
          required: true,
          help: 'Минимум 12 символов.',
        },
        {
          name: 'displayName',
          label: 'Отображаемое имя',
          kind: 'text',
          required: true,
          help: '2–120 символов.',
        },
        {
          name: 'role',
          label: 'Роль',
          kind: 'select',
          required: true,
          defaultValue: 'founder',
          options: [
            { value: 'founder', label: 'founder — основатель' },
            { value: 'investor', label: 'investor — инвестор' },
          ],
          help: 'Самостоятельно выдаются только эти две роли: эксперта и администратора назначает платформа.',
        },
        {
          name: 'locale',
          label: 'Локаль',
          kind: 'select',
          options: LOCALE_OPTIONS,
          defaultValue: 'ru-RU',
        },
        {
          name: 'consentVersion',
          label: 'Версия документов',
          kind: 'text',
          defaultValue: 'v1',
          help: 'Действующую версию отдаёт операция «Действующие версии документов». Недействующая версия — отказ 400 с указанием документа.',
        },
      ],
      remembers: { userId: 'user.id' },
      run: async (values, { api, setCsrf, refreshSession }) => {
        const locale = str(values, 'locale') || 'ru-RU';
        // Запасное значение совпадает с defaultValue поля. Прежнее '1.0.0'
        // было тем самым несуществующим номером, из-за которого регистрация
        // отвечала 500 до Ф49: пустое поле возвращало ту же ошибку обратно.
        const version = str(values, 'consentVersion') || 'v1';
        const session = await api.auth.register({
          email: optionalStr(values, 'email'),
          phone: optionalStr(values, 'phone'),
          password: str(values, 'password'),
          displayName: str(values, 'displayName'),
          role: str(values, 'role') as 'founder' | 'investor',
          locale: locale as 'ru-RU' | 'en-US',
          consents: REQUIRED_CONSENTS.map((kind) => ({
            kind,
            version,
            locale: locale as 'ru-RU' | 'en-US',
          })),
        });
        // Регистрация открывает сессию: CSRF-токен из тела важнее cookie, она
        // может отстать (расхождение копий, аудит №2).
        const csrf = (session as { csrfToken?: string }).csrfToken;
        if (csrf) setCsrf(csrf);
        await refreshSession();
        return session;
      },
    },
    {
      id: 'login',
      title: 'Вход',
      method: 'POST',
      path: '/v1/auth/login',
      summary:
        'Открывает сессию. Токен уходит в httpOnly-cookie — коду страницы он недоступен, здесь виден только CSRF.',
      fields: [
        { name: 'email', label: 'Email', kind: 'text', placeholder: 'user@example.com' },
        { name: 'phone', label: 'Телефон', kind: 'text', placeholder: '+79990000000' },
        { name: 'password', label: 'Пароль', kind: 'password', required: true },
      ],
      run: async (values, { api, setCsrf, refreshSession }) => {
        const session = await api.auth.login({
          email: optionalStr(values, 'email'),
          phone: optionalStr(values, 'phone'),
          password: str(values, 'password'),
        });
        const csrf = (session as { csrfToken?: string }).csrfToken;
        if (csrf) setCsrf(csrf);
        await refreshSession();
        return session;
      },
    },
    {
      id: 'me',
      title: 'Кто я',
      method: 'GET',
      path: '/v1/auth/me',
      summary: 'Текущий пользователь, роли и признак необходимости переакцепта документов.',
      needsAuth: true,
      remembers: { userId: 'id' },
      run: (_values, { api }) => api.auth.me(),
    },
    {
      id: 'consents',
      title: 'Акцепт новых версий документов',
      method: 'POST',
      path: '/v1/auth/consents',
      summary: 'Нужен, когда «Кто я» вернул reacceptRequired: до акцепта часть действий закрыта.',
      needsAuth: true,
      fields: [
        {
          name: 'version',
          label: 'Версия',
          kind: 'text',
          required: true,
          defaultValue: 'v1',
          help: 'Действующую версию отдаёт операция «Действующие версии документов».',
        },
        {
          name: 'locale',
          label: 'Локаль',
          kind: 'select',
          options: LOCALE_OPTIONS,
          defaultValue: 'ru-RU',
        },
      ],
      run: (values, { api }) =>
        api.auth.acceptConsents(
          REQUIRED_CONSENTS.map((kind) => ({
            kind,
            version: str(values, 'version'),
            locale: str(values, 'locale'),
          })),
        ),
    },
    {
      id: 'logout',
      title: 'Выход',
      method: 'POST',
      path: '/v1/auth/logout',
      summary:
        'Закрывает сессию. После него «Кто я» обязан отвечать 401 — это и есть проверка отзыва.',
      needsAuth: true,
      run: async (_values, { api, setCsrf, refreshSession }) => {
        const result = await api.auth.logout();
        // null — это СБРОС токена, а не «перечитай cookie»: иначе клиент
        // остаётся с токеном уже закрытой сессии.
        setCsrf(null);
        await refreshSession();
        return result;
      },
    },
    {
      id: 'password-forgot',
      title: 'Забыли пароль: запросить ссылку',
      method: 'POST',
      path: '/v1/auth/password/forgot',
      summary:
        'Ответ ВСЕГДА 202 accepted — и для существующего адреса, и для чужого. Отличить одно от другого нельзя намеренно: иначе форма перечисляет пользователей. Куда ушло письмо, смотри по MAIL_TRANSPORT (file — в MAIL_OUTBOX_DIR).',
      fields: [
        {
          name: 'email',
          label: 'Почта',
          kind: 'text',
          required: true,
          placeholder: 'user@example.com',
        },
      ],
      run: (values, { api }) => api.auth.passwordForgot(str(values, 'email')),
    },
    {
      id: 'password-reset',
      title: 'Сменить пароль по ссылке',
      method: 'POST',
      path: '/v1/auth/password/reset',
      summary:
        'Токен берётся из письма. Срабатывает один раз, гасит все открытые сессии пользователя и НЕ открывает новую: смена пароля — не вход.',
      fields: [
        {
          name: 'token',
          label: 'Токен из письма',
          kind: 'text',
          required: true,
          help: '32 байта в base64url — то, что стоит после #reset= в ссылке.',
        },
        {
          name: 'password',
          label: 'Новый пароль',
          kind: 'password',
          required: true,
          help: 'Минимум 12 символов.',
        },
      ],
      run: (values, { api }) =>
        api.auth.passwordReset(str(values, 'token'), str(values, 'password')),
    },
    {
      id: 'email-verify-status',
      title: 'Состояние подтверждения почты',
      method: 'GET',
      path: '/v1/auth/email/verify/status',
      summary:
        'Подтверждён ли адрес, есть ли живая ссылка и подключён ли канал отправки. mailAvailable=false означает, что почтового сервера нет и маршруты отправки отвечают 503.',
      needsAuth: true,
      run: (_values, { api }) => api.auth.emailVerificationStatus(),
    },
    {
      id: 'email-verify-request',
      title: 'Запросить письмо подтверждения',
      method: 'POST',
      path: '/v1/auth/email/verify/request',
      summary:
        'Адрес берётся из профиля, а не из формы: подтверждать надо тот, что записан в аккаунте. Письмо уходит и само — при регистрации.',
      needsAuth: true,
      run: (_values, { api }) => api.auth.requestEmailVerification(),
    },
    {
      id: 'email-verify-confirm',
      title: 'Подтвердить почту по ссылке',
      method: 'POST',
      path: '/v1/auth/email/verify/confirm',
      summary:
        'Сессия не нужна: письмо открывают в том браузере, куда оно пришло. Токен подтверждения не работает как ссылка смены пароля — цель токена проверяется.',
      fields: [{ name: 'token', label: 'Токен из письма', kind: 'text', required: true }],
      run: (values, { api }) => api.auth.confirmEmail(str(values, 'token')),
    },
    {
      id: 'publication-grant',
      title: 'Согласие на публикацию',
      method: 'POST',
      path: '/v1/publication-consents',
      summary:
        'Разрешение медиаконтуру снимать и показывать. Даёт только участник проекта и только за себя. Версию документа подставь из «Действующие документы» (kind = pdn_biometric): отпечаток текста сервер берёт сам.',
      needsAuth: true,
      fields: [
        idField('projectId', 'Проект'),
        {
          name: 'scope',
          label: 'Что раскрывается',
          kind: 'select',
          required: true,
          defaultValue: 'episode_selection',
          options: [
            { value: 'episode_selection', label: 'episode_selection — выпуск отбора' },
            { value: 'episode_bootcamp', label: 'episode_bootcamp — выпуск буткемпа' },
            { value: 'final_live', label: 'final_live — финальный эфир' },
            { value: 'top100_public', label: 'top100_public — публичный топ-100' },
          ],
        },
        {
          name: 'disclosedFields',
          label: 'Раскрываемые поля',
          kind: 'text',
          placeholder: 'project_title,founder_photo',
          help:
            'Через запятую, до 12 значений из закрытого словаря: project_title, project_tagline, ' +
            'project_description, project_stage, project_geo, investment_ask, founder_display_name, ' +
            'founder_photo, founder_video, team_members, metrics, pitch_deck. Значение вне словаря — 400.',
        },
        {
          name: 'documentVersion',
          label: 'Версия документа',
          kind: 'text',
          required: true,
          defaultValue: 'v1',
          help: 'Действующая версия pdn_biometric. Неверная — 400 с названием действующей, не 500.',
        },
      ],
      run: (values, { api }) =>
        api.publication.grant({
          projectId: str(values, 'projectId'),
          scope: str(values, 'scope') as never,
          disclosedFields: str(values, 'disclosedFields')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean) as never,
          documentVersion: str(values, 'documentVersion'),
        }),
    },
    {
      id: 'publication-list',
      title: 'Мои согласия на публикацию',
      method: 'GET',
      path: '/v1/publication-consents',
      summary: 'Свои согласия, включая отозванные. Идентификатор нужен для отзыва.',
      needsAuth: true,
      fields: [{ ...idField('projectId', 'Проект'), required: false }],
      run: (values, { api }) => api.publication.list(optionalStr(values, 'projectId')),
    },
    {
      id: 'publication-revoke',
      title: 'Отозвать согласие',
      method: 'DELETE',
      path: '/v1/publication-consents/{id}',
      summary:
        'Строка согласия остаётся: отменяется разрешение, а не факт акцепта. В ответе — крайний срок удаления публичной проекции (15 минут). Повторный отзыв отвечает тем же состоянием и второго события не публикует.',
      needsAuth: true,
      fields: [idField('id', 'Согласие')],
      run: (values, { api }) => api.publication.revoke(str(values, 'id')),
    },
  ],
};

export const kycGroup: OperationGroup = {
  id: 'kyc',
  title: 'Проверка личности и юрлица',
  note: 'Без пройденной проверки закрыты сделки и часть действий основателя.',
  operations: [
    {
      id: 'kyc-start',
      title: 'Начать проверку личности',
      method: 'POST',
      path: '/v1/kyc/verifications',
      summary: 'Создаёт заявку. Решение принимает комплаенс — здесь только подача.',
      needsAuth: true,
      fields: [
        {
          name: 'kind',
          label: 'Вид проверки',
          kind: 'select',
          required: true,
          defaultValue: 'identity',
          options: [
            { value: 'identity', label: 'identity — личность' },
            { value: 'investor_status', label: 'investor_status — статус инвестора' },
            { value: 'accredited', label: 'accredited — квалифицированный инвестор' },
          ],
        },
        {
          name: 'docType',
          label: 'Документ',
          kind: 'select',
          required: true,
          defaultValue: 'passport',
          options: [
            { value: 'passport', label: 'passport — паспорт' },
            { value: 'foreign_passport', label: 'foreign_passport — загранпаспорт' },
            { value: 'id_card', label: 'id_card — ID-карта' },
            { value: 'driver_license', label: 'driver_license — водительское' },
          ],
        },
        {
          name: 'docCountry',
          label: 'Страна документа',
          kind: 'text',
          required: true,
          defaultValue: 'RU',
        },
      ],
      remembers: { verificationId: 'id' },
      run: (values, { api }) =>
        api.kyc.start({
          kind: str(values, 'kind') as never,
          docType: str(values, 'docType') as never,
          docCountry: str(values, 'docCountry'),
        }),
    },
    {
      id: 'kyc-status',
      title: 'Мои проверки',
      method: 'GET',
      path: '/v1/kyc/verifications',
      summary: 'Состояние поданных заявок.',
      needsAuth: true,
      remembers: { verificationId: '0.id' },
      run: (_values, { api }) => api.kyc.status(),
    },
    {
      id: 'kyc-entity-create',
      title: 'Создать юрлицо',
      method: 'POST',
      path: '/v1/kyc/entities',
      summary:
        'Эмитент оффера — юрлицо, а не человек: без него инвестиционное предложение не выпустить.',
      needsAuth: true,
      fields: [
        {
          name: 'legalName',
          label: 'Наименование',
          kind: 'text',
          required: true,
          help: '2–300 символов.',
        },
        { name: 'legalForm', label: 'Организационная форма', kind: 'text', placeholder: 'ООО' },
        {
          name: 'inn',
          label: 'ИНН',
          kind: 'text',
          required: true,
          help: '10 цифр для юрлица, 12 для ИП.',
        },
        { name: 'ogrn', label: 'ОГРН', kind: 'text', required: true, help: '13 или 15 цифр.' },
        {
          name: 'jurisdiction',
          label: 'Юрисдикция',
          kind: 'text',
          required: true,
          defaultValue: 'RU',
        },
      ],
      remembers: { entityId: 'id' },
      run: (values, { api }) =>
        api.kyc.createEntity({
          legalName: str(values, 'legalName'),
          legalForm: optionalStr(values, 'legalForm'),
          inn: str(values, 'inn'),
          ogrn: str(values, 'ogrn'),
          jurisdiction: str(values, 'jurisdiction'),
        }),
    },
    {
      id: 'kyc-entities',
      title: 'Мои юрлица',
      method: 'GET',
      path: '/v1/kyc/entities',
      summary: 'Список юрлиц пользователя со статусом проверки.',
      needsAuth: true,
      remembers: { entityId: '0.id' },
      run: (_values, { api }) => api.kyc.entities(),
    },
    {
      id: 'kyb-start',
      title: 'Отправить юрлицо на проверку',
      method: 'POST',
      path: '/v1/kyc/entities/:id/kyb',
      summary: 'Проверка юрлица (KYB). Без неё эмитент не допускается к выпуску.',
      needsAuth: true,
      fields: [idField('entityId', 'Юрлицо')],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/kyc/entities/${str(values, 'entityId')}/kyb`,
          body: {},
        }),
    },
    {
      id: 'kyb-member',
      title: 'Добавить бенефициара',
      method: 'POST',
      path: '/v1/kyc/entities/:id/members',
      summary: 'Участник или бенефициар юрлица — часть обязательного раскрытия.',
      needsAuth: true,
      fields: [
        idField('entityId', 'Юрлицо'),
        { name: 'fullName', label: 'ФИО', kind: 'text', required: true },
        {
          name: 'role',
          label: 'Роль',
          kind: 'text',
          required: true,
          defaultValue: 'beneficiary',
          help: 'Например: beneficiary, director, founder.',
        },
        { name: 'sharePercent', label: 'Доля, %', kind: 'number', placeholder: '100' },
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/kyc/entities/${str(values, 'entityId')}/members`,
          body: {
            fullName: str(values, 'fullName'),
            role: str(values, 'role'),
            sharePercent: optionalStr(values, 'sharePercent')
              ? Number(str(values, 'sharePercent'))
              : undefined,
          },
        }),
    },
  ],
};
