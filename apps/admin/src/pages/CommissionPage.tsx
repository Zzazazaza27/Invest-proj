import { useCallback, useEffect, useState } from 'react';
import type { FeeOffsetRule, FeeTerms } from '@unicorn/contracts';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Вознаграждение платформы и зачёт услуг (этап 5.9.3, план 0.2 §0г.2 п.5).
 *
 * Ставка ОДНА и считается от одной базы; между сторонами она распределяется в
 * процентных пунктах, и доли обязаны складываться в общую ставку. Начисление
 * происходит с каждого подтверждённого транша — за неоплаченную часть
 * договора платформа ничего не берёт.
 *
 * Здесь настраиваются только условия. Начисления этим экраном не создаются и
 * не правятся: они возникают в команде подтверждения транша, и второго места,
 * где считаются те же деньги, нет.
 */
export function CommissionPage() {
  const [terms, setTerms] = useState<FeeTerms[] | null>(null);
  const [rules, setRules] = useState<FeeOffsetRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, r] = await Promise.all([api.commission.terms(), api.commission.offsetRules()]);
      setTerms(t.items);
      setRules(r.items);
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить условия вознаграждения'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const done = async (text: string) => {
    setNotice(text);
    setError(null);
    await load();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Комиссии</h1>
          <p className="page-hint">
            Вознаграждение платформы начисляется с каждого подтверждённого транша: база — сумма
            транша, а не вся сумма договора. Ставка одна и распределяется между сторонами в
            процентных пунктах.
          </p>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      {terms === null || rules === null ? (
        <div className="spinner">Загрузка…</div>
      ) : (
        <>
          <TermsBlock terms={terms} onDone={done} onError={setError} />
          <OffsetBlock rules={rules} onDone={done} onError={setError} />
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ условия

function TermsBlock({
  terms,
  onDone,
  onError,
}: {
  terms: FeeTerms[];
  onDone: (text: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  const [form, setForm] = useState({
    code: 'operator_success_fee',
    totalPct: '',
    investorFeePct: '',
    issuerFeePct: '',
    rulesVersion: 'v1',
    reason: '',
  });
  const [busy, setBusy] = useState(false);

  const shares = Number(form.investorFeePct || 0) + Number(form.issuerFeePct || 0);
  const total = Number(form.totalPct || 0);
  // Несходящиеся доли видны до отправки: сервер откажет, но объяснять это
  // ошибкой после нажатия — хуже, чем показать сумму рядом с полями.
  const mismatch =
    form.totalPct !== '' && Math.round(shares * 100) !== Math.round(total * 100)
      ? `Доли складываются в ${shares.toFixed(2)} %, а общая ставка — ${total.toFixed(2)} %`
      : null;

  async function publish() {
    setBusy(true);
    try {
      const created = await api.commission.publishTerms({
        code: form.code.trim(),
        totalPct: form.totalPct.trim(),
        investorFeePct: form.investorFeePct.trim(),
        issuerFeePct: form.issuerFeePct.trim(),
        rulesVersion: form.rulesVersion.trim(),
        reason: form.reason.trim(),
      });
      setForm((f) => ({ ...f, totalPct: '', investorFeePct: '', issuerFeePct: '', reason: '' }));
      await onDone(`Опубликована версия ${created.version} условий вознаграждения.`);
    } catch (err) {
      onError(problemText(err, 'Версия условий не опубликована'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-fee-terms>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Условия вознаграждения</h2>
          <div className="small muted">
            Изменение — новая версия: действующая не переписывается, а закрывается тем же моментом.
            Начисления, уже сделанные по прежней версии, не меняются.
          </div>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Код</th>
            <th>Версия</th>
            <th>Общая ставка</th>
            <th>Инвестор</th>
            <th>Привлекающий</th>
            <th>Действует</th>
            <th>Основание</th>
          </tr>
        </thead>
        <tbody>
          {terms.map((row) => (
            <tr key={row.id} data-terms-row={row.code} data-terms-active={row.isActive}>
              <td>{row.code}</td>
              <td>{row.version}</td>
              <td>{row.totalPct} %</td>
              <td>{row.investorFeePct} п. п.</td>
              <td>{row.issuerFeePct} п. п.</td>
              <td className="small">
                {formatDate(row.validFrom)} — {row.validTo ? formatDate(row.validTo) : 'бессрочно'}
              </td>
              <td className="small">{row.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 16 }}>Опубликовать версию</h3>
      <Field
        id="fee-code"
        label="Код условий"
        value={form.code}
        onChange={(v) => setForm((f) => ({ ...f, code: v }))}
      />
      <Field
        id="fee-total"
        label="Общая ставка, %"
        value={form.totalPct}
        onChange={(v) => setForm((f) => ({ ...f, totalPct: v }))}
      />
      <Field
        id="fee-investor"
        label="Доля инвестора, п. п."
        value={form.investorFeePct}
        onChange={(v) => setForm((f) => ({ ...f, investorFeePct: v }))}
      />
      <Field
        id="fee-issuer"
        label="Доля привлекающего, п. п."
        value={form.issuerFeePct}
        onChange={(v) => setForm((f) => ({ ...f, issuerFeePct: v }))}
      />
      <Field
        id="fee-rules"
        label="Версия правил"
        value={form.rulesVersion}
        onChange={(v) => setForm((f) => ({ ...f, rulesVersion: v }))}
      />
      <Field
        id="fee-reason"
        label="Основание"
        value={form.reason}
        onChange={(v) => setForm((f) => ({ ...f, reason: v }))}
      />
      {mismatch ? (
        <div className="alert alert--warn" data-terms-mismatch>
          {mismatch}
        </div>
      ) : null}
      <button
        type="button"
        className="btn--sm"
        disabled={
          busy ||
          mismatch !== null ||
          form.totalPct.trim() === '' ||
          form.investorFeePct.trim() === '' ||
          form.issuerFeePct.trim() === '' ||
          form.reason.trim().length < 3
        }
        onClick={() => void publish()}
      >
        Опубликовать версию
      </button>
    </section>
  );
}

// ------------------------------------------------------------------- зачёт

function OffsetBlock({
  rules,
  onDone,
  onError,
}: {
  rules: FeeOffsetRule[];
  onDone: (text: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function activate() {
    setBusy(true);
    try {
      const created = await api.commission.activateOffsetRule({
        isEnabled: false,
        reason: reason.trim(),
      });
      setReason('');
      await onDone(`Активирована версия ${created.version} правила зачёта (выключено).`);
    } catch (err) {
      onError(problemText(err, 'Версия правила не активирована'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-fee-offsets>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Зачёт оплаченных услуг</h2>
          <div className="small muted">
            Зачёт уменьшает вознаграждение на стоимость уже оплаченных услуг запуска раунда.
          </div>
        </div>
      </div>

      <div className="alert alert--warn" data-offsets-off>
        Зачёт выключен и включить его нельзя: правило расчёта не утверждено — не определены
        получатель зачёта, полное или частичное покрытие, распределение по траншам, судьба остатка и
        поведение при возвратах. Запись зачёта запрещена в базе, а не только здесь.
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Версия</th>
            <th>Состояние</th>
            <th>Активна</th>
            <th>Основание</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id} data-offset-rule={rule.version} data-offset-enabled={rule.isEnabled}>
              <td>{rule.version}</td>
              <td>{rule.isEnabled ? 'включён' : 'выключен'}</td>
              <td>{rule.isActive ? 'да' : 'нет'}</td>
              <td className="small">{rule.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 16 }}>Новая версия правила</h3>
      <Field id="offset-reason" label="Основание" value={reason} onChange={setReason} />
      <button
        type="button"
        className="btn--sm"
        disabled={busy || reason.trim().length < 3}
        onClick={() => void activate()}
      >
        Активировать выключенной
      </button>
    </section>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="form-row">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
