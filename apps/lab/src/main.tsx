import React from 'react';
import { createRoot } from 'react-dom/client';
// Шрифт темы. Самохостинг пакетом, а не ссылка на CDN: сторонний домен в
// критическом пути отрисовки — это и внешняя зависимость доступности, и запрос,
// который CSP боевого контура пришлось бы разрешать.
import '@fontsource-variable/manrope';
import '@unicorn/ui/tokens.css';
// Брендовая тема кабинета основателя. Включается атрибутом `data-brand="nova"`
// в `index.html`; убрать её — снять атрибут и этот импорт, остальной код
// кабинета о теме не знает.
import '@unicorn/ui/theme-nova.css';
import App from './App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Элемент #root не найден: разметка страницы не соответствует ожидаемой');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
