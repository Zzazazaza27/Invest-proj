import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Container,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  NovaTopBar,
  OfflineBanner,
  Stack,
  TrustStrip,
  UI_KEYFRAMES,
} from '@unicorn/ui';
import type {
  CreateSupportTicketRequest,
  CurrentUser,
  ProjectFull,
  SupportTicketStatus,
} from '@unicorn/contracts';
import { api, setCsrf, testContextId, testContextPort } from './api';
import {
  BugReportWidget,
  BusinessEntitiesCard,
  NotificationsCard,
  SessionCheckFailed,
  SupportCard,
  useScrollToTopOnChange,
  ProfileLink,
  ProfilePage,
  type ProfilePort,
  VerificationCard,
  decideAccess,
  hrefFor,
  useSessionCheck,
  TestContextBanner,
} from '@unicorn/cabinet';
import type {
  AddEntityMemberRequest,
  CreateEntityRequest,
  NotificationPreference,
} from '@unicorn/contracts';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProjectPage } from './pages/ProjectPage';
import { WizardPage } from './wizard/WizardPage';
import { GlossaryPage } from './pages/GlossaryPage';

/**
 * Кабинет основателя.
 *
 * Что показать, решает сервер: фронтенд лишь отражает его ответы. Спрятанная
 * кнопка не является защитой — любая операция всё равно проверяется ролью и
 * политикой БД на бэкенде, поэтому здесь нет ни одной проверки прав «на
 * всякий случай».
 *
 * Мастер заявки (этап 4) включается флагом `lab.ui.application_v2` из
 * публичного `GET /features`: при выключенном флаге кабинет v1 работает как
 * прежде, при включённом на странице проекта появляются заявки и мастер.
 * Обе ветки бьют в одно ядро (план 0.2 §2.15).
 */
/**
 * Транспорт для общих блоков кабинета.
 *
 * Пакет `@unicorn/cabinet` намеренно не знает про HTTP: сюда передаются три
 * функции, и граница «в сеть — только через свой клиент» видна в сигнатуре.
 */
const notificationsPort = {
  list: (limit: number) => api.notifications.list({ limit }),
  preferences: () => api.notifications.preferences(),
  savePreferences: (items: NotificationPreference[]) => api.notifications.updatePreferences(items),
};

/**
 * Транспорт для карточки юрлиц. Тот же приём, что и у уведомлений: пакет не
 * знает про HTTP, а кабинет остаётся при своём клиенте.
 */
const entitiesPort = {
  list: () => api.kyc.entities(),
  create: (body: CreateEntityRequest) => api.kyc.createEntity(body),
  addMember: (entityId: string, body: AddEntityMemberRequest) => api.kyc.addMember(entityId, body),
  startKyb: (entityId: string, kind: 'registry_check' | 'beneficial_owners') =>
    api.kyc.startKyb(entityId, kind),
};

/**
 * Транспорт верификации личности.
 *
 * Публикация листинга требует действующей проверки, и сервер отвечает отказом
 * «Требуется пройти верификацию». До появления этой карточки основателю некуда
 * было пойти по такому отказу: экран проверки был только у инвестора.
 */
const verificationPort = {
  status: () => api.kyc.status(),
  start: (body: {
    kind: 'identity' | 'investor_status' | 'accredited';
    docType: 'passport' | 'foreign_passport' | 'id_card' | 'driver_license';
    docCountry: string;
  }) => api.kyc.start(body),
};

/**
 * Транспорт поддержки и сообщений об ошибках.
 *
 * Тот же приём, что у уведомлений: общий пакет кабинетов не знает про HTTP, а
 * кабинет остаётся при своём клиенте и своей схеме аутентификации.
 */
const supportPort = {
  list: () => api.support.list(),
  detail: (id: string) => api.support.detail(id),
  open: (input: { subject: string; body: string }) =>
    api.support.open({ kind: 'support' as const, ...input }),
  reply: (id: string, body: string) => api.support.reply(id, body),
  update: (id: string, input: { status?: SupportTicketStatus; assignToMe?: boolean }) =>
    api.support.update(id, input),
};

/**
 * Версия сборки, подставленная Vite (`define`). Объявляется здесь, потому что
 * в браузере такой переменной нет — она заменяется значением при сборке.
 */
declare const __APP_VERSION__: string;

/**
 * Порты приложений стенда, подставленные Vite. Нужны только при прямом запуске
 * dev-сервером: за единой точкой входа переход идёт по пути, без портов.
 */
declare const __CABINET_PORTS__: Partial<
  Record<'lab' | 'investor' | 'expert' | 'admin' | 'login', number>
>;

/** Сообщение об ошибке уходит тем же маршрутом — различает их вид обращения. */
const bugReportPort = {
  open: (input: CreateSupportTicketRequest) => api.support.open(input),
};

/**
 * Адрес профиля внутри этого кабинета.
 *
 * Базовый путь приходит из сборки: за единой точкой входа кабинет живёт под
 * своим префиксом, при запуске dev-сервером — в корне. Зашитая строка сломала
 * бы один из двух режимов.
 */
