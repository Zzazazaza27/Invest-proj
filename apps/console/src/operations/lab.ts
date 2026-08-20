import type { OperationGroup } from '../types';
import {
  fileValue,
  idField,
  money,
  optionalMoney,
  optionalStr,
  str,
  CURRENCY_OPTIONS,
  PROJECT_STAGE_OPTIONS,
} from './shared';

export const projectsGroup: OperationGroup = {
  id: 'projects',
  title: 'Проекты основателя',
  note: 'Роль founder. Порядок: создать → материалы → подать → анализ → листинг.',
  operations: [
    {
      id: 'projects-create',
      title: 'Создать проект',
      method: 'POST',
      path: '/v1/projects',
      summary: 'Черновик заявки. taxonomyId возьми из справочника направлений в публичной группе.',
      needsAuth: true,
      fields: [
        { name: 'title', label: 'Название', kind: 'text', required: true, help: '2–200 символов.' },
        { name: 'tagline', label: 'Короткое описание', kind: 'text', help: 'До 300 символов.' },
        { name: 'description', label: 'Описание', kind: 'textarea', help: 'До 20 000 символов.' },
        {
          name: 'stage',
          label: 'Стадия',
          kind: 'select',
          required: true,
          defaultValue: 'mvp',
          options: PROJECT_STAGE_OPTIONS,
        },
        idField(
          'taxonomyId',
          'Направление',
          'Подставляется из блокнота после вызова справочника направлений.',
        ),
        { name: 'geoCountry', label: 'Страна', kind: 'text', defaultValue: 'RU' },
        { name: 'geoRegion', label: 'Регион', kind: 'text' },
        {
          name: 'investmentAsk',
          label: 'Запрашиваемая сумма',
          kind: 'number',
          required: true,
          defaultValue: '5000000.00',
        },
        {
          name: 'askCurrency',
          label: 'Валюта',
          kind: 'select',
          required: true,
          defaultValue: 'RUB',
          options: CURRENCY_OPTIONS,
        },
      ],
      remembers: { projectId: 'id' },
      run: (values, { api }) =>
        api.projects.create({
          title: str(values, 'title'),
          tagline: optionalStr(values, 'tagline'),
          description: optionalStr(values, 'description'),
          stage: str(values, 'stage') as never,
          taxonomyId: str(values, 'taxonomyId'),
          geoCountry: optionalStr(values, 'geoCountry'),
          geoRegion: optionalStr(values, 'geoRegion'),
          investmentAsk: money(values, 'investmentAsk'),
          askCurrency: str(values, 'askCurrency') as never,
        }),
    },
    {
      id: 'projects-list',
      title: 'Мои проекты',
      method: 'GET',
      path: '/v1/projects',
      summary:
        'Краткая форма. Чужие проекты сюда не попадают — это и проверяется входом под другим пользователем.',
      needsAuth: true,
      remembers: { projectId: '0.id' },
      run: (_values, { api }) => api.projects.list(),
    },
    {
      id: 'projects-get',
      title: 'Карточка проекта',
      method: 'GET',
      path: '/v1/projects/:id',
      summary:
        'Полная карточка владельца. Сравни с публичной карточкой каталога: наружу уходит меньше.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      run: (values, { api }) => api.projects.get(str(values, 'projectId')),
    },
    {
      id: 'projects-update',
      title: 'Изменить проект',
      method: 'PATCH',
      path: '/v1/projects/:id',
      summary:
        'Частичное обновление: заполняй только те поля, которые меняешь — пустые не отправляются.',
      needsAuth: true,
      fields: [
        idField('projectId', 'Проект'),
        { name: 'title', label: 'Название', kind: 'text' },
        { name: 'tagline', label: 'Короткое описание', kind: 'text' },
        { name: 'description', label: 'Описание', kind: 'textarea' },
        {
          name: 'stage',
          label: 'Стадия',
          kind: 'select',
          options: [{ value: '', label: '(не менять)' }, ...PROJECT_STAGE_OPTIONS],
        },
        { name: 'investmentAsk', label: 'Запрашиваемая сумма', kind: 'number' },
      ],
      run: (values, { api }) =>
        api.projects.update(str(values, 'projectId'), {
          title: optionalStr(values, 'title'),
          tagline: optionalStr(values, 'tagline'),
          description: optionalStr(values, 'description'),
          stage: optionalStr(values, 'stage') as never,
          investmentAsk: optionalMoney(values, 'investmentAsk'),
        }),
    },
    {
      id: 'projects-submit',
      title: 'Подать заявку',
      method: 'POST',
      path: '/v1/projects/:id/submit',
      summary:
        'Фиксирует версию-снимок, на которую сошлётся экспертиза. Повторная подача без изменений отклоняется.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      run: (values, { api }) => api.projects.submit(str(values, 'projectId')),
    },
    {
      id: 'projects-versions',
      title: 'История подач',
      method: 'GET',
      path: '/v1/projects/:id/versions',
      summary: 'Версии-снимки заявки. Именно на них ссылается рецензия, а не на текущее состояние.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      run: (values, { api }) => api.projects.versions(str(values, 'projectId')),
    },
    {
      id: 'projects-publish',
      title: 'Опубликовать в каталоге',
      method: 'POST',
      path: '/v1/projects/:id/listing',
      summary: 'Выводит проект в публичный каталог. После этого он виден без входа.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      run: (values, { api }) => api.projects.publish(str(values, 'projectId')),
    },
    {
      id: 'projects-unpublish',
      title: 'Снять с публикации',
      method: 'DELETE',
      path: '/v1/projects/:id/listing',
      summary: 'Убирает из каталога. Проверь каталогом, что карточка действительно исчезла.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      run: (values, { api }) => api.projects.unpublish(str(values, 'projectId')),
    },
  ],
};

