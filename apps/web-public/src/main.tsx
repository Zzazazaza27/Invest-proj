import React from 'react';
import { createRoot } from 'react-dom/client';
import '@unicorn/ui/tokens.css';
import App from './App';

const container = document.getElementById('root');
if (!container) {
  // Молча ничего не рендерить — худший исход: страница пустая, консоль чистая.
  throw new Error('Элемент #root не найден: разметка страницы не соответствует ожидаемой');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
