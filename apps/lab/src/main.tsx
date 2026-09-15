import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@unicorn/ui/tokens.css';
// Брендовая тема платформы: палитра, шрифт Manrope (тянется самой темой) и
// крупные формы. Включается атрибутом `data-brand="nova"` в `index.html`;
// убрать её — снять атрибут и этот импорт.
import '@unicorn/ui/theme-nova.css';
import App from './App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Элемент #root не найден: разметка страницы не соответствует ожидаемой');
}

// Маршрутизатор появился вместе с мастером заявки (этап 4): у раздела анкеты
// и предпросмотра есть адрес, по которому можно вернуться. `basename` — тот
// же подпуть, под которым кабинет раздаётся единой точкой входа.
createRoot(container).render(
  <React.StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