export const materialsGroup: OperationGroup = {
  id: 'materials',
  title: 'Материалы проекта',
  note: 'Загрузка идёт в хранилище напрямую по временной ссылке, а не через ядро.',
  operations: [
    {
      id: 'materials-list',
      title: 'Материалы проекта',
      method: 'GET',
      path: '/v1/projects/:id/materials',
      summary: 'Список приложенных материалов и их состояние.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      remembers: { materialId: '0.id' },
      run: (values, { api }) => api.projects.materials(str(values, 'projectId')),
    },
    {
      id: 'materials-upload',
      title: 'Загрузить файл (билет + отправка + подтверждение)',
      method: 'POST',
      path: '/v1/projects/:id/materials/upload',
      summary:
        'Три шага одной операцией: запрос билета, отправка файла в хранилище по временной ссылке, подтверждение. Сервер проверяет НАЛИЧИЕ объекта и считает sha256 фактических байтов — подделать «я загрузил» нельзя.',
      needsAuth: true,
      fields: [
        idField('projectId', 'Проект'),
        {
          name: 'type',
          label: 'Тип материала',
          kind: 'select',
          required: true,
          defaultValue: 'deck',
          options: [
            { value: 'deck', label: 'deck — презентация' },
            { value: 'video', label: 'video — видео' },
            { value: 'doc', label: 'doc — документ' },
          ],
          help: 'Тип и MIME сверяются по матрице контрактов: video/mp4 как deck сервер отвергнет.',
        },
        {
          name: 'file',
          label: 'Файл',
          kind: 'file',
          required: true,
          help: 'Первые байты сверяются с сигнатурой формата — переименованный HTML в PDF не пройдёт.',
        },
      ],
      remembers: { materialId: 'id' },
      run: async (values, { api }) => {
        const projectId = str(values, 'projectId');
        const file = fileValue(values, 'file');
        if (!file) throw new Error('Файл не выбран');

        // 1. Билет: сервер выдаёт временную ссылку и заводит запись материала.
        const ticket = await api.projects.requestUpload(projectId, {
          projectId,
          type: str(values, 'type') as never,
          fileName: file.name,
          contentType: file.type as never,
          sizeBytes: file.size,
        });

        // 2. Отправка в хранилище НАПРЯМУЮ. Ядро файл не проксирует.
        //
        // Это POST формы, а не PUT: билет несёт подписанные поля политики
        // (`formFields`), и файл обязан идти ПОСЛЕДНИМ полем с именем `file` —
        // хранилище разбирает форму потоком и всё, что после файла, игнорирует.
        const { uploadUrl, materialId, formFields } = ticket as unknown as {
          uploadUrl: string;
          materialId: string;
          formFields: Record<string, string>;
        };
        const form = new FormData();
        for (const [key, value] of Object.entries(formFields)) form.append(key, value);
        form.append('file', file);

        const upload = await fetch(uploadUrl, { method: 'POST', body: form });
        if (!upload.ok) {
          throw new Error(
            `Хранилище отклонило файл: HTTP ${upload.status}. ` +
              'Отказ CORS означает, что хранилище не разрешает запись из браузера — тогда загрузку делают вне консоли.',
          );
        }

        // 3. Подтверждение: сервер читает объект и считает хеш сам.
        const material = await api.projects.finalizeUpload(projectId, materialId);
        return { ticket, storageStatus: upload.status, material };
      },
    },
    {
      id: 'materials-finalize',
      title: 'Подтвердить загрузку отдельно',
      method: 'POST',
      path: '/v1/projects/:id/materials/:materialId/finalize',
      summary: 'Отдельный шаг подтверждения — если файл клали в хранилище мимо консоли.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект'), idField('materialId', 'Материал')],
      run: (values, { api }) =>
        api.projects.finalizeUpload(str(values, 'projectId'), str(values, 'materialId')),
    },
    {
      id: 'materials-link',
      title: 'Приложить ссылку на продукт',
      method: 'POST',
      path: '/v1/projects/:id/materials/link',
      summary:
        'Только https и только внешние адреса: внутренние сети и адреса метаданных сервер отвергает (защита от SSRF).',
      needsAuth: true,
      fields: [
        idField('projectId', 'Проект'),
        {
          name: 'url',
          label: 'Ссылка',
          kind: 'text',
          required: true,
          placeholder: 'https://example.com',
          help: 'Попробуй http:// или https://127.0.0.1 — отказ здесь и есть проверка защиты.',
        },
      ],
      run: (values, { api }) =>
        api.projects.addProductLink(str(values, 'projectId'), {
          projectId: str(values, 'projectId'),
          url: str(values, 'url'),
        }),
    },
  ],
};

