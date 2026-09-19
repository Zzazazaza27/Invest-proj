import type { OperationGroup } from '../types';
import {
  idField,
  idempotencyField,
  jsonValue,
  money,
  optionalNum,
  optionalStr,
  str,
  CURRENCY_OPTIONS,
} from './shared';

export const investmentsGroup: OperationGroup = {
  id: 'investments',
  title: 'Инвестиционный контур',
  note: 'Регулируемое ядро: приём предложения и подпись требуют второго фактора (step-up MFA).',
  operations: [
    {
      id: 'offer-create',
      title: 'Выпустить предложение',
      method: 'POST',
      path: '/v1/investments/offers',
      summary:
        'Эмитент — проверенное юрлицо, а не человек. Снижение целевой суммы после выпуска запрещено триггером.',
      needsAuth: true,
      fields: [
        idField('projectId', 'Проект'),
        idField(
          'issuerEntityId',
          'Юрлицо-эмитент',
          'Из группы проверки: юрлицо должно пройти KYB.',
        ),
        {
          name: 'instrumentType',
          label: 'Инструмент',
          kind: 'select',
          required: true,
          defaultValue: 'loan',
          options: [
            { value: 'loan', label: 'loan — заём' },
            { value: 'security', label: 'security — ценная бумага' },
            { value: 'utility_digital_right', label: 'utility_digital_right — УЦП' },
            { value: 'dfa', label: 'dfa — ЦФА' },
          ],
        },
        {
          name: 'targetAmount',
          label: 'Целевая сумма',
          kind: 'number',
          required: true,
          defaultValue: '5000000.00',
        },
        {
          name: 'minInvestment',
          label: 'Минимальный чек',
          kind: 'number',
          required: true,
          defaultValue: '100000.00',
        },
        {
          name: 'currency',
          label: 'Валюта',
          kind: 'select',
          required: true,
          defaultValue: 'RUB',
          options: CURRENCY_OPTIONS,
        },
        {
          name: 'terms',
          label: 'Условия (JSON)',
          kind: 'json',
          defaultValue: '{"rate": 12, "termMonths": 24}',
          help: 'Свободный объект условий инструмента.',
        },
        {
          name: 'opensAt',
          label: 'Открывается',
          kind: 'text',
          placeholder: '2026-09-01T00:00:00Z',
        },
        {
          name: 'closesAt',
          label: 'Закрывается',
          kind: 'text',
          placeholder: '2026-12-01T00:00:00Z',
        },
        idempotencyField('offer'),
      ],
      remembers: { offerId: 'id' },
      run: (values, { api }) =>
        api.investments.createOffer({
          projectId: str(values, 'projectId'),
          issuerEntityId: str(values, 'issuerEntityId'),
          instrumentType: str(values, 'instrumentType') as never,
          targetAmount: money(values, 'targetAmount'),
          minInvestment: money(values, 'minInvestment'),
          currency: str(values, 'currency') as never,
          terms: jsonValue(values, 'terms') as Record<string, unknown>,
          opensAt: optionalStr(values, 'opensAt'),
          closesAt: optionalStr(values, 'closesAt'),
          idempotencyKey: str(values, 'idempotencyKey'),
        }),
    },
    {
      id: 'offer-publish',
      title: 'Опубликовать предложение',
      method: 'POST',
      path: '/v1/investments/offers/:id/publish',
      summary: 'До публикации инвестор предложения не видит.',
      needsAuth: true,
      fields: [idField('offerId', 'Предложение')],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: `/investments/offers/${str(values, 'offerId')}/publish`,
          body: {},
        }),
    },
    {
      id: 'offers-list',
      title: 'Список предложений',
      method: 'GET',
      path: '/v1/investments/offers',
      summary: 'Постраничный список. Инвестор видит опубликованные, эмитент — свои.',
      needsAuth: true,
      fields: [
        { name: 'limit', label: 'Сколько вернуть', kind: 'number', defaultValue: 10 },
        {
          name: 'cursor',
          label: 'Курсор',
          kind: 'text',
          help: 'nextCursor из предыдущего ответа.',
        },
      ],
      remembers: { offerId: 'items.0.id' },
      run: (values, { api }) =>
        api.investments.offers({
          limit: optionalNum(values, 'limit'),
          cursor: optionalStr(values, 'cursor'),
        }),
    },
    {
      id: 'offer-accept',
      title: 'Принять предложение',
      method: 'POST',
      path: '/v1/investments/agreements',
      summary:
        'Создаёт договор. Требует второго фактора: 403 STEP_UP_REQUIRED здесь — правильное поведение, а не поломка.',
      needsAuth: true,
      fields: [
        idField('offerId', 'Предложение'),
        {
          name: 'contractAmount',
          label: 'Сумма договора',
          kind: 'number',
          required: true,
          defaultValue: '100000.00',
        },
        {
          name: 'currency',
          label: 'Валюта',
          kind: 'select',
          required: true,
          defaultValue: 'RUB',
          options: CURRENCY_OPTIONS,
        },
        {
          name: 'acknowledgedFeeDisclosure',
          label: 'Подтверждаю раскрытие комиссий',
          kind: 'checkbox',
          required: true,
          defaultValue: true,
          help: 'Без явного подтверждения сервер отвечает 422 — сними галочку, чтобы это увидеть.',
        },
        {
          name: 'acknowledgedRulesVersion',
          label: 'Версия правил',
          kind: 'text',
          required: true,
          defaultValue: '1.0.0',
        },
        idempotencyField('accept'),
      ],
      remembers: { agreementId: 'id' },
      run: (values, { api }) =>
        api.investments.acceptOffer({
          offerId: str(values, 'offerId'),
          contractAmount: money(values, 'contractAmount'),
          currency: str(values, 'currency') as never,
          acknowledgedFeeDisclosure: (values.acknowledgedFeeDisclosure === true ||
            values.acknowledgedFeeDisclosure === 'true') as true,
          acknowledgedRulesVersion: str(values, 'acknowledgedRulesVersion'),
          idempotencyKey: str(values, 'idempotencyKey'),
        }),
    },
    {
      id: 'agreement-sign',
      title: 'Подписать договор',
      method: 'POST',
      path: '/v1/investments/agreements/:id/signature',
      summary:
        'Подписывается хеш документа, который пользователь ФАКТИЧЕСКИ видел: подмена текста после показа обнаруживается несовпадением.',
      needsAuth: true,
      fields: [
        idField('agreementId', 'Договор'),
        {
          name: 'documentSha256',
          label: 'sha256 документа',
          kind: 'text',
          required: true,
          help: '64 шестнадцатеричных символа. Неверный хеш обязан быть отвергнут.',
        },
        idempotencyField('sign'),
      ],
      run: (values, { api }) =>
        api.investments.signAgreement({
          agreementId: str(values, 'agreementId'),
          documentSha256: str(values, 'documentSha256'),
          idempotencyKey: str(values, 'idempotencyKey'),
        }),
    },
    {
      id: 'agreements-list',
      title: 'Мои договоры',
      method: 'GET',
      path: '/v1/investments/agreements',
      summary: 'Договоры пользователя со статусом подписания.',
      needsAuth: true,
      fields: [{ name: 'limit', label: 'Сколько вернуть', kind: 'number', defaultValue: 10 }],
      remembers: { agreementId: 'items.0.id' },
      run: (values, { api }) => api.investments.agreements({ limit: optionalNum(values, 'limit') }),
    },
    {
      id: 'tranche-confirm',
      title: 'Подтвердить транш',
      method: 'POST',
      path: '/v1/investments/tranches/confirm',
      summary:
        'Фиксирует поступление средств по договору. Денежная операция — ключ идемпотентности обязателен.',
      needsAuth: true,
      fields: [
        idField('agreementId', 'Договор'),
        {
          name: 'amount',
          label: 'Сумма',
          kind: 'number',
          required: true,
          defaultValue: '100000.00',
        },
        {
          name: 'currency',
          label: 'Валюта',
          kind: 'select',
          required: true,
          defaultValue: 'RUB',
          options: CURRENCY_OPTIONS,
        },
        {
          name: 'externalRef',
          label: 'Внешняя ссылка платежа',
          kind: 'text',
          help: 'Идентификатор проводки во внешней системе.',
        },
        idempotencyField('tranche'),
      ],
      run: (values, { api }) =>
        api.http.request({
          method: 'POST',
          path: '/investments/tranches/confirm',
          idempotencyKey: str(values, 'idempotencyKey'),
          body: {
            agreementId: str(values, 'agreementId'),
            amount: money(values, 'amount'),
            currency: str(values, 'currency'),
            externalRef: optionalStr(values, 'externalRef'),
            idempotencyKey: str(values, 'idempotencyKey'),
          },
        }),
    },
  ],
};

