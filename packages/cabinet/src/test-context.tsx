import { useCallback, useEffect, useState } from 'react';
import type { CurrentContext } from '@unicorn/contracts';

/**
 * Тестовая вкладка: контекст доступа и плашка над кабинетом.
 *
 * ПОЧЕМУ СОСТОЯНИЕ ВКЛАДКИ, А НЕ БРАУЗЕРА. Идентификатор контекста кладётся
 * в `sessionStorage` — хранилище, своё у каждой вкладки. `localStorage` и
 * cookie общие на origin: открыв участника в одной вкладке, человек получил
 * бы его же в админской. Ровно от этого весь механизм и построен.
 *
 * ПОЧЕМУ ИЗ ЯКОРЯ. Идентификатор приезжает в адресе после `#`. Якорь не
 * уходит на сервер и не попадает в журналы доступа; сам по себе он ничего не
 * открывает — без административной сессии инициатора сервер откажет. Сразу
 * после чтения адрес чистится: ссылку не перешлют по ошибке, и обновление
 * страницы возьмёт контекст уже из состояния вкладки.
 */

const STORAGE_KEY = 'unicorn.test-context';
const HASH_KEY = 'ctx';

/** Прочитать контекст из адреса, переложить во вкладку и вычистить адрес. */
export function adoptTestContextFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.replace(/^#/, '');
  if (hash) {
    const params = new URLSearchParams(hash);
    const fromUrl = params.get(HASH_KEY);
    if (fromUrl) {
      try {
        window.sessionStorage.setItem(STORAGE_KEY, fromUrl);
      } catch {
        // Приватное окно или запрет хранилища: контекст проживёт до
        // перезагрузки. Это хуже, но лучше, чем белый экран.
      }
      params.delete(HASH_KEY);
      const rest = params.toString();
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`,
      );
      return fromUrl;
    }
  }
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function forgetTestContext(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* хранилище недоступно — забывать нечего */
  }
}

/**
 * Как забрать файл в текущем контексте.
 *
 * Картинку браузер запрашивает САМ, и заголовка контекста в таком запросе
 * нет: запрос уйдёт под административной сессией, и во вкладке участника
 * окажется то, что видно администратору, а не ему. Поэтому в контексте файл
 * забирается обычным запросом клиента API (с заголовком), а в разметку идёт
 * ссылка на полученные байты.
 *
 * Приложение регистрирует способ один раз при старте; пакет не знает про
 * клиента API и не должен знать.
 */
let fileResolver: ((path: string) => Promise<string>) | null = null;

export function setContextFileResolver(resolve: (path: string) => Promise<string>): void {
  fileResolver = resolve;
}

/**
 * Картинка, которая уважает контекст вкладки.
 *
 * Вне контекста — обычный `<img>`: лишние запросы там, где личность и так
 * верна, не нужны.
 */
export function ContextualImage({
  src,
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    const active = readTestContext();
    if (!active || !fileResolver) {
      setResolved(null);
      return;
    }
    let alive = true;
    let objectUrl: string | null = null;
    void fileResolver(src)
      .then((url) => {
        if (!alive) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setResolved(url);
      })
      .catch(() => {
        // Файл недоступен в этом контексте — это честный результат, а не
        // повод показать чужую картинку из административной сессии.
        if (alive) setResolved(null);
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  const active = readTestContext();
  if (active && fileResolver && !resolved) {
    // Пока байты не пришли, показывать исходный адрес НЕЛЬЗЯ: это и была бы
    // та самая загрузка от имени администратора.
    return <img {...rest} alt={rest.alt ?? ''} />;
  }
  return <img {...rest} src={resolved ?? src} alt={rest.alt ?? ''} />;
}

/** Текущий контекст вкладки без обращения к серверу. */
export function readTestContext(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export interface TestContextPort {
  /** Что за контекст сейчас открыт. `null` — обычная работа. */
  current(): Promise<CurrentContext | null>;
  /** Завершить контекст. Это ДЕЙСТВИЕ АДМИНИСТРАТОРА, а не участника. */
  close(contextId: string): Promise<void>;
  /** Куда вернуться в админку. */
  adminUrl: string;
}

const LABEL: Record<CurrentContext['kind'], string> = {
  participant: 'Тестовая сессия',
  readonly: 'Просмотр от имени',
  guest: 'Тестовая сессия · гость',
};

/**
 * Плашка над кабинетом.
 *
 * Видна постоянно и намеренно заметна: человек обязан в любой момент знать,
 * что смотрит не своими глазами. Незаметная плашка — это приглашение
 * принять чужой кабинет за свой и «починить» в нём что-нибудь.
 */
export function TestContextBanner({
  port,
  contextId,
  subjectName,
}: {
  port: TestContextPort;
  contextId: string | null;
  subjectName?: string | null;
}) {
  const [context, setContext] = useState<CurrentContext | null>(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!contextId) {
      setContext(null);
      return;
    }
    let alive = true;
    void port
      .current()
      .then((value) => {
        if (alive) setContext(value);
      })
      .catch(() => {
        // Контекст мог истечь или быть отозван: плашку не показываем, но и
        // экран не ломаем — запросы всё равно получат честный отказ.
        if (alive) setContext(null);
      });
    return () => {
      alive = false;
    };
  }, [port, contextId]);

  const finish = useCallback(async () => {
    if (!context) return;
    setClosing(true);
    setError(null);
    try {
      await port.close(context.id);
      forgetTestContext();
      window.location.assign(port.adminUrl);
    } catch (problem) {
      setClosing(false);
      setError(problem instanceof Error ? problem.message : 'не удалось завершить');
    }
  }, [context, port]);

  if (!context) return null;

  const who = subjectName ? ` · ${subjectName}` : '';
  return (
    <div
      data-test-context={context.kind}
      role="region"
      aria-label="Режим тестового просмотра"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 1000,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
        padding: '8px 16px',
        background: context.readOnly ? '#7a3b00' : '#1f3a5f',
        color: '#fff',
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      <strong data-test-context-title>
        {LABEL[context.kind]}
        {who}
      </strong>
      {context.readOnly ? (
        <span
          data-test-context-readonly
          style={{
            padding: '1px 8px',
            borderRadius: 999,
            background: 'rgba(255,255,255,0.18)',
            fontWeight: 600,
          }}
        >
          Только чтение
        </span>
      ) : null}
      <span style={{ flex: 1 }} />
      {error ? <span data-test-context-error>{error}</span> : null}
      <a
        href={port.adminUrl}
        data-test-context-back
        style={{ color: '#fff', textDecoration: 'underline' }}
      >
        Вернуться в админку
      </a>
      <button
        type="button"
        data-test-context-finish
        onClick={() => void finish()}
        disabled={closing}
        style={{
          background: 'rgba(255,255,255,0.16)',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.4)',
          borderRadius: 6,
          padding: '3px 10px',
          cursor: closing ? 'progress' : 'pointer',
        }}
      >
        {closing ? 'Завершаю…' : 'Завершить просмотр'}
      </button>
    </div>
  );
}
