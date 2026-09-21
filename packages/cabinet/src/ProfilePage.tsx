import { useCallback, useEffect, useRef, useState } from 'react';
import { ContextualImage } from './test-context';
import { Badge, Button, Card, ErrorState, Field, Input, LoadingState, Stack } from '@unicorn/ui';
import type { MyProfile } from '@unicorn/contracts';
import { AVATAR_LIMITS } from '@unicorn/contracts';

/**
 * «Мой профиль» — один экран на все кабинеты.
 *
 * Почему общий, а не по экрану на кабинет: профиль у человека один, и
 * расхождение здесь означало бы, что основатель и инвестор по-разному меняют
 * своё же имя. Четыре копии такого экрана разошлись бы по одной за раз —
 * ровно так уже случалось с проверкой сессии и карточкой проекта.
 *
 * Границы, видимые прямо на экране:
 *
 *  * **обычное поле** (имя, аватар) меняется здесь и сразу;
 *  * **подтверждённое** (контакты, личность) показывается и подписано тем
 *    процессом, которым меняется. Формы для него здесь нет;
 *  * **пароль** меняется здесь, но со знанием текущего и с прекращением всех
 *    сессий — об этом сказано до нажатия, а не после.
 *
 * Сеть приходит портом: пакет кабинетных блоков в неё не ходит. Загрузка
 * аватара целиком за портом (билет → хранилище → подтверждение), потому что
 * середина этого пути — прямой запрос в объектное хранилище, и место ему в
 * клиенте приложения, а не здесь.
 */
export interface ProfilePort {
  load: () => Promise<MyProfile>;
  updateName: (displayName: string) => Promise<MyProfile>;
  uploadAvatar: (file: File) => Promise<MyProfile>;
  removeAvatar: () => Promise<MyProfile>;
  changePassword: (input: { currentPassword: string; newPassword: string }) => Promise<void>;
}

export function ProfilePage({
  port,
  kycSlot,
  onPasswordChanged,
  onProfileChanged,
}: {
  port: ProfilePort;
  /** Блок проверки личности кабинета: у каждого свой набор видов проверки. */
  kycSlot?: React.ReactNode;
  /** Куда уводить после смены пароля: сессии закрыты, оставаться негде. */
  onPasswordChanged: () => void;
  /**
   * Профиль изменился.
   *
   * Нужен, потому что имя и аватар стоят ещё и в шапке, а её рисует кабинет
   * по ответу «кто я», полученному при входе. Без этого человек менял имя,
   * видел новое на экране и старое над ним — и не понимал, что сохранилось.
   */
  onProfileChanged?: (profile: MyProfile) => void;
}): React.ReactElement {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProfile(await port.load());
    } catch {
      setError('Профиль не загрузился');
    } finally {
      setLoading(false);
    }
  }, [port]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !profile) return <LoadingState label="Загружаем профиль" />;
  if (error && !profile)
    return (
      <ErrorState title="Профиль недоступен" description={error} onRetry={() => void load()} />
    );
  if (!profile) return <></>;

  return (
    <Stack gap="var(--u-space-6)">
      <AvatarAndName
        profile={profile}
        port={port}
        onChange={(next) => {
          setProfile(next);
          onProfileChanged?.(next);
        }}
      />
      <MainData profile={profile} />
      {kycSlot}
      <Security profile={profile} port={port} onDone={onPasswordChanged} />
    </Stack>
  );
}

/** Аватар и имя: единственные два поля, которыми человек распоряжается сам. */
function AvatarAndName({
  profile,
  port,
  onChange,
}: {
  profile: MyProfile;
  port: ProfilePort;
  onChange: (next: MyProfile) => void;
}) {
  const [name, setName] = useState(profile.displayName);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run(action: () => Promise<MyProfile>, okText: string) {
    setBusy(true);
    setNotice(null);
    try {
      onChange(await action());
      setNotice({ tone: 'ok', text: okText });
    } catch (cause) {
      setNotice({ tone: 'error', text: messageOf(cause, 'Не удалось сохранить') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Stack gap="var(--u-space-4)">
        <strong style={{ fontSize: 'var(--u-text-lg)' }}>Профиль</strong>

        <div
          style={{
            display: 'flex',
            gap: 'var(--u-space-4)',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <ProfileAvatar profile={profile} size={72} />
          <Stack gap="var(--u-space-2)">
            <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
                data-testid="avatar-pick"
              >
                {profile.avatar ? 'Заменить аватар' : 'Загрузить аватар'}
              </Button>
              {profile.avatar ? (
                <Button
                  variant="secondary"
                  disabled={busy}
                  data-testid="avatar-remove"
                  onClick={() => void run(() => port.removeAvatar(), 'Аватар удалён')}
                >
                  Удалить
                </Button>
              ) : null}
            </div>
            <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
              JPEG, PNG или WebP, не больше {Math.round(AVATAR_LIMITS.maxBytes / (1024 * 1024))} МБ,
              сторона от {AVATAR_LIMITS.minWidth} точек.
            </span>
          </Stack>
          {/*
            Поле файла скрыто, но существует: своя кнопка выглядит как часть
            кабинета, а системная — как чужая. Проверка формата и размера всё
            равно на сервере, здесь только подсказка.
          */}
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            data-testid="avatar-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void run(() => port.uploadAvatar(file), 'Аватар обновлён');
            }}
          />
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => port.updateName(name.trim()), 'Имя сохранено');
          }}
        >
          <Field label="Отображаемое имя" htmlFor="profile-name" hint="Его видят на платформе">
            <Input
              id="profile-name"
              value={name}
              data-testid="profile-name"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            disabled={busy || name.trim().length < 2 || name.trim() === profile.displayName}
          >
            Сохранить имя
          </Button>
        </form>

        {notice ? (
          <span
            role="status"
            data-testid="profile-notice"
            style={{ color: notice.tone === 'ok' ? 'var(--u-success)' : 'var(--u-danger)' }}
          >
            {notice.text}
          </span>
        ) : null}
      </Stack>
    </Card>
  );
}

