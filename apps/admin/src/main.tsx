import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import '@unicorn/ui/tokens.css';
import './styles.css';

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
