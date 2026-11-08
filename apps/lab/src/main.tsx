import React from 'react';
import { createRoot } from 'react-dom/client';
import { ClientErrorBoundary, reportClientError } from '@fifth/cabinet';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import '@fifth/ui/tokens.css';
// Брендовая тема платформы: палитра, шрифт Manrope (тянется самой темой) и
// крупные формы. Включается атрибутом `data-brand="nova"` в `index.html`;
// убрать её — снять атрибут и этот импорт.
import '@fifth/ui/theme-nova.css';
import { applyPlatformSkin } from '@fifth/ui';

import App from './App';
import { LeaveGuardHost } from './LeaveGuardHost';

// Скин платформы (M145): до его прочтения страница скрыта (data-skin-pending
// в index.html). Отрисовка не ждёт — показ снимает сама функция.
void applyPlatformSkin(import.meta.env.VITE_API_BASE_URL as string | undefined);

const container = document.getElementById('root');
if (!container) {
  throw new Error('Элемент #root не найден: разметка страницы не соответствует ожидаемой');
}

// Маршрутизатор: у страницы проекта и словаря есть адрес, по которому можно
// вернуться. `basename` — тот же подпуть, под которым кабинет раздаётся
// единой точкой входа. Маршрутизатор с данными нужен блокировке перехода при
// несохранённой форме (2.2/2.3); сами маршруты — прежние `<Routes>` внутри App.
const router = createBrowserRouter(
  [
    {
      path: '*',
      element: (
        <>
          <LeaveGuardHost />
          <App />
        </>
      ),
    },
  ],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') },
);

createRoot(container).render(
  <React.StrictMode>
    <ClientErrorBoundary>
      <RouterProvider
        router={router}
        onError={(_error, info) =>
          reportClientError('render.boundary', info.errorInfo ? 'render' : 'navigate')
        }
      />
    </ClientErrorBoundary>
  </React.StrictMode>,
);
