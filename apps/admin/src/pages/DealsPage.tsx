import { useCallback, useEffect, useState } from 'react';
import type { DealLedger, DealSummary, StaffCapability } from '@unicorn/contracts';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Сделки: ручные записи о возврате и корректировке вознаграждения (M097).
 *
 * Автоматического возврата денег нет: переговоры и урегулирование проходят
 * между людьми, а платформа лишь ФИКСИРУЕТ состоявшееся. Поэтому действие
 * называется «Зафиксировать возврат», а не «Вернуть деньги».
 *
 * Возврат инвестиции сам по себе комиссию не отменяет. Если решено её
 * скорректировать, это отдельная запись, и уменьшение начисления — не то же
 * самое, что возврат уже уплаченных денег.
 *
 * Права проверяет сервер. Экран показывает, каких полномочий не хватает, но
 * скрытая кнопка защитой не является.
 */
export function DealsPage() {
  const [deals, setDeals] = useState<DealSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [ledger, setLedger] = useState<DealLedger | null>(null);
  const [capabilities, setCapabilities] = useState<StaffCapability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadDeals = useCallback(async () => {
    try {
      const [list, catalog] = await Promise.all([api.deals.list(), api.capabilities.catalog()]);
      setDeals(list.items);
      setCapabilities(catalog.items);
      setSelected((current) => current ?? list.items[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить сделки'));
    }
  }, []);

  const loadLedger = useCallback(async (id: string) => {
    try {
      setLedger(await api.deals.ledger(id));
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить записи по сделке'));
    }
  }, []);

  useEffect(() => {
    void loadDeals();
  }, [loadDeals]);

  useEffect(() => {
    setLedger(null);
    if (selected) void loadLedger(selected);
  }, [selected, loadLedger]);

  const done = async (text: string) => {
    setNotice(text);
    setError(null);
    if (selected) await loadLedger(selected);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Сделки</h1>
          <p className="page-hint">
            Записи о состоявшихся возвратах и корректировках вознаграждения. Платформа денег не
            перечисляет: это журнал фактов, а не платёжный контур.
          </p>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      {deals === null ? <div className="spinner">Загрузка…</div> : null}
      {deals !== null && deals.length === 0 ? (
        <section className="card">
          <div className="muted">Сделок пока нет.</div>
        </section>
      ) : null}

      {deals !== null && deals.length > 0 ? (
        <section className="card" data-deals>
          <h2 style={{ marginBottom: 2 }}>Сделки</h2>
          <div className="small muted" style={{ marginBottom: 10 }}>
            Показаны сделки, с которыми вы вправе работать.
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Проект</th>
                <th>Сумма договора</th>
                <th>Состояние</th>
                <th>Подтверждённых траншей</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {deals.map((deal) => (
                <tr
                  key={deal.id}
                  data-deal-row={deal.id}
                  style={deal.id === selected ? { fontWeight: 600 } : undefined}
                >
                  <td>{deal.projectTitle}</td>
                  <td>
                    {deal.contractAmount} {deal.currency}
                  </td>
                  <td>{deal.status}</td>
                  <td>{deal.confirmedTranches}</td>
                  <td className="row-actions">
                    <button type="button" className="btn--sm" onClick={() => setSelected(deal.id)}>
                      Открыть
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {ledger ? (
        <>
          <TranchesBlock ledger={ledger} onDone={done} onError={setError} />
          <AccrualsBlock ledger={ledger} onDone={done} onError={setError} />
        </>
      ) : null}

      {capabilities ? <CapabilitiesBlock capabilities={capabilities} /> : null}
    </>
  );
}

// ------------------------------------------------------------------ возвраты

function TranchesBlock({
  ledger,
  onDone,
  onError,
}: {
  ledger: DealLedger;
  onDone: (text: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  const [form, setForm] = useState({
    trancheId: '',
    amount: '',
    occurredOn: '',
    reason: '',
    evidenceRef: '',
  });
  const [busy, setBusy] = useState(false);

  const confirmed = ledger.tranches.filter((t) => t.status === 'confirmed');

  async function record() {
    setBusy(true);
    try {
      await api.deals.recordReturn({
        trancheId: form.trancheId,
        amount: form.amount.trim(),
        currency: ledger.currency,
        occurredOn: form.occurredOn,
        reason: form.reason.trim(),
        evidenceRef: form.evidenceRef.trim() === '' ? undefined : form.evidenceRef.trim(),
        // Ключ идемпотентности живёт на форме: повторное нажатие не создаёт
        // второй возврат, а возвращает уже записанный.
        idempotencyKey: `${form.trancheId}:${form.amount}:${form.occurredOn}`,
      });
      setForm((f) => ({ ...f, amount: '', reason: '', evidenceRef: '' }));
      await onDone('Возврат зафиксирован. Деньги платформой не перечисляются.');
    } catch (err) {
      onError(problemText(err, 'Возврат не зафиксирован'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(returnId: string) {
    const reason = window.prompt('Основание: почему запись аннулируется?');
    if (reason === null || reason.trim().length < 3) return;
    setBusy(true);
    try {
      await api.deals.cancelReturn(returnId, reason.trim());
      await onDone('Запись о возврате аннулирована; история сохранена.');
    } catch (err) {
      onError(problemText(err, 'Запись не аннулирована'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-tranches>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Транши и возвраты</h2>
          <div className="small muted">
            Возвраты бывают частичными; их сумма не превышает подтверждённую сумму транша. Ошибочная
            запись не удаляется — она аннулируется с основанием.
          </div>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>№</th>
            <th>Сумма транша</th>
            <th>Состояние</th>
            <th>Возвращено</th>
            <th>Записи</th>
          </tr>
        </thead>
        <tbody>
          {ledger.tranches.map((tranche) => (
            <tr key={tranche.id} data-tranche-row={tranche.trancheNo}>
              <td>{tranche.trancheNo}</td>
              <td>
                {tranche.amount} {ledger.currency}
              </td>
              <td>{tranche.status}</td>
              <td data-returned={tranche.returnedAmount}>
                {tranche.returnedAmount} {ledger.currency}
              </td>
              <td className="small">
                {tranche.returns.length === 0 ? '—' : null}
                {tranche.returns.map((item) => (
                  <div key={item.id} data-return-row={item.id}>
                    {item.amount} {item.currency} · {item.occurredOn} · {item.reason}
                    {item.cancelledAt ? (
                      <span className="muted"> — аннулировано: {item.cancelReason}</span>
                    ) : (
                      <button
                        type="button"
                        className="btn--ghost btn--sm"
                        disabled={busy}
                        onClick={() => void cancel(item.id)}
                      >
                        Аннулировать
                      </button>
                    )}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 16 }}>Зафиксировать возврат</h3>
      <div className="small muted" style={{ marginBottom: 8 }}>
        Это запись о фактически состоявшемся возврате, а не команда перечислить деньги.
      </div>
      <div className="form-row">
        <label htmlFor="return-tranche">Транш</label>
        <select
          id="return-tranche"
          value={form.trancheId}
          onChange={(e) => setForm((f) => ({ ...f, trancheId: e.target.value }))}
        >
          <option value="">— выберите —</option>
          {confirmed.map((tranche) => (
            <option key={tranche.id} value={tranche.id}>
              № {tranche.trancheNo} — {tranche.amount} {ledger.currency}
            </option>
          ))}
        </select>
      </div>
      <Field
        id="return-amount"
        label="Сумма возврата"
        value={form.amount}
        onChange={(v) => setForm((f) => ({ ...f, amount: v }))}
      />
      <div className="form-row">
        <label htmlFor="return-date">Дата возврата</label>
        <input
          id="return-date"
          type="date"
          value={form.occurredOn}
          onChange={(e) => setForm((f) => ({ ...f, occurredOn: e.target.value }))}
        />
      </div>
      <Field
        id="return-reason"
        label="Основание"
        value={form.reason}
        onChange={(v) => setForm((f) => ({ ...f, reason: v }))}
      />
      <Field
        id="return-evidence"
        label="Подтверждение (если есть)"
        value={form.evidenceRef}
        onChange={(v) => setForm((f) => ({ ...f, evidenceRef: v }))}
      />
      <button
        type="button"
        className="btn--sm"
        disabled={
          busy ||
          form.trancheId === '' ||
          form.amount.trim() === '' ||
          form.occurredOn === '' ||
          form.reason.trim().length < 3
        }
        onClick={() => void record()}
      >
        Зафиксировать возврат
      </button>
    </section>
  );
}

// ------------------------------------------------------------ корректировки

function AccrualsBlock({
  ledger,
  onDone,
  onError,
}: {
  ledger: DealLedger;
  onDone: (text: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  const [form, setForm] = useState({
    accrualId: '',
    kind: 'accrual_reduction' as 'accrual_reduction' | 'paid_refund',
    party: 'investor' as 'investor' | 'issuer',
    amount: '',
    reason: '',
  });
  const [busy, setBusy] = useState(false);

  async function adjust() {
    setBusy(true);
    try {
      await api.deals.adjustCommission({
        accrualId: form.accrualId,
        kind: form.kind,
        party: form.party,
        amount: form.amount.trim(),
        currency: ledger.currency,
        reason: form.reason.trim(),
        idempotencyKey: `${form.accrualId}:${form.kind}:${form.party}:${form.amount}`,
      });
      setForm((f) => ({ ...f, amount: '', reason: '' }));
      await onDone(
        form.kind === 'accrual_reduction'
          ? 'Уменьшение начисления зафиксировано. Деньги этим не возвращаются.'
          : 'Возврат уплаченного вознаграждения зафиксирован.',
      );
    } catch (err) {
      onError(problemText(err, 'Корректировка не зафиксирована'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-accruals>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Вознаграждение и корректировки</h2>
          <div className="small muted">
            Возврат инвестиции сам по себе комиссию не отменяет. Уменьшение начисления и возврат уже
            уплаченных денег — разные записи и разные полномочия.
          </div>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>База</th>
            <th>Ставка</th>
            <th>Инвестор</th>
            <th>Привлекающий</th>
            <th>Начислено</th>
            <th>Корректировки</th>
          </tr>
        </thead>
        <tbody>
          {ledger.accruals.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                Начислений по сделке нет.
              </td>
            </tr>
          ) : null}
          {ledger.accruals.map((accrual) => (
            <tr key={accrual.id} data-accrual-row={accrual.id}>
              <td>
                {accrual.baseAmount} {ledger.currency}
              </td>
              <td>{accrual.totalPct} %</td>
              <td>{accrual.investorFeeAmount}</td>
              <td>{accrual.issuerFeeAmount}</td>
              <td className="small">{formatDate(accrual.accruedAt)}</td>
              <td className="small">
                {accrual.adjustments.length === 0 ? '—' : null}
                {accrual.adjustments.map((item) => (
                  <div key={item.id} data-adjustment-row={item.id}>
                    {item.kind === 'accrual_reduction'
                      ? 'уменьшение начисления'
                      : 'возврат уплаченного'}{' '}
                    · {item.party === 'investor' ? 'инвестор' : 'привлекающий'} · {item.amount}{' '}
                    {item.currency}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 16 }}>Зафиксировать корректировку</h3>
      <div className="form-row">
        <label htmlFor="adjust-accrual">Начисление</label>
        <select
          id="adjust-accrual"
          value={form.accrualId}
          onChange={(e) => setForm((f) => ({ ...f, accrualId: e.target.value }))}
        >
          <option value="">— выберите —</option>
          {ledger.accruals.map((accrual) => (
            <option key={accrual.id} value={accrual.id}>
              {accrual.baseAmount} {ledger.currency} от {formatDate(accrual.accruedAt)}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label htmlFor="adjust-kind">Что фиксируем</label>
        <select
          id="adjust-kind"
          value={form.kind}
          onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as typeof form.kind }))}
        >
          <option value="accrual_reduction">Уменьшение начисления (деньги не возвращаются)</option>
          <option value="paid_refund">Возврат уже уплаченного вознаграждения</option>
        </select>
      </div>
      <div className="form-row">
        <label htmlFor="adjust-party">Сторона</label>
        <select
          id="adjust-party"
          value={form.party}
          onChange={(e) => setForm((f) => ({ ...f, party: e.target.value as typeof form.party }))}
        >
          <option value="investor">Инвестор</option>
          <option value="issuer">Привлекающий</option>
        </select>
      </div>
      <Field
        id="adjust-amount"
        label="Сумма"
        value={form.amount}
        onChange={(v) => setForm((f) => ({ ...f, amount: v }))}
      />
      <Field
        id="adjust-reason"
        label="Основание"
        value={form.reason}
        onChange={(v) => setForm((f) => ({ ...f, reason: v }))}
      />
      <button
        type="button"
        className="btn--sm"
        disabled={
          busy ||
          form.accrualId === '' ||
          form.amount.trim() === '' ||
          form.reason.trim().length < 3
        }
        onClick={() => void adjust()}
      >
        Зафиксировать корректировку
      </button>
    </section>
  );
}

// ------------------------------------------------------------- полномочия

function CapabilitiesBlock({ capabilities }: { capabilities: StaffCapability[] }) {
  const sections = [...new Set(capabilities.map((c) => c.section))];
  return (
    <section className="card" data-capabilities>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Полномочия сотрудников</h2>
          <div className="small muted">
            Что сотрудник вправе делать вообще. С какими объектами — задаёт назначение на проект:
            право фиксировать возврат не открывает все сделки платформы. Экран выдачи галочками
            появится отдельно; сейчас полномочия выдаются через API, а ручные денежные записи
            доступны администратору.
          </div>
        </div>
      </div>
      {sections.map((section) => (
        <div key={section} style={{ marginBottom: 12 }}>
          <strong>{section}</strong>
          <table className="table">
            <thead>
              <tr>
                <th>Полномочие</th>
                <th>Вид действия</th>
                <th>Нужна область работы</th>
              </tr>
            </thead>
            <tbody>
              {capabilities
                .filter((c) => c.section === section)
                .map((capability) => (
                  <tr key={capability.code} data-capability-row={capability.code}>
                    <td>
                      {capability.title}
                      <div className="small muted">{capability.description}</div>
                    </td>
                    <td className="small">
                      {ACTION_TITLES[capability.action] ?? capability.action}
                    </td>
                    <td>{capability.requiresAssignment ? 'да' : 'нет'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

const ACTION_TITLES: Record<string, string> = {
  view: 'просмотр',
  create: 'создание',
  update: 'изменение',
  confirm: 'подтверждение',
  financial_adjust: 'денежная корректировка',
  discuss: 'обсуждение',
  manage: 'распоряжение',
};

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
