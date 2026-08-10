import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { AdminPlan, PlanCode, PublishPlanRequest } from '@unicorn/contracts';
import { ApiError, api } from '../api';
import { FeatureEditor } from '../components/FeatureEditor';
import { formatDate, formatMoney, problemText } from '../lib/format';

/**
 * Тарифы.
 *
 * Экран построен вокруг одного правила: **цена не редактируется, цена
 * объявляется**. Администратор задаёт новую цену и дату, с которой она
 * начинает действовать; до этой даты продаётся прежняя. Версия, которая уже
 * вступила в силу, доступна только для чтения — под ней кто-то подписался, и
 * её условия являются историческим фактом.
 *
 * Поэтому у действующей версии нет кнопки «изменить»: есть «объявить новую
 * цену» и «снять с продажи». Это не ограничение интерфейса, а отражение того,
 * что разрешает база данных.
 */

const PLAN_CODES: PlanCode[] = [
  'founder_t1',
  'founder_t2',
  'founder_t3',
  'founder_t4',
  'founder_t5',
  'investor_membership',
];

export function PlansPage() {
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ mode: 'publish' | 'draft'; plan?: AdminPlan } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      setPlans(await api.plans());
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить тарифы'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => groupByCode(plans ?? []), [plans]);

  async function act(action: () => Promise<unknown>, successText: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successText);
      await load();
    } catch (err) {
      setError(problemText(err, 'Операция не выполнена'));
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Тарифы</h1>
          <p className="page-hint">
            Изменение цены — это публикация новой версии тарифа с датой вступления в силу. Например,
            «с 1-го числа следующего месяца». Прежняя версия закрывается ровно этим моментом и
            остаётся в истории: переписать цену, под которой уже подписались, нельзя ни здесь, ни
            напрямую в базе. Подписки, оформленные раньше, продолжают действовать по своей цене.
          </p>
        </div>
        <button type="button" onClick={() => setEditing({ mode: 'publish' })}>
          Объявить изменение
        </button>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      {editing && (
        <PlanForm
          mode={editing.mode}
          plan={editing.plan}
          onCancel={() => setEditing(null)}
          onDone={async (text) => {
            setEditing(null);
            setNotice(text);
            await load();
          }}
          onError={setError}
        />
      )}

      {plans === null && <div className="spinner">Загрузка…</div>}

      {plans !== null &&
        grouped.map(([code, versions]) => {
          const current = versions.find((p) => p.isActive) ?? null;
          const scheduled = versions.find((p) => !p.isLocked) ?? null;
          return (
            <section className="card" key={code}>
              <div className="page-head" style={{ marginBottom: 12 }}>
                <div>
                  <h2 style={{ marginBottom: 2 }}>{current?.name ?? versions[0]?.name ?? code}</h2>
                  <div className="small muted">
                    {code} · {versions[0]?.audience === 'founder' ? 'основатели' : 'инвесторы'}
                  </div>
                </div>
                <div className="row-actions">
                  {current && (
                    <button
                      type="button"
                      className="btn--danger btn--sm"
                      onClick={() => {
                        const reason = window.prompt(
                          'Причина снятия тарифа с продажи (попадёт в журнал):',
                        );
                        if (!reason) return;
                        void act(
                          () => api.closePlan(current.id, { reason }),
                          'Тариф снят с продажи. Действующие подписки продолжают работать.',
                        );
                      }}
                    >
                      Снять с продажи
                    </button>
                  )}
                </div>
              </div>

              {scheduled && (
                <div className="alert alert--info">
                  Объявлено изменение с {formatDate(scheduled.validFrom)}:{' '}
                  <strong>{formatMoney(scheduled.price)}</strong>
                  {scheduled.individualPricing && ' (индивидуальная цена)'}. До этой даты действует
                  текущая цена.
                  <div className="row-actions" style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="btn--ghost btn--sm"
                      onClick={() => setEditing({ mode: 'draft', plan: scheduled })}
                    >
                      Изменить объявление
                    </button>
                    <button
                      type="button"
                      className="btn--danger btn--sm"
                      onClick={() =>
                        void act(
                          () => api.cancelScheduledPlan(scheduled.id),
                          'Объявление отменено, действует прежняя цена.',
                        )
                      }
                    >
                      Отменить объявление
                    </button>
                  </div>
                </div>
              )}

              <table>
                <thead>
                  <tr>
                    <th>Версия</th>
                    <th>Цена</th>
                    <th>Лимит запроса</th>
                    <th>Действует</th>
                    <th>Подписок</th>
                    <th>Состояние</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((plan) => (
                    <tr key={plan.id}>
                      <td>v{plan.version}</td>
                      <td className="num">
                        {plan.individualPricing ? (
                          <span className="muted">индивидуально</span>
                        ) : (
                          formatMoney(plan.price)
                        )}
                      </td>
                      <td className="num">
                        {plan.askLimit ? (
                          formatMoney(plan.askLimit)
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="small">
                        {formatDate(plan.validFrom)} —{' '}
                        {plan.validTo ? formatDate(plan.validTo) : 'бессрочно'}
                      </td>
                      <td className="num">{plan.subscriptionsCount}</td>
                      <td>
                        <PlanState plan={plan} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {current && Object.keys(current.features).length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div className="small muted" style={{ marginBottom: 6 }}>
                    Что входит в подписку сейчас
                  </div>
                  <FeatureList features={current.features} />
                </div>
              )}
            </section>
          );
        })}

      {plans !== null && plans.length === 0 && (
        <div className="card empty">Тарифов пока нет. Опубликуйте первую версию.</div>
      )}
    </>
  );
}

function PlanState({ plan }: { plan: AdminPlan }) {
  if (plan.isActive) return <span className="badge badge--ok">действует</span>;
  if (!plan.isLocked) return <span className="badge badge--warn">объявлена</span>;
  return <span className="badge badge--muted">закрыта</span>;
}

function FeatureList({ features }: { features: Record<string, unknown> }) {
  const included = Array.isArray(features.included) ? (features.included as unknown[]) : [];
  const rest = Object.entries(features).filter(([key]) => key !== 'included');
  return (
    <>
      {included.length > 0 && (
        <ul style={{ margin: '0 0 8px', paddingLeft: 20 }}>
          {included.map((item, index) => (
            <li key={index} className="small">
              {String(item)}
            </li>
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <div className="small muted">
          {rest.map(([key, value]) => `${key}: ${String(value)}`).join(' · ')}
        </div>
      )}
    </>
  );
}

/** Форма публикации новой версии либо правки ещё не вступившего в силу объявления. */
function PlanForm({
  mode,
  plan,
  onCancel,
  onDone,
  onError,
}: {
  mode: 'publish' | 'draft';
  plan?: AdminPlan;
  onCancel: () => void;
  onDone: (message: string) => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [code, setCode] = useState<PlanCode>(plan?.code ?? 'founder_t1');
  const [audience, setAudience] = useState<'founder' | 'investor'>(plan?.audience ?? 'founder');
  const [name, setName] = useState(plan?.name ?? '');
  const [price, setPrice] = useState(plan?.price ?? '');
  const [askLimit, setAskLimit] = useState(plan?.askLimit ?? '');
  const [individual, setIndividual] = useState(plan?.individualPricing ?? false);
  const [validFrom, setValidFrom] = useState(
    plan ? toLocalInput(plan.validFrom) : toLocalInput(firstDayOfNextMonth().toISOString()),
  );
  const [features, setFeatures] = useState<Record<string, unknown>>(plan?.features ?? {});
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (mode === 'draft' && plan) {
        await api.updateDraftPlan(plan.id, {
          name,
          price: individual ? null : price,
          askLimit: askLimit === '' ? null : askLimit,
          features,
          validFrom: new Date(validFrom).toISOString(),
        });
        await onDone('Объявление обновлено.');
        return;
      }

      const body: PublishPlanRequest = {
        code,
        audience,
        name,
        individualPricing: individual,
        billingPeriod: 'monthly',
        features,
        validFrom: new Date(validFrom).toISOString(),
        ...(individual ? {} : { price }),
        ...(askLimit === '' ? {} : { askLimit }),
      } as PublishPlanRequest;

      await api.publishPlan(body);
      await onDone(
        new Date(validFrom).getTime() > Date.now()
          ? `Изменение объявлено. Новая цена начнёт действовать ${formatDate(new Date(validFrom).toISOString())}.`
          : 'Новая версия тарифа опубликована и действует с этого момента.',
      );
    } catch (err) {
      onError(problemText(err, 'Не удалось сохранить тариф'));
      if (err instanceof ApiError && err.status === 409) onCancel();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{mode === 'draft' ? 'Изменение объявления' : 'Новая версия тарифа'}</h2>
      <p className="page-hint" style={{ marginBottom: 16 }}>
        {mode === 'draft'
          ? 'Объявление ещё не вступило в силу, поэтому его можно править свободно.'
          : 'Укажите дату, с которой начинает действовать новая цена. Прежняя версия закроется ровно в этот момент.'}
      </p>

      <div className="grid-3">
        <div className="field">
          <label htmlFor="code">Тариф</label>
          <select
            id="code"
            value={code}
            disabled={mode === 'draft'}
            onChange={(e) => {
              const next = e.target.value as PlanCode;
              setCode(next);
              setAudience(next === 'investor_membership' ? 'investor' : 'founder');
            }}
          >
            {PLAN_CODES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="price">Цена, ₽/мес</label>
          <input
            id="price"
            inputMode="decimal"
            value={individual ? '' : price}
            disabled={individual}
            placeholder="9990.00"
            onChange={(e) => setPrice(e.target.value)}
          />
          <div className="field__hint">
            <label className="switch" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={individual}
                onChange={(e) => setIndividual(e.target.checked)}
              />
              Индивидуальная цена (согласуется с каждым клиентом)
            </label>
          </div>
        </div>

        <div className="field">
          <label htmlFor="askLimit">Лимит запроса инвестиций, ₽</label>
          <input
            id="askLimit"
            inputMode="decimal"
            value={askLimit ?? ''}
            placeholder="10000000.00"
            onChange={(e) => setAskLimit(e.target.value)}
          />
          <div className="field__hint">Пусто — без ограничения сверху.</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="name">Название для витрины</label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Рост — запрос до 10 млн ₽"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="validFrom">Действует с</label>
          <input
            id="validFrom"
            type="datetime-local"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
            required
          />
          <div className="field__hint">
            По умолчанию — 1-е число следующего месяца. Прошедшую дату сервер не примет.
          </div>
        </div>
      </div>

      <div className="field">
        <label>Наполнение подписки</label>
        <FeatureEditor value={features} onChange={setFeatures} />
      </div>

      <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="submit" disabled={busy}>
          {busy ? 'Сохраняем…' : mode === 'draft' ? 'Сохранить объявление' : 'Объявить'}
        </button>
        <button type="button" className="btn--ghost" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}

function groupByCode(plans: AdminPlan[]): [string, AdminPlan[]][] {
  const map = new Map<string, AdminPlan[]>();
  for (const plan of plans) {
    const list = map.get(plan.code) ?? [];
    list.push(plan);
    map.set(plan.code, list);
  }
  for (const list of map.values()) list.sort((a, b) => b.version - a.version);
  return [...map.entries()];
}

/** Значение для `datetime-local`: браузер работает в локальной зоне, не в UTC. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function firstDayOfNextMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
}