export const analysisGroup: OperationGroup = {
  id: 'analysis',
  title: 'ИИ-анализ и паспорт',
  note: 'Требует поданной заявки и подтверждённых материалов.',
  operations: [
    {
      id: 'analysis-run',
      title: 'Запустить анализ',
      method: 'POST',
      path: '/v1/projects/:id/analysis',
      summary:
        'Считает оценку по осям. В ответе видно, посчитала ли её модель или сработал запасной путь.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      run: (values, { api }) => api.projects.runAnalysis(str(values, 'projectId')),
    },
    {
      id: 'analysis-readiness',
      title: 'Готовность',
      method: 'GET',
      path: '/v1/projects/:id/readiness',
      summary: 'Чего проекту не хватает до следующего этапа.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      run: (values, { api }) => api.projects.readiness(str(values, 'projectId')),
    },
    {
      id: 'analysis-roadmap',
      title: 'Дорожная карта',
      method: 'GET',
      path: '/v1/projects/:id/roadmap',
      summary: 'Рекомендованные шаги проекта.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      run: (values, { api }) => api.projects.roadmap(str(values, 'projectId')),
    },
    {
      id: 'analysis-passport',
      title: 'Инвестиционный паспорт',
      method: 'GET',
      path: '/v1/projects/:id/passport',
      summary: 'Сводка для инвестора. Проверь, что персональных данных основателя в ней нет.',
      needsAuth: true,
      fields: [idField('projectId', 'Проект')],
      run: (values, { api }) => api.projects.passport(str(values, 'projectId')),
    },
  ],
};