const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, '');
function profileHref(): string {
  return `${BASE_PATH}/profile`;
}

/**
 * «Мой профиль»: имя, аватар и пароль. Экран общий для всех кабинетов
 * (`@unicorn/cabinet`), сюда приходит только транспорт.
 */
const profilePort: ProfilePort = {
  load: () => api.profile.me(),
  updateName: (displayName) => api.profile.updateName(displayName),
  uploadAvatar: (file) => api.profile.uploadAvatar(file),
  removeAvatar: () => api.profile.removeAvatar(),
  changePassword: async (input) => {
    await api.profile.changePassword(input);
  },
};

export default function App() {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [applicationV2, setApplicationV2] = useState(false);
  const navigate = useNavigate();
  useScrollToTopOnChange(useLocation().pathname);

  // Проверка сессии различает подтверждённое «сессии нет» (401) и временную
  // неудачу проверки (429, 5xx, обрыв связи). Раньше второе показывалось как
  // первое: страница кабинета без содержимого, то есть вид вышедшего
  // пользователя. Cookie при этом никуда не девалась.
  const { checking, failure, retry } = useSessionCheck(() => api.auth.me(), {
    onReady: (profile) => {
      // Кабинет открывается только своей роли. Раньше проверки не было вовсе:
      // войдя здесь инвестором, человек оставался в кабинете основателя — с
      // формой создания проекта, на которую сервер отвечал отказом.
      const decision = decideAccess(profile.roles, 'lab');
      if (decision.kind !== 'allowed') {
        const target = decision.kind === 'elsewhere' ? decision.to : 'login';
        window.location.replace(hrefFor(target, __CABINET_PORTS__));
        return false;
      }
      setMe(profile);
      return true;
    },
    // Единый вход — только по подтверждённому отсутствию сессии.
    onAbsent: () => {
      window.location.replace(hrefFor('login', __CABINET_PORTS__));
      // `false` — «уводим отсюда»: состояние проверки не снимаем, иначе на
      // месте уходящей страницы мелькнёт пустой каркас кабинета.
      return false;
    },
  });

  useEffect(() => {
    // Флаг интерфейса читается один раз при старте: переключение — без релиза,
    // но с перезагрузкой страницы, а не посреди заполнения.
    api
      .features()
      .then((features) => setApplicationV2(features.flags['lab.ui.application_v2'] === true))
      .catch(() => setApplicationV2(false));
  }, []);

  return (
    <>
      <style>{UI_KEYFRAMES}</style>
      <a className="u-skip-link" href="#content">
        Перейти к содержимому
      </a>
      <TestContextBanner
        port={testContextPort}
        contextId={testContextId}
        subjectName={me?.displayName ?? null}
      />
      <OfflineBanner />
      <Header
        me={me}
        onOpenProfile={(href) => navigate(href.replace(BASE_PATH, '') || '/')}
        onLogout={async () => {
          await api.auth.logout().catch(() => undefined);
          setCsrf(null);
          setMe(null);
          // Уводим на единый вход: своей формы у кабинета больше нет, а
          // оставлять человека на странице кабинета без сессии — показывать
          // ему пустой каркас чужого раздела.
          window.location.replace(hrefFor('login', __CABINET_PORTS__));
        }}
      />
      <main id="content">
        <Container style={{ padding: 'var(--u-space-6) var(--u-space-4)' }}>
          {checking ? <LoadingState label="Проверяем сессию" /> : null}
          {!checking && failure ? (
            <SessionCheckFailed failure={failure} onRetry={retry} busy={checking} />
          ) : null}
          {!checking && me ? (
            <Routes>
              <Route
                path="/"
                element={
                  <Stack gap="var(--u-space-6)">
                    <ProjectsPage onOpen={(id) => navigate(`/projects/${id}`)} />
                    {/*
                      Юрлицо основателю нужно раньше, чем предложение: без
                      проверенной компании выпуск закрыт. Поэтому карточка стоит в
                      списке проектов, а не прячется внутри одного из них.
                    */}
                    {/*
                      Верификация личности стоит рядом с юрлицом: оба шага
                      обязательны для публикации, и оба сервер требует до неё.
                    */}
                    <VerificationCard port={verificationPort} />
                    <BusinessEntitiesCard port={entitiesPort} />
                    <NotificationsCard port={notificationsPort} />
                    <SupportCard port={supportPort} />
                  </Stack>
                }
              />
              <Route
                path="/projects/:id"
                element={<ProjectRoute applicationV2={applicationV2} />}
              />
              <Route path="/applications/:id/*" element={<WizardPage />} />
              <Route
                path="/profile"
                element={
                  <ProfilePage
                    port={profilePort}
                    kycSlot={<VerificationCard port={verificationPort} />}
                    onProfileChanged={(next) =>
                      setMe((prev) =>
                        prev
                          ? {
                              ...prev,
                              displayName: next.displayName,
                              avatarUrl: next.avatar?.urls.sm ?? null,
                            }
                          : prev,
                      )
                    }
                    onPasswordChanged={() => {
                      // Сессии закрыты все, включая эту: держать человека на
                      // экране, который через секунду ответит 401, нечестно.
                      setCsrf(null);
                      window.location.replace(hrefFor('login', __CABINET_PORTS__));
                    }}
                  />
                }
              />
              <Route path="/glossary" element={<GlossaryPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          ) : null}
          {me ? (
            <div
              style={{
                marginTop: 'var(--u-space-7)',
                paddingTop: 'var(--u-space-5)',
                borderTop: '1px solid var(--u-border)',
              }}
            >
              <TrustStrip items={TRUST_ITEMS} />
            </div>
          ) : null}
        </Container>
      </main>
      {/*
        Форма сообщения об ошибке доступна везде, а не на отдельной странице:
        о проблеме сообщают там, где её увидели.
      */}
      {me ? <BugReportWidget port={bugReportPort} appVersion={__APP_VERSION__} /> : null}
    </>
  );
}

function ProjectRoute({ applicationV2 }: { applicationV2: boolean }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  return (
    <ProjectPage
      projectId={id}
      onBack={() => navigate('/')}
      applicationV2={applicationV2}
      onOpenApplication={(applicationId) => navigate(`/applications/${applicationId}`)}
      onOpenRound={(applicationId) => navigate(`/applications/${applicationId}/round`)}
    />
  );
}

function Header({
  me,
  onLogout,
  onOpenProfile,
}: {
  me: CurrentUser | null;
  onLogout: () => void;
  onOpenProfile: (href: string) => void;
}) {
  return (
    <NovaTopBar
      title="Пятый элемент"
      subtitle="Кабинет основателя"
      icon="rocket"
      actions={
        me ? (
          <>
            {/*
              Имя и аватар — вход в профиль, а не подпись: раньше нажатие на
              собственное имя не делало ничего. Имя прячется на узком экране,
              аватар и кнопка выхода — нет: подпись это справка, а цель
              нажатия и выход терять на телефоне нельзя.
            */}
            <ProfileLink
              name={me.displayName}
              avatar={me.avatarUrl ? { urls: { sm: me.avatarUrl } } : null}
              href={profileHref()}
              onNavigate={onOpenProfile}
            />
            <Button variant="secondary" onClick={onLogout}>
              <Icon name="logout" size={16} />
              Выйти
            </Button>
          </>
        ) : null
      }
    />
  );
}

/**
 * Полоса под содержимым кабинета.
 *
 * Не украшение: три строки отвечают на вопросы, которые основатель задаёт
 * перед тем, как отдать платформе документы компании, — кто это увидит, что
 * происходит с деньгами и к кому идти, если что-то пойдёт не так.
 */
const TRUST_ITEMS = [
  {
    icon: 'shield' as const,
    title: 'Проверенные эксперты',
    description: 'Оценку дают эксперты с подтверждённой квалификацией',
  },
  {
    icon: 'lock' as const,
    title: 'Документы под шифрованием',
    description: 'Реквизиты и файлы компании доступны только вам и комплаенсу',
  },
  {
    icon: 'chat' as const,
    title: 'Ответ на обращение',
    description: 'Вопрос по заявке — через уведомления кабинета',
  },
];

/** Общие ярлыки статусов: они одинаковы во всех экранах кабинета. */
export const PROJECT_STATUS_LABEL: Record<string, string> = {
  draft: 'Черновик',
  submitted: 'Подан',
  ai_review: 'AI-анализ',
  expert_review: 'Экспертиза',
  bootcamp: 'Буткемп',
  finalist: 'Финалист',
  graduated: 'Выпускник',
  rejected: 'Отклонён',
  archived: 'В архиве',
};

export const LISTING_STATUS_LABEL: Record<string, string> = {
  not_listed: 'Не опубликован',
  listed: 'Опубликован',
  suspended_billing: 'Приостановлен по подписке',
  unlisted: 'Снят',
};

export function statusTone(status: string): 'neutral' | 'accent' | 'success' | 'warning' {
  if (status === 'graduated' || status === 'listed') return 'success';
  if (status === 'rejected' || status === 'suspended_billing') return 'warning';
  if (status === 'draft' || status === 'not_listed') return 'neutral';
  return 'accent';
}

/**
 * Значки статуса. Принимают ровно те два поля, которые показывают, — так один
 * компонент работает и с краткой формой из списка, и с полной карточкой.
 */
export function ProjectBadges({
  project,
}: {
  project: Pick<ProjectFull, 'status' | 'listingStatus'>;
}) {
  return (
    <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
      <Badge tone={statusTone(project.status)}>
        {PROJECT_STATUS_LABEL[project.status] ?? project.status}
      </Badge>
      <Badge tone={statusTone(project.listingStatus)}>
        {LISTING_STATUS_LABEL[project.listingStatus] ?? project.listingStatus}
      </Badge>
    </div>
  );
}

export { EmptyState, ErrorState };
