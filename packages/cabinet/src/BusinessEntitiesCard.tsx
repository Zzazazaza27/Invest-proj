import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Stack,
} from '@unicorn/ui';
import type {
  AddEntityMemberRequest,
  BusinessEntity,
  CreateEntityRequest,
  EntityMember,
  KybVerification,
} from '@unicorn/contracts';

/**
 * Юрлица и проверка KYB.
 *
 * До этого блока юрлицо можно было завести только через служебную консоль — а
 * представлять компанию на платформе без проверенного юрлица нельзя. То есть
 * обязательный шаг существовал в API и отсутствовал в продукте.
 *
 * Блок общий (`@unicorn/cabinet`): требования к раскрытию бенефициаров у
 * основателя и инвестора одни и те же, и расходиться этим экранам нельзя —
 * расхождение здесь означает разное раскрытие для разных ролей.
 *
 * ИНН и ОГРН вводятся полностью, а обратно приходят МАСКИРОВАННЫМИ: полное
 * значение шифруется и наружу не выдаётся. Интерфейс это не «упрощает» — он
 * показывает ровно то, что отдал сервер.
 */
export interface EntitiesPort {
  list: () => Promise<BusinessEntity[]>;
  create: (body: CreateEntityRequest) => Promise<BusinessEntity>;
  addMember: (entityId: string, body: AddEntityMemberRequest) => Promise<EntityMember>;
  startKyb: (
    entityId: string,
    kind: 'registry_check' | 'beneficial_owners',
  ) => Promise<KybVerification>;
}

/**
 * Состояние проверки по реестру по-человечески.
 *
 * В карточке стояло сырое `unknown`: владелец компании видит английский код и
 * не понимает, это ошибка, отказ или просто «ещё не проверяли».
 */
const REGISTRY_STATUS_TITLES: Record<string, string> = {
  unknown: 'не проверялся',
  pending: 'проверяется',
  in_review: 'на проверке',
  found: 'найдена в реестре',
  not_found: 'в реестре не найдена',
  mismatch: 'данные расходятся с реестром',
  failed: 'проверка не удалась',
};

const MEMBER_ROLES = [
  { value: 'signatory' as const, title: 'Подписант' },
  { value: 'beneficial_owner' as const, title: 'Бенефициар' },
  { value: 'representative' as const, title: 'Представитель' },
];