/**
 * Основные данные.
 *
 * Здесь нет ни одного поля ввода, и это главное свойство блока: контакт и
 * страна обслуживания меняются не «правкой профиля», а своими процессами.
 * Рядом с каждым сказано каким — иначе человек ищет кнопку, которой нет.
 */
function MainData({ profile }: { profile: MyProfile }) {
  return (
    <Card>
      <Stack gap="var(--u-space-3)">
        <strong style={{ fontSize: 'var(--u-text-lg)' }}>Основные данные</strong>
        <dl style={{ margin: 0, display: 'grid', gap: 'var(--u-space-2)' }}>
          <DataRow
            label="Электронная почта"
            value={profile.emailMasked ?? 'не указана'}
            note="Адрес показан частично и меняется отдельной процедурой подтверждения."
          />
          <DataRow
            label="Телефон"
            value={profile.phoneMasked ?? 'не указан'}
            note="Меняется подтверждением номера, а не правкой профиля."
          />
          <DataRow
            label="Роли"
            value={profile.roles.length > 0 ? profile.roles.join(', ') : 'нет'}
            note="Роли выдаёт администратор."
          />
          <DataRow
            label="Страна обслуживания"
            value={profile.serviceCountry ?? 'не выбрана'}
            note="Выбирается один раз: смены страны обслуживания нет."
          />
          <DataRow label="Язык интерфейса" value={profile.locale} />
          <DataRow
            label="На платформе с"
            value={new Date(profile.createdAt).toLocaleDateString('ru-RU')}
          />
        </dl>
        <div>
          <Badge tone={profile.status === 'active' ? 'success' : 'warning'}>
            {STATUS_LABEL[profile.status] ?? profile.status}
          </Badge>
        </div>
      </Stack>
    </Card>
  );
}

function DataRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>{label}</dt>
      <dd style={{ margin: 0 }}>
        {value}
        {note ? (
          <div style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-xs)' }}>{note}</div>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * Безопасность: смена пароля.
 *
 * Предупреждение о закрытии сессий стоит ДО кнопки, а не в ответе: человек
 * должен знать, что произойдёт, прежде чем это произойдёт.
 */
function Security({
  profile,
  port,
  onDone,
}: {
  profile: MyProfile;
  port: ProfilePort;
  onDone: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!profile.passwordChangeAvailable) {
    return (
      <Card>
        <Stack gap="var(--u-space-2)">
          <strong style={{ fontSize: 'var(--u-text-lg)' }}>Безопасность</strong>
          <span style={{ color: 'var(--u-text-muted)' }}>
            Вход в этот контур платформы выполняется через внешнего поставщика, и пароль хранится у
            него — менять его нужно там же.
          </span>
        </Stack>
      </Card>
    );
  }

  const mismatch = repeat.length > 0 && repeat !== next;

  return (
    <Card>
      <Stack gap="var(--u-space-3)">
        <strong style={{ fontSize: 'var(--u-text-lg)' }}>Безопасность</strong>
        <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
          После смены пароля все сессии закроются — на этом устройстве тоже. Войти нужно будет
          заново, уже новым паролем.
        </span>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            void port
              .changePassword({ currentPassword: current, newPassword: next })
              .then(() => onDone())
              .catch((cause: unknown) => setError(messageOf(cause, 'Пароль не изменён')))
              .finally(() => setBusy(false));
          }}
        >
          <Field label="Текущий пароль" htmlFor="pwd-current">
            <Input
              id="pwd-current"
              type="password"
              autoComplete="current-password"
              value={current}
              data-testid="pwd-current"
              onChange={(event) => setCurrent(event.target.value)}
            />
          </Field>
          <Field label="Новый пароль" htmlFor="pwd-new" hint="Не короче 12 символов">
            <Input
              id="pwd-new"
              type="password"
              autoComplete="new-password"
              value={next}
              data-testid="pwd-new"
              onChange={(event) => setNext(event.target.value)}
            />
          </Field>
          <Field
            label="Новый пароль ещё раз"
            htmlFor="pwd-repeat"
            error={mismatch ? 'Пароли не совпадают' : undefined}
          >
            <Input
              id="pwd-repeat"
              type="password"
              autoComplete="new-password"
              value={repeat}
              data-testid="pwd-repeat"
              onChange={(event) => setRepeat(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            loading={busy}
            data-testid="pwd-submit"
            disabled={
              busy || current.length === 0 || next.length < 12 || mismatch || repeat !== next
            }
          >
            Сменить пароль
          </Button>
        </form>
        {error ? (
          <span role="alert" data-testid="pwd-error" style={{ color: 'var(--u-danger)' }}>
            {error}
          </span>
        ) : null}
      </Stack>
    </Card>
  );
}

/**
 * Аватар человека или его замена.
 *
 * Замена — первая буква имени, а не безликая плитка: в шапке и в списках
 * одинаковые заглушки не помогают отличить людей друг от друга.
 */
export function ProfileAvatar({
  profile,
  size = 32,
}: {
  profile: { displayName: string; avatar?: { urls: Partial<Record<'sm' | 'md', string>> } | null };
  size?: number;
}): React.ReactElement {
  const url = size > 48 ? profile.avatar?.urls?.md : profile.avatar?.urls?.sm;
  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    objectFit: 'cover',
  };
  // Через ContextualImage: в тестовой вкладке картинка обязана прийти в том
  // же контексте, что и данные, иначе её заберёт административная сессия.
  if (url) return <ContextualImage src={url} alt="" style={base} data-testid="profile-avatar" />;
  return (
    <span
      aria-hidden="true"
      data-testid="profile-avatar-letter"
      style={{
        ...base,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--u-accent-subtle)',
        color: 'var(--u-accent)',
        fontWeight: 700,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {profile.displayName.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/**
 * Имя и аватар в шапке — вход в профиль.
 *
 * Раньше это была подпись: человек нажимал на своё имя и не получал ничего.
 * Теперь это ссылка, а «Выйти» остаётся отдельной кнопкой рядом — смешивать
 * «посмотреть себя» и «закончить работу» в одном меню нельзя, слишком разная
 * цена случайного нажатия.
 *
 * Имя прячется на узком экране, аватар — нет: он и есть цель нажатия, а
 * подпись к нему — справка.
 */
export function ProfileLink({
  name,
  avatar,
  href,
  onNavigate,
}: {
  name: string;
  avatar?: { urls: Partial<Record<'sm' | 'md', string>> } | null;
  href: string;
  /** Переход внутри приложения. Без него ссылка работает обычной перезагрузкой. */
  onNavigate?: (href: string) => void;
}): React.ReactElement {
  return (
    <a
      href={href}
      data-testid="profile-link"
      title="Мой профиль"
      onClick={(event) => {
        if (!onNavigate) return;
        // Служебные нажатия (в новой вкладке, с зажатым Ctrl) остаются
        // браузерными: перехватывать их значило бы ломать привычное.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onNavigate(href);
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--u-space-2)',
        color: 'var(--u-text-muted)',
        fontSize: 'var(--u-text-sm)',
        textDecoration: 'none',
        borderRadius: 999,
        padding: '2px 6px 2px 2px',
      }}
    >
      <ProfileAvatar profile={{ displayName: name, avatar }} size={32} />
      <span className="u-hide-narrow">{name}</span>
    </a>
  );
}

const STATUS_LABEL: Record<string, string> = {
  pending_consents: 'ждёт акцептов',
  active: 'активен',
  suspended: 'заблокирован',
  deleted: 'удалён',
};

/**
 * Сообщение сервера, если оно есть; иначе общее.
 *
 * Разбор по полям идёт ПЕРВЫМ: у отказа валидации `detail` общий
 * («Проверьте правильность заполнения полей»), а настоящая причина лежит в
 * `errors[].message` — и именно она отвечает на вопрос человека «что не так».
 * Поймано прогоном: неверный текущий пароль объяснялся как «проверьте поля».
 */
function messageOf(cause: unknown, fallback: string): string {
  if (typeof cause === 'object' && cause !== null) {
    const problem = (cause as { problem?: { detail?: unknown; errors?: unknown } }).problem;
    const fields = problem?.errors;
    if (Array.isArray(fields) && fields.length > 0) {
      const messages = fields
        .map((item) => (item as { message?: unknown }).message)
        .filter((text): text is string => typeof text === 'string' && text.length > 0);
      if (messages.length > 0) return messages.join('. ');
    }
    if (problem && typeof problem.detail === 'string') return problem.detail;
    const message = (cause as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return fallback;
}
