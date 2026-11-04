import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Field, Input, Stack } from '@fifth/ui';
import type { BugContext, CreateSupportTicketRequest } from '@fifth/contracts';

/**
 * Сообщение об ошибке от человека, а не от системы.
 *
 * Это НЕ автоматический error tracking: платформа не пытается решать, что
 * считать ошибкой. Здесь тестировщик или пользователь говорит об этом сам —
 * а технический контекст прикладывается за него, чтобы не переписывать
 * руками адрес страницы, версию сборки и время.
 *
 * ЧТО ИМЕННО ПРИКЛАДЫВАЕТСЯ — и почему именно столько.
 *
 * Клиент присылает только то, чего сервер о странице знать не может: адрес,
 * версию сборки, размер окна, язык интерфейса. Всё остальное — момент,
 * пользователь, его роли, браузер, сквозной идентификатор запроса — берёт
 * сервер из контекста запроса. Иначе это были бы утверждения страницы о самой
 * себе, а в сообщении об ошибке нужен факт.
 *
 * ЧЕГО НЕ ПРИКЛАДЫВАЕТСЯ НИКОГДА: пароля, access/refresh-токена, cookie
 * авторизации, содержимого хранилищ браузера. Их здесь нет не потому, что мы
 * решили их не брать, а потому, что для них нет полей: сервер отвергает
 * неизвестное поле контекста отказом, а не молча.
 *
 * ФРАГМЕНТ АДРЕСА ОТРЕЗАЕТСЯ. По фрагменту ходят токены из писем
 * (`#reset=…`, `#verify=…`): переслать его в обращение значило бы положить
 * ссылку на смену пароля в служебный ящик и в базу.
 */

/** Транспорт. Пакет не ходит в сеть сам — это видно в сигнатуре. */
export interface BugReportPort {
  open: (input: CreateSupportTicketRequest) => Promise<{ id: string }>;
}

/**
 * Служебная комбинация: **Ctrl+Alt+B**.
 *
 * Почему именно она. `Ctrl+Shift+…` и `Alt+Shift+…` отпадают сразу: первый
 * занят браузером (`Ctrl+Shift+B` — панель закладок), второй на русской
 * Windows по умолчанию переключает раскладку. Одиночные F-клавиши тоже заняты
 * (`F1` справка, `F3` поиск, `F5` перезагрузка, `F11` полный экран, `F12`
 * инструменты разработчика). `Ctrl+Alt+B` не назначен ни в Chrome, ни в
 * Firefox, ни в Edge, ни в самой Windows.
 *
 * Проверяется `code`, а не `key`: на русской раскладке `key` даст «и», и
 * комбинация перестала бы работать ровно у тех, для кого написана.
 */
const HOTKEY_CODE = 'KeyB';
export const BUG_REPORT_HOTKEY_LABEL = 'Ctrl + Alt + B';

/** Технический контекст, который может собрать только страница. */
function collectContext(appVersion?: string): BugContext {
  const context: BugContext = {};
  if (typeof window !== 'undefined') {
    // Фрагмент отрезается: по нему ходят токены из писем.
    const { origin, pathname, search } = window.location;
    context.url = `${origin}${pathname}${search}`.slice(0, 2000);
    context.viewport = `${window.innerWidth}x${window.innerHeight}`;
  }
  if (typeof navigator !== 'undefined' && navigator.language) {
    context.locale = navigator.language.slice(0, 35);
  }
  if (appVersion) context.appVersion = appVersion.slice(0, 100);
  return context;
}

