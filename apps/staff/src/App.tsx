import { useEffect, useState } from 'react';
import { Card, Container, Stack, UI_KEYFRAMES } from '@unicorn/ui';
import { TestContextBanner } from '@unicorn/cabinet';
import type { CurrentUser } from '@unicorn/contracts';
import { api, testContextId, testContextPort } from './api';

/**
 * Кабинет сотрудника.
 *
 * ЗАЧЕМ ОН ЕСТЬ УЖЕ СЕЙЧАС, ПУСТОЙ. У администратора две разные жизни на
 * платформе: служебная — админка, где он распоряжается чужими записями, и
 * обычная — его собственная учётная запись. Пока второй жизни негде было
 * происходить, «посмотреть кабинет администратора» означало «открыть
 * админку», то есть посмотреть не на человека, а на инструмент.
 *
 * Поэтому кабинет заведён отдельным адресом (`/staff/`) с заглушкой: место
 * есть, содержимое появится. Это честнее, чем показывать администратора
 * через админку и чем прятать действие вовсе.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО. Ни одной служебной возможности: это кабинет
 * ЧЕЛОВЕКА, а не роли. Административные экраны живут в админке и остаются
 * там.
 */
export default function App() {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.auth
      .me()
      .then((value) => {
        if (alive) setMe(value);
      })
      .catch(() => {
        // Кабинет — заглушка, и обрушивать её из-за неудачного запроса не за
        // чем: имя человека здесь украшение, а не смысл.
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <style>{UI_KEYFRAMES}</style>
      <TestContextBanner
        port={testContextPort}
        contextId={testContextId}
        subjectName={me?.displayName ?? null}
      />
      <Container>
        <Stack gap="var(--u-space-5)">
          <div data-page="staff-cabinet">
            <h1>Кабинет сотрудника</h1>
            <p style={{ color: 'var(--u-text-muted)' }}>
              {me?.displayName
                ? `${me.displayName} — личное пространство, а не админка.`
                : failed
                  ? 'Личное пространство сотрудника, а не админка.'
                  : 'Загружаю…'}
            </p>
          </div>

          <Card>
            <Stack>
              <h2 data-staff-placeholder>Раздел ещё не наполнен</h2>
              <p>
                Здесь появится то, что касается вас как человека, а не как администратора: профиль,
                уведомления, обращения в поддержку, история действий. Пока этого нет — и страница
                говорит об этом прямо, вместо того чтобы изображать работу.
              </p>
              <p style={{ color: 'var(--u-text-muted)' }}>
                Служебные экраны — распоряжение пользователями, тарифы, комиссии, тексты — живут в
                админке и останутся там: это разные вещи, и смешивать их не нужно.
              </p>
            </Stack>
          </Card>
        </Stack>
      </Container>
    </>
  );
}
