import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import '@fifth/ui/tokens.css';
// Брендовая тема платформы: палитра, шрифт Manrope (тянется самой темой) и
// крупные формы. Включается атрибутом `data-brand="nova"` в `index.html`;
// убрать её — снять атрибут и этот импорт.
import '@fifth/ui/theme-nova.css';
import { applyPlatformSkin } from '@fifth/ui';

import './styles.css';

// Скин платформы (M145): до его прочтения страница скрыта (data-skin-pending
// в index.html). Отрисовка не ждёт — показ снимает сама функция.
void applyPlatformSkin(import.meta.env.VITE_API_BASE_URL as string | undefined);

const container = document.getElementById('root');
if (!container) throw new Error('Не найден корневой элемент #root');

createRoot(container).render(
  <StrictMode>
    {/*
      Базовый путь берётся из сборки (`base` в vite.config.ts), а не зашивается
      здесь: под единой точкой входа админка живёт на /admin/, а при запуске
      dev-сервером — в корне. Зашитое значение сломало бы один из двух режимов.
      `import.meta.env.BASE_URL` всегда заканчивается косой чертой, react-router
      ждёт путь без неё.
    */}
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