export const billingGroup: OperationGroup = {
  id: 'billing',
  title: 'Подписки и счета',
  note: 'Второй денежный контур — отдельный от инвестиционного (ADR-005).',
  operations: [
    {
      id: 'billing-subscribe',
      title: 'Оформить подписку',
      method: 'POST',
      path: '/v1/billing/subscriptions',
      summary:
        'У основателя подписка привязана к проекту, у инвестора — к пользователю. Это разные варианты одного запроса.',
      needsAuth: true,
      fields: [idempotencyField('sub')],
      remembers: { subscriptionId: 'id' },
      // Подписка бывает только у инвестора: подписка основателя по сумме
      // привлечения отменена (M094) — запуск раунда оплачивается разово.
      run: (values, { api }) =>
        api.billing.subscribe({ idempotencyKey: str(values, 'idempotencyKey') }),
    },
    {
      id: 'billing-subscriptions',
      title: 'Мои подписки',
      method: 'GET',
      path: '/v1/billing/subscriptions',
      summary: 'Состояние подписок. Самоактивация запрещена: статус меняет сервер, а не клиент.',
      needsAuth: true,
      remembers: { subscriptionId: '0.id' },
      run: (_values, { api }) => api.billing.subscriptions(),
    },
    {
      id: 'billing-cancel',
      title: 'Отменить подписку',
      method: 'POST',
      path: '/v1/billing/subscriptions/:id/cancel',
      summary: 'Отмена по инициативе пользователя.',
      needsAuth: true,
      fields: [idField('subscriptionId', 'Подписка')],
      run: (values, { api }) => api.billing.cancel(str(values, 'subscriptionId')),
    },
    {
      id: 'billing-invoices',
      title: 'Счета',
      method: 'GET',
      path: '/v1/billing/invoices',
      summary: 'Выставленные счета.',
      needsAuth: true,
      remembers: { invoiceId: '0.id' },
      run: (_values, { api }) => api.billing.invoices(),
    },
    {
      id: 'billing-accruals',
      title: 'Начисления вознаграждения',
      method: 'GET',
      path: '/v1/billing/accruals',
      summary: 'Комиссия платформы по сделкам — та самая радикальная прозрачность.',
      needsAuth: true,
      run: (_values, { api }) => api.billing.accruals(),
    },
    {
      id: 'billing-pay',
      title: 'Оплатить счёт',
      method: 'POST',
      path: '/v1/billing/payments',
      summary:
        'Приём платежей ВЫКЛЮЧЕН флагом billing.payments.enabled — платёжный провайдер не подключён, и маршрут отвечает 503 feature_disabled. До Ф52 он отвечал 404: метод клиента был ловушкой. Тело всё равно проверяется схемой, поэтому невалидный запрос даст 400, а не «функция выключена».',
      needsAuth: true,
      fields: [
        idField('invoiceId', 'Счёт'),
        { name: 'amount', label: 'Сумма', kind: 'number', required: true },
        {
          name: 'currency',
          label: 'Валюта',
          kind: 'select',
          required: true,
          defaultValue: 'RUB',
          options: CURRENCY_OPTIONS,
        },
        {
          name: 'returnUrl',
          label: 'Адрес возврата',
          kind: 'text',
          placeholder: 'https://example.com/return',
        },
        idempotencyField('pay'),
      ],
      run: (values, { api }) =>
        api.billing.pay({
          invoiceId: str(values, 'invoiceId'),
          amount: money(values, 'amount'),
          currency: str(values, 'currency') as never,
          returnUrl: optionalStr(values, 'returnUrl'),
          idempotencyKey: str(values, 'idempotencyKey'),
        }),
    },
  ],
};
