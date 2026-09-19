import { useCallback, useEffect, useState } from 'react';
import { Button, ErrorState, LoadingState, Stack } from '@unicorn/ui';
import { ProjectCard } from '@unicorn/cabinet';
import type { InvestorView } from '@unicorn/contracts';
import { ApiError, api, apiBaseUrl } from '../api';

/**
 * Карточка проекта глазами инвестора — Investor View (5.7.4).
 *
 * Один серверный ответ вместо трёх вызовов: состав решает предикат доступа
 * по каждому разрешению отдельно (профиль, раунд, материалы, паспорт), а
 * страница только показывает, что пришло, и честно называет закрытые блоки.
 * Ответы анкеты — согласованный владельцем снимок с эффективной видимостью;
 * поля выше уровня «инвесторам» сюда не попадают по построению.
 *
 * Сама разметка с этапа 7.3 живёт в `@unicorn/cabinet`: ту же карточку
 * показывают витрина и предпросмотр владельца. Здесь остались только вещи,
 * которых у других поверхностей нет, — загрузка инвесторской проекции, имя
 * смотрящего для водяного знака и адрес содержимого материала.
 *
 * Документы показываются ВНУТРИ платформы: файл приходит с адреса ядра, с
 * `Content-Disposition: inline` и без кнопки «скачать». Прямых ссылок на
 * хранилище страница не получает. Поверх лежит водяной знак с именем
 * смотрящего — не запрет, а ответственность.
 */
export function ProjectDetailsPage({
  projectId,
  onBack,
}: {
  projectId: string;
  onBack: () => void;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; view: InvestorView }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
  const [viewer, setViewer] = useState<string | null>(null);

  useEffect(() => {
    api.auth
      .me()
      .then((me) => setViewer(me.displayName))
      .catch(() => setViewer(null));
  }, []);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', view: await api.projects.investorView(projectId) });
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof ApiError
            ? error.status === 404
              ? 'Проект недоступен: его нет или доступ к нему закрыт'
              : (error.problem?.detail ?? error.message)
            : 'Сервис недоступен',
        traceId: error instanceof ApiError ? error.traceId : null,
      });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = (
    <Button variant="secondary" onClick={onBack} style={{ justifySelf: 'start' }}>
      ← К каталогу
    </Button>
  );

  if (state.status === 'loading') return <LoadingState label="Загружаем проект" />;
  if (state.status === 'error') {
    return (
      <Stack>
        {back}
        <ErrorState
          description={state.message}
          traceId={state.traceId}
          onRetry={() => void load()}
        />
      </Stack>
    );
  }

  return (
    <div data-investor-view>
      <ProjectCard
        surface="investor"
        source={{ kind: 'investor', view: state.view }}
        materialContentUrl={(materialId) =>
          `${apiBaseUrl}/projects/${projectId}/materials/${materialId}/content#toolbar=0&navpanes=0`
        }
        viewerLabel={viewer}
        back={back}
      />
    </div>
  );
}