export function BugReportWidget({
  port,
  appVersion,
  /**
   * Малозаметная кнопка рядом с комбинацией клавиш.
   *
   * Комбинация — для тестировщика, который о ней знает. Кнопка — для всех
   * остальных: механизм, о существовании которого нельзя догадаться, для
   * обычного пользователя равен отсутствующему.
   */
  showButton = true,
}: {
  port: BugReportPort;
  appVersion?: string;
  showButton?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const contextRef = useRef<BugContext>({});

  const openForm = useCallback(() => {
    // Контекст снимается В МОМЕНТ ВЫЗОВА, а не при отправке: пока человек
    // печатает, он может уйти на другую страницу, и адрес уехал бы вместе с ним.
    contextRef.current = collectContext(appVersion);
    setSentId(null);
    setError(null);
    setOpen(true);
  }, [appVersion]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.ctrlKey && event.altKey && !event.shiftKey && event.code === HOTKEY_CODE) {
        event.preventDefault();
        openForm();
        return;
      }
      // Escape закрывает форму — иначе окно, открытое случайной комбинацией,
      // нечем убрать, кроме мыши.
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openForm]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await port.open({
        kind: 'bug_report',
        subject: subject.trim(),
        body: details.trim() || subject.trim(),
        context: contextRef.current,
      });
      setSentId(result.id);
      setSubject('');
      setDetails('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось отправить сообщение');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {showButton ? (
        <button
          type="button"
          onClick={openForm}
          title={`Сообщить об ошибке (${BUG_REPORT_HOTKEY_LABEL})`}
          aria-label="Сообщить об ошибке"
          style={{
            position: 'fixed',
            right: 'var(--u-space-4)',
            bottom: 'var(--u-space-4)',
            zIndex: 40,
            // Малозаметная, но не меньше 44px: это цель для пальца на телефоне.
            minWidth: 44,
            minHeight: 44,
            borderRadius: 'var(--u-radius-pill)',
            border: '1px solid var(--u-border-strong)',
            background: 'var(--u-surface)',
            color: 'var(--u-text-muted)',
            fontSize: 'var(--u-text-sm)',
            cursor: 'pointer',
            opacity: 0.75,
          }}
        >
          !
        </button>
      ) : null}

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Сообщить об ошибке"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
            display: 'grid',
            placeItems: 'center',
            padding: 'var(--u-space-4)',
            background: 'rgba(0,0,0,0.45)',
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            style={{
              width: 'min(560px, 100%)',
              maxHeight: '90vh',
              overflowY: 'auto',
              background: 'var(--u-surface)',
              border: '1px solid var(--u-border)',
              borderRadius: 'var(--u-radius-lg, 12px)',
              padding: 'var(--u-space-5)',
            }}
          >
            {sentId ? (
              <Stack gap="var(--u-space-4)">
                <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Сообщение принято</h2>
                <p style={{ margin: 0, color: 'var(--u-text-muted)' }}>
                  Обращение сохранено и отправлено в поддержку. Номер:{' '}
                  <code>{sentId.slice(0, 8)}</code>. Ответ придёт в разделе «Поддержка».
                </p>
                <Button onClick={() => setOpen(false)}>Закрыть</Button>
              </Stack>
            ) : (
              <form onSubmit={submit}>
                <Stack gap="var(--u-space-4)">
                  <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Сообщить об ошибке</h2>
                  <p
                    style={{
                      margin: 0,
                      color: 'var(--u-text-muted)',
                      fontSize: 'var(--u-text-sm)',
                    }}
                  >
                    Адрес страницы, браузер, время и версия сборки приложатся сами — переписывать их
                    не нужно. Пароли, токены и cookie не собираются.
                  </p>

                  <Field label="Что произошло" htmlFor="bug-subject" error={error}>
                    <Input
                      id="bug-subject"
                      // autoFocus, а не ref: примитив `Input` — обычная
                      // функция без forwardRef, и ref до элемента не дошёл бы.
                      autoFocus
                      required
                      minLength={3}
                      maxLength={200}
                      value={subject}
                      onChange={(event) => setSubject(event.target.value)}
                      placeholder="Например: карточка проекта не открывается"
                    />
                  </Field>

                  <Field
                    label="Подробности"
                    htmlFor="bug-details"
                    hint="Необязательно. Что делали до ошибки, что ожидали увидеть."
                  >
                    <textarea
                      id="bug-details"
                      rows={5}
                      maxLength={5000}
                      value={details}
                      onChange={(event) => setDetails(event.target.value)}
                      style={{
                        padding: 'var(--u-space-3)',
                        borderRadius: 'var(--u-radius-md)',
                        border: '1px solid var(--u-border-strong)',
                        background: 'var(--u-surface)',
                        color: 'var(--u-text)',
                        fontSize: 'var(--u-text-md)',
                        fontFamily: 'inherit',
                        width: '100%',
                        resize: 'vertical',
                      }}
                    />
                  </Field>

                  <div style={{ display: 'flex', gap: 'var(--u-space-3)', flexWrap: 'wrap' }}>
                    <Button
                      type="submit"
                      loading={busy}
                      disabled={busy || subject.trim().length < 3}
                    >
                      Отправить
                    </Button>
                    <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                      Отмена
                    </Button>
                  </div>

                  <details>
                    <summary
                      style={{
                        cursor: 'pointer',
                        fontSize: 'var(--u-text-sm)',
                        color: 'var(--u-text-muted)',
                      }}
                    >
                      Что будет отправлено вместе с сообщением
                    </summary>
                    <pre
                      style={{
                        margin: 'var(--u-space-2) 0 0',
                        padding: 'var(--u-space-3)',
                        background: 'var(--u-bg, transparent)',
                        border: '1px solid var(--u-border)',
                        borderRadius: 'var(--u-radius-md)',
                        fontSize: 'var(--u-text-xs)',
                        overflowX: 'auto',
                      }}
                    >
                      {JSON.stringify(contextRef.current, null, 2)}
                    </pre>
                  </details>
                </Stack>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
