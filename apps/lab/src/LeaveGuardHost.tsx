import { useBlocker } from 'react-router-dom';
import { LeaveDialog, shouldBlockInApp, useBeforeUnloadGuard } from '@fifth/cabinet';

/**
 * Уход со страницы в кабинете основателя (2.2/2.3): переход внутри кабинета — наш диалог,
 * закрытие и перезагрузка вкладки — запрос браузера. Признаки сообщают сами формы
 * (`useLeaveGuard`); переход с тем же адресом (смена фрагмента, поиск) не останавливается.
 */
export function LeaveGuardHost() {
  useBeforeUnloadGuard();
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      currentLocation.pathname !== nextLocation.pathname && shouldBlockInApp(),
  );
  return (
    <LeaveDialog
      open={blocker.state === 'blocked'}
      onStay={() => blocker.reset?.()}
      onLeave={() => blocker.proceed?.()}
    />
  );
}