export function BusinessEntitiesCard({ port }: { port: EntitiesPort }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: BusinessEntity[] }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [legalName, setLegalName] = useState('');
  const [inn, setInn] = useState('');
  const [ogrn, setOgrn] = useState('');
  const [memberFor, setMemberFor] = useState<string | null>(null);
  const [memberUserId, setMemberUserId] = useState('');
  const [memberRole, setMemberRole] = useState<AddEntityMemberRequest['memberRole']>('signatory');
  const [memberShare, setMemberShare] = useState('');

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', items: await port.list() });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Сервис недоступен',
      });
    }
  }, [port]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, action: () => Promise<unknown>, okText: string): Promise<void> {
    setBusy(key);
    setNotice(null);
    try {
      await action();
      setNotice({ tone: 'ok', text: okText });
      await load();
    } catch (error) {
      // Причину отказа объясняет сервер: он один знает и правила проверки ИНН,
      // и то, чего не хватает для KYB.
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Сервис недоступен',
      });
    } finally {
      setBusy(null);
    }
  }

  if (state.status === 'loading') return <LoadingState label="Загружаем юрлица" />;
  if (state.status === 'error') {
    return <ErrorState description={state.message} onRetry={() => void load()} />;
  }

  return (
    <Card>
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Юрлица и проверка KYB</h2>
        <span style={MUTED_STYLE}>
          Проверенное юрлицо обязательно для выпуска и для сделок от компании. Проверку проводит
          комплаенс — платформа не подтверждает её сама.
        </span>

        {notice ? (
          <div
            role={notice.tone === 'error' ? 'alert' : 'status'}
            style={{
              padding: 'var(--u-space-3) var(--u-space-4)',
              borderRadius: 'var(--u-radius-md)',
              background:
                notice.tone === 'error' ? 'var(--u-danger-subtle)' : 'var(--u-success-subtle)',
              color: notice.tone === 'error' ? 'var(--u-danger)' : 'var(--u-success)',
            }}
          >
            {notice.text}
          </div>
        ) : null}

        {state.items.length === 0 ? (
          <EmptyState
            title="Юрлиц нет"
            description="Добавьте компанию: без проверенного юрлица действовать от организации нельзя."
          />
        ) : (
          <ul style={LIST_STYLE}>
            {state.items.map((entity) => (
              <li key={entity.id} style={{ ...ROW_STYLE, display: 'block' }}>
                <div style={{ fontWeight: 600 }}>
                  {entity.legalName}{' '}
                  <Badge tone={entity.kybApproved ? 'success' : 'warning'}>
                    {entity.kybApproved ? 'KYB пройден' : 'KYB не пройден'}
                  </Badge>
                </div>
                <div style={MUTED_STYLE}>
                  ИНН {entity.innMasked} · {entity.jurisdiction} · реестр:{' '}
                  {REGISTRY_STATUS_TITLES[entity.registryStatus] ?? entity.registryStatus}
                </div>
                {/*
                  Проверка идёт не мгновенно: её проводит комплаенс, и до его
                  ответа карточка остаётся прежней. Без этой строки нажатие
                  «Проверка по реестру» выглядело как «ничего не произошло».
                */}
                {!entity.kybApproved && entity.registryStatus !== 'unknown' ? (
                  <div style={MUTED_STYLE}>
                    Проверка запрошена. Результат появится здесь после ответа комплаенса — платформа
                    не подтверждает её сама.
                  </div>
                ) : null}

                <div
                  style={{
                    display: 'flex',
                    gap: 'var(--u-space-2)',
                    marginTop: 'var(--u-space-2)',
                    flexWrap: 'wrap',
                  }}
                >
                  <Button
                    variant="secondary"
                    loading={busy === `kyb:${entity.id}`}
                    onClick={() =>
                      void run(
                        `kyb:${entity.id}`,
                        () => port.startKyb(entity.id, 'registry_check'),
                        'Проверка по реестру запрошена',
                      )
                    }
                  >
                    Проверка по реестру
                  </Button>
                  <Button
                    variant="secondary"
                    loading={busy === `owners:${entity.id}`}
                    onClick={() =>
                      void run(
                        `owners:${entity.id}`,
                        () => port.startKyb(entity.id, 'beneficial_owners'),
                        'Проверка бенефициаров запрошена',
                      )
                    }
                  >
                    Проверка бенефициаров
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setMemberFor(memberFor === entity.id ? null : entity.id)}
                  >
                    {memberFor === entity.id ? 'Скрыть участников' : 'Добавить участника'}
                  </Button>
                </div>

                {memberFor === entity.id ? (
                  <div
                    style={{
                      display: 'grid',
                      gap: 'var(--u-space-2)',
                      marginTop: 'var(--u-space-3)',
                    }}
                  >
                    {/*
                      Участник — это ПОЛЬЗОВАТЕЛЬ платформы, а не строка с именем.
                      Раскрытие бенефициаров имеет смысл только тогда, когда за
                      каждым стоит проверяемое лицо; свободный текст здесь
                      создавал бы видимость раскрытия.
                    */}
                    <Field
                      label="Идентификатор пользователя"
                      htmlFor={`member-user-${entity.id}`}
                      hint="Участник обязан быть зарегистрирован на платформе"
                    >
                      <Input
                        id={`member-user-${entity.id}`}
                        value={memberUserId}
                        onChange={(event) => setMemberUserId(event.target.value)}
                      />
                    </Field>
                    <Field label="Роль в компании" htmlFor={`member-role-${entity.id}`}>
                      <select
                        id={`member-role-${entity.id}`}
                        value={memberRole}
                        onChange={(event) =>
                          setMemberRole(event.target.value as AddEntityMemberRequest['memberRole'])
                        }
                      >
                        {MEMBER_ROLES.map((role) => (
                          <option key={role.value} value={role.value}>
                            {role.title}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field
                      label="Доля, %"
                      htmlFor={`member-share-${entity.id}`}
                      hint="Обязательна для бенефициара — это требование раскрытия, а не форма"
                    >
                      <Input
                        id={`member-share-${entity.id}`}
                        value={memberShare}
                        onChange={(event) => setMemberShare(event.target.value)}
                      />
                    </Field>
                    <Button
                      loading={busy === `member:${entity.id}`}
                      onClick={() =>
                        void run(
                          `member:${entity.id}`,
                          () =>
                            port.addMember(entity.id, {
                              userId: memberUserId.trim(),
                              memberRole,
                              sharePct: memberShare.trim() || undefined,
                            }),
                          'Участник добавлен',
                        )
                      }
                    >
                      Добавить
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <div
          style={{
            borderTop: '1px solid var(--u-border)',
            paddingTop: 'var(--u-space-3)',
            display: 'grid',
            gap: 'var(--u-space-2)',
          }}
        >
          <strong>Новое юрлицо</strong>
          <Field label="Наименование" htmlFor="entity-name">
            <Input
              id="entity-name"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
            />
          </Field>
          <Field label="ИНН" htmlFor="entity-inn" hint="10 цифр для юрлица, 12 для ИП">
            <Input id="entity-inn" value={inn} onChange={(e) => setInn(e.target.value)} />
          </Field>
          <Field label="ОГРН" htmlFor="entity-ogrn" hint="13 или 15 цифр">
            <Input id="entity-ogrn" value={ogrn} onChange={(e) => setOgrn(e.target.value)} />
          </Field>
          <Button
            loading={busy === 'create'}
            onClick={() =>
              void run(
                'create',
                async () => {
                  const created = await port.create({
                    legalName: legalName.trim(),
                    inn: inn.trim(),
                    ogrn: ogrn.trim(),
                    // Юрисдикция пока одна: платформа работает в российском
                    // контуре, и выбор из одного значения был бы лишним шагом.
                    jurisdiction: 'RU',
                  });
                  setLegalName('');
                  setInn('');
                  setOgrn('');
                  return created;
                },
                'Юрлицо добавлено',
              )
            }
          >
            Добавить юрлицо
          </Button>
        </div>
      </Stack>
    </Card>
  );
}

const LIST_STYLE = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gap: 'var(--u-space-3)',
} as const;

const ROW_STYLE = {
  borderTop: '1px solid var(--u-border)',
  paddingTop: 'var(--u-space-3)',
} as const;

const MUTED_STYLE = {
  color: 'var(--u-text-muted)',
  fontSize: 'var(--u-text-sm)',
} as const;
