import { useCallback, useEffect, useState } from 'react';
import type {
  ApplicationFormConfig,
  ApplicationPolicy,
  ApplicationPolicyVersion,
  ReadinessConfig,
  ReadinessConfigVersion,
} from '@unicorn/contracts';
import { PromptDialog } from '@unicorn/ui';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Настройки инвестиционной заявки (этап 5.4, план 0.2 §2.7–§2.8).
 *
 * Два независимых блока с собственными версиями и активацией:
 *  - ограничения основателя — сколько заявок и какая сумма (это настройка,
 *    не тариф; подписка здесь не участвует);
 *  - веса готовности — вклад разделов в процент и баллы состояний. Их версия
 *    отдельна от версии вопросов: правка текста или откат анкеты весов не
 *    меняет, и наоборот (поправка владельца 2026-09-15).
 * Активация — новая версия с основанием; черновики заявок считаются по
 * новой версии, снимки поданных не пересчитываются.
 */
export function ApplicationSettingsPage() {
  const [policies, setPolicies] = useState<ApplicationPolicyVersion[] | null>(null);
  const [weights, setWeights] = useState<ReadinessConfigVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, w] = await Promise.all([
        api.applicationPolicies.list(),
        api.readinessConfigs.list(),
      ]);
      setPolicies(p);
      setWeights(w);
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить настройки заявки'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Настройки инвестиционной заявки</h1>
          <p className="page-hint">
            Ограничения основателя и веса готовности — две независимые настройки, каждая со своей
            историей версий. Изменение действует на следующее действие без релиза; поданные заявки
            не пересчитываются.
          </p>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      {policies === null || weights === null ? <div className="spinner">Загрузка…</div> : null}

      {policies !== null ? (
        <PolicyBlock
          versions={policies}
          onDone={async (text) => {
            setNotice(text);
            setError(null);
            await load();
          }}
          onError={setError}
        />
      ) : null}

      {weights !== null ? (
        <WeightsBlock
          versions={weights}
          onDone={async (text) => {
            setNotice(text);
            setError(null);
            await load();
          }}
          onError={setError}
        />
      ) : null}
    </>
  );
}

// ------------------------------------------------------------ ограничения

