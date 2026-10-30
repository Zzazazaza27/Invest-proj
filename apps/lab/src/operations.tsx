import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button, Toast, ToastStack } from '@unicorn/ui';
import type { UserOperation } from '@unicorn/contracts';
import { api } from './api';

/**
 * Проверка длительных операций пользователя (блок 1, 1.5; работа 2.1-W04).
 *
 * Когда. Сразу при загрузке кабинета и при возвращении на видимую вкладку —
 * не чаще раза в минуту. Это запрос состояния, а не повтор действия.
 *
 * Что показывает. Окончательную ошибку, которой нужно действие пользователя
 * («файл не принят — загрузите другой»), — всплывающим сообщением, один раз на
 * пользователя: как только сообщение появилось на ВИДИМОЙ вкладке, сервер
 * ставит отметку, и ни обновление страницы, ни другое устройство его больше
 * не покажут. Причина при этом остаётся в карточке материалов.
 *
 * Карточка, которая сама следит за операцией, после её окончания просит
 * внеочередную проверку (`requestCheck`): итог появляется сразу, а не через
 * минуту.
 */

const MIN_CHECK_INTERVAL_MS = 60_000;

const TYPE_TITLES: Record<string, string> = {
  deck: 'Презентация',
  video: 'Видео',
  doc: 'Документ',
};

/** «Что, где и что делать» одной фразой; причина — с сервера, она адресована пользователю. */
function describe(op: UserOperation): string {
  const what = op.fileName ? `«${op.fileName}»` : (TYPE_TITLES[op.materialType] ?? 'Файл');
  const reason = (op.reason ?? 'файл не подошёл').replace(/\.$/, '');
  const action = /выберите|загрузите/i.test(reason) ? '' : ' Загрузите другой файл.';
  return `${what}, проект «${op.projectTitle}»: ${reason}.${action}`;
}

interface OperationsContextValue {
  /** Внеочередная проверка: операция на экране только что закончилась. */
  requestCheck: () => void;
}

const OperationsContext = createContext<OperationsContextValue>({ requestCheck: () => undefined });

export function useOperations(): OperationsContextValue {
  return useContext(OperationsContext);
}

export function OperationsProvider({
  children,
  onOpenProject,
}: {
  children: ReactNode;
  onOpenProject: (projectId: string) => void;
}) {
  const [notices, setNotices] = useState<UserOperation[]>([]);
  const lastCheck = useRef(0);
  const running = useRef(false);

  const check = useCallback(async (force: boolean) => {
    const now = Date.now();
    if (running.current) return;
    if (!force && now - lastCheck.current < MIN_CHECK_INTERVAL_MS) return;
    running.current = true;
    lastCheck.current = now;
    try {
      const items = await api.operations.pending();
      const fresh = items.filter((item) => item.noticePending);
      setNotices((prev) => {
        const known = new Set(prev.map((item) => item.id));
        return [...prev, ...fresh.filter((item) => !known.has(item.id))];
      });
    } catch {
      // Проверка — сервис, а не условие работы кабинета: сбой не мешает
      // странице, следующая попытка — по тому же правилу.
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    void check(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [check]);

  const close = (id: string) => setNotices((prev) => prev.filter((item) => item.id !== id));

  return (
    <OperationsContext.Provider value={{ requestCheck: () => void check(true) }}>
      {children}
      {notices.length > 0 ? (
        <ToastStack>
          {notices.map((op) => (
            <Toast
              key={op.id}
              data-toast={op.id}
              tone="danger"
              title="Файл не загружен"
              // Показ отмечается на сервере, как только сообщение появилось на
              // видимой вкладке. Ошибка отметки не прячет сообщение — оно
              // покажется ещё раз при следующей проверке, и это честнее, чем
              // потерять его.
              onShown={() => void api.operations.notice(op.kind, op.id).catch(() => undefined)}
              onClose={() => close(op.id)}
              actions={
                <>
                  <Button
                    size="sm"
                    data-toast-open={op.projectId}
                    onClick={() => {
                      close(op.id);
                      onOpenProject(op.projectId);
                    }}
                  >
                    К материалам
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => close(op.id)}>
                    Понятно
                  </Button>
                </>
              }
            >
              {describe(op)}
            </Toast>
          ))}
        </ToastStack>
      ) : null}
    </OperationsContext.Provider>
  );
}
