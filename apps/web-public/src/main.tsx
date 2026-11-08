import React from 'react';
import { createRoot } from 'react-dom/client';
import { ClientErrorBoundary } from '@fifth/cabinet';
import '@fifth/ui/tokens.css';
// Брендовая тема платформы: палитра, шрифт Manrope (тянется самой темой) и
// крупные формы. Включается атрибутом `data-brand="nova"` в `index.html`;
// убрать её — снять атрибут и этот импорт.
import '@fifth/ui/theme-nova.css';
import { applyPlatformSkin } from '@fifth/ui';

import App from './App';

// Скин платформы (M145): до его прочтения страница скрыта (data-skin-pending
// в index.html). Отрисовка не ждёт — показ снимает сама функция.
void applyPlatformSkin(import.meta.env.VITE_API_BASE_URL as string | undefined);

const container = document.getElementById('root');
if (!container) {
  // Молча ничего не рендерить — худший исход: страница пустая, консоль чистая.
  throw new Error('Элемент #root не найден: разметка страницы не соответствует ожидаемой');
}

createRoot(container).render(
  <React.StrictMode>
    <ClientErrorBoundary>
      <App />
    </ClientErrorBoundary>
  </React.StrictMode>,
);