function PolicyBlock({
  versions,
  onDone,
  onError,
}: {
  versions: ApplicationPolicyVersion[];
  onDone: (text: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  const active = versions.find((v) => v.isActive) ?? null;
  const [form, setForm] = useState<ApplicationPolicy>(
    active?.config ?? {
      maxApplicationsPerProject: 3,
      maxApplicationsPerAccount: null,
      count: { draft: true, submitted: true, archived: false },
      maxAskPerApplication: '5000000.00',
      maxOpenAskTotalPerProject: null,
    },
  );
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (active) setForm(active.config);
  }, [active]);

  const money = (value: string | null) => (value === null || value === '' ? '' : value);

  async function activate(reason: string) {
    setBusy(true);
    try {
      const saved = await api.applicationPolicies.activate(form, reason);
      await onDone(`Политика ограничений: активна версия ${saved.version}.`);
    } catch (err) {
      onError(problemText(err, 'Политика не сохранена'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-policy>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Ограничения основателя</h2>
          <div className="small muted">
            Активна версия {active?.version ?? '—'}
            {active ? ` от ${formatDate(active.createdAt)}: ${active.reason}` : ''}
          </div>
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="policy-per-project">Заявок на проект (черновики и открытые)</label>
          <input
            id="policy-per-project"
            type="number"
            min={1}
            value={form.maxApplicationsPerProject}
            onChange={(e) =>
              setForm({ ...form, maxApplicationsPerProject: Number(e.target.value) })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="policy-per-account">Заявок на аккаунт (пусто — без лимита)</label>
          <input
            id="policy-per-account"
            type="number"
            min={1}
            value={form.maxApplicationsPerAccount ?? ''}
            onChange={(e) =>
              setForm({
                ...form,
                maxApplicationsPerAccount: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="policy-max-ask">
            Потолок суммы одной заявки, ₽ (пусто — без потолка)
          </label>
          <input
            id="policy-max-ask"
            inputMode="decimal"
            value={money(form.maxAskPerApplication)}
            onChange={(e) =>
              setForm({ ...form, maxAskPerApplication: e.target.value.trim() || null })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="policy-max-open">
            Потолок суммы открытых заявок проекта, ₽ (пусто — без потолка)
          </label>
          <input
            id="policy-max-open"
            inputMode="decimal"
            value={money(form.maxOpenAskTotalPerProject)}
            onChange={(e) =>
              setForm({ ...form, maxOpenAskTotalPerProject: e.target.value.trim() || null })
            }
          />
          <div className="field__hint">Защита от дробления одного запроса на много заявок.</div>
        </div>
      </div>
      <label className="switch">
        <input
          type="checkbox"
          checked={form.count.draft}
          onChange={(e) => setForm({ ...form, count: { ...form.count, draft: e.target.checked } })}
        />
        Черновики занимают место в лимите
      </label>
      <div className="row-actions" style={{ marginTop: 12 }}>
        <button type="button" disabled={busy} onClick={() => setConfirm(true)}>
          Активировать новой версией
        </button>
      </div>
      <History
        rows={versions.map((v) => ({
          version: v.version,
          active: v.isActive,
          at: v.createdAt,
          reason: v.reason,
          summary: `${v.config.maxApplicationsPerProject} на проект · до ${v.config.maxAskPerApplication ?? '∞'} ₽`,
        }))}
      />
      <PromptDialog
        open={confirm}
        title="Активировать политику ограничений"
        description="Новая версия действует на следующее создание и подачу заявки. Прежняя остаётся в истории."
        label="Основание"
        confirmText="Активировать"
        onCancel={() => setConfirm(false)}
        onConfirm={(reason) => {
          setConfirm(false);
          void activate(reason);
        }}
      />
    </section>
  );
}

// ------------------------------------------------------------ веса

function WeightsBlock({
  versions,
  onDone,
  onError,
}: {
  versions: ReadinessConfigVersion[];
  onDone: (text: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  const active = versions.find((v) => v.isActive) ?? null;
  const [form, setForm] = useState<ReadinessConfig>(
    active?.config ?? { sections: {}, levelPoints: { mandatory: 2, recommended: 1 } },
  );
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (active) setForm(active.config);
  }, [active]);

  async function activate(reason: string) {
    setBusy(true);
    try {
      const saved = await api.readinessConfigs.activate(form, reason);
      await onDone(`Веса готовности: активна версия ${saved.version}.`);
    } catch (err) {
      onError(problemText(err, 'Веса не сохранены'));
    } finally {
      setBusy(false);
    }
  }

  const [formConfig, setFormConfig] = useState<ApplicationFormConfig | null>(null);
  useEffect(() => {
    api.applicationForms
      .list()
      .then((list) =>
        list.activeVersion === null ? null : api.applicationForms.version(list.activeVersion),
      )
      .then((version) => setFormConfig(version?.config ?? null))
      .catch(() => setFormConfig(null));
  }, []);

  // Разделы в порядке анкеты; ключи весов, которых в анкете нет, — в конце.
  const formSections = formConfig ? [...formConfig.sections].sort((a, b) => a.order - b.order) : [];
  const orderedKeys = [
    ...formSections.map((sec) => sec.key),
    ...Object.keys(form.sections).filter((key) => !formSections.some((sec) => sec.key === key)),
  ];
  const sectionTitle = (key: string) =>
    formSections.find((sec) => sec.key === key)?.texts[formConfig?.defaultLocale ?? 'ru-RU']
      ?.title ?? null;
  const sectionKeys = orderedKeys;

  return (
    <section className="card" data-weights>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Веса готовности</h2>
          <div className="small muted">
            Активна версия {active?.version ?? '—'}
            {active ? ` от ${formatDate(active.createdAt)}: ${active.reason}` : ''}. Веса
            нормализуются; раздел без веса считается с весом 1; вес 0 исключает раздел из процента.
            Версия весов не зависит от версии вопросов.
          </div>
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="points-mandatory">Баллы за обязательный вопрос</label>
          <input
            id="points-mandatory"
            type="number"
            min={0.1}
            step={0.5}
            value={form.levelPoints.mandatory}
            onChange={(e) =>
              setForm({
                ...form,
                levelPoints: { ...form.levelPoints, mandatory: Number(e.target.value) },
              })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="points-recommended">Баллы за рекомендуемый вопрос</label>
          <input
            id="points-recommended"
            type="number"
            min={0}
            step={0.5}
            value={form.levelPoints.recommended}
            onChange={(e) =>
              setForm({
                ...form,
                levelPoints: { ...form.levelPoints, recommended: Number(e.target.value) },
              })
            }
          />
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Раздел</th>
            <th>Вес</th>
          </tr>
        </thead>
        <tbody>
          {sectionKeys.map((key) => (
            <tr key={key}>
              <td>
                {sectionTitle(key) ? <div>{sectionTitle(key)}</div> : null}
                <code className="small muted">{key}</code>
              </td>
              <td>
                <input
                  aria-label={`Вес раздела ${key}`}
                  type="number"
                  min={0}
                  step={0.5}
                  style={{ maxWidth: 120 }}
                  value={form.sections[key]?.weight ?? 1}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      sections: { ...form.sections, [key]: { weight: Number(e.target.value) } },
                    })
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-actions" style={{ marginTop: 12 }}>
        <button type="button" disabled={busy} onClick={() => setConfirm(true)}>
          Активировать новой версией
        </button>
      </div>
      <History
        rows={versions.map((v) => ({
          version: v.version,
          active: v.isActive,
          at: v.createdAt,
          reason: v.reason,
          summary: `обязательный ${v.config.levelPoints.mandatory} · рекомендуемый ${v.config.levelPoints.recommended} · разделов ${Object.keys(v.config.sections).length}`,
        }))}
      />
      <PromptDialog
        open={confirm}
        title="Активировать веса готовности"
        description="Черновики заявок начнут считаться по новым весам; поданные снимки хранят свой процент и не меняются."
        label="Основание"
        confirmText="Активировать"
        onCancel={() => setConfirm(false)}
        onConfirm={(reason) => {
          setConfirm(false);
          void activate(reason);
        }}
      />
    </section>
  );
}

function History({
  rows,
}: {
  rows: { version: number; active: boolean; at: string; reason: string; summary: string }[];
}) {
  return (
    <details style={{ marginTop: 12 }}>
      <summary className="small muted" style={{ cursor: 'pointer' }}>
        История версий ({rows.length})
      </summary>
      <table>
        <thead>
          <tr>
            <th>Версия</th>
            <th>Состояние</th>
            <th>Когда</th>
            <th>Что</th>
            <th>Основание</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.version}>
              <td>{r.version}</td>
              <td>
                <span className={`badge ${r.active ? 'badge--ok' : 'badge--muted'}`}>
                  {r.active ? 'активна' : 'в истории'}
                </span>
              </td>
              <td className="small">{formatDate(r.at)}</td>
              <td className="small">{r.summary}</td>
              <td className="small">{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
