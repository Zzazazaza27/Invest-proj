import { useCallback, useEffect, useState } from 'react';
import {
  RESTRICTION_REASON_CODES,
  type AdminGroupStatus,
  type FunctionGroup,
  type RestrictionMode,
} from '@fifth/contracts';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Доступность групп функций для эксплуатации (4.11): «Файлы» и «Почта».
 *
 * Видно раздельно: исправность зависимости по свежим наблюдениям экземпляров и ручное
 * ограничение. Автоматическое восстановление ручной запрет не снимает — снять его можно
 * только здесь, с основанием в журнал. Заметка видна только эксплуатации.
 *
 * У «Почты» проверка — соединение, TLS и вход на релей без письма: «работает» означает, что
 * транспорт доступен, а не что письма доходят до адресатов.
 */
const HEALTH: Record<string, string> = { ok: 'работает', fail: 'отказ', unknown: 'неизвестно' };
const STATE: Record<string, string> = {
  available: 'доступна',
  read_only: 'только чтение',
  unavailable: 'недоступна',
  unknown: 'неизвестно',
};
const REASON: Record<string, string> = {
  maintenance: 'работы',
  incident: 'сбой',
  security: 'безопасность',
  other: 'другое',
};
const TITLE: Record<FunctionGroup, string> = { files: 'Файлы', mail: 'Почта' };

export function AvailabilityCard() {
  const [groups, setGroups] = useState<AdminGroupStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setGroups(await api.availability());
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить доступность функций'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="card" data-availability-list>
      <h2>Доступность функций</h2>
      {error ? <div className="alert alert--error">{error}</div> : null}
      {groups?.map((group) => (
        <GroupRow
          key={group.group}
          group={group}
          onChange={(next) =>
            setGroups((all) => all?.map((g) => (g.group === next.group ? next : g)) ?? null)
          }
        />
      ))}
    </section>
  );
}

function GroupRow({
  group,
  onChange,
}: {
  group: AdminGroupStatus;
  onChange: (next: AdminGroupStatus) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<RestrictionMode>('read_only');
  const [reasonCode, setReasonCode] =
    useState<(typeof RESTRICTION_REASON_CODES)[number]>('maintenance');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const isMail = group.group === 'mail';

  async function act(work: () => Promise<AdminGroupStatus>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await work());
      setNote('');
    } catch (err) {
      setError(problemText(err, 'Изменение не сохранено'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-availability={group.group} style={{ marginBottom: 16 }}>
      {error ? <div className="alert alert--error">{error}</div> : null}
      <p>
        {TITLE[group.group]}: <strong data-availability-state>{STATE[group.status.state]}</strong>.{' '}
        {isMail ? (
          <>
            Транспорт — <span data-availability-write>{HEALTH[group.dependency.write]}</span>{' '}
            <span className="small muted">
              (соединение и вход на релей; доставка адресатам этим не проверяется)
            </span>
            .
          </>
        ) : (
          <>
            Хранилище — чтение {HEALTH[group.dependency.read]}, запись{' '}
            <span data-availability-write>{HEALTH[group.dependency.write]}</span>.
          </>
        )}
      </p>
      {group.restriction ? (
        <p data-availability-restriction={group.restriction.mode}>
          Ручное ограничение:{' '}
          {group.restriction.mode === 'read_only' && !isMail ? 'только чтение' : 'недоступна'} (
          {REASON[group.restriction.reasonCode]}, {formatDate(group.restriction.setAt)}) —{' '}
          {group.restriction.note}. Автоматическое восстановление его не снимает.
        </p>
      ) : (
        <p className="small muted">Ручного ограничения нет.</p>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {group.restriction ? null : (
          <>
            {isMail ? null : (
              <select value={mode} onChange={(e) => setMode(e.target.value as RestrictionMode)}>
                <option value="read_only">Только чтение</option>
                <option value="unavailable">Недоступна</option>
              </select>
            )}
            <select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value as typeof reasonCode)}
            >
              {RESTRICTION_REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {REASON[code]}
                </option>
              ))}
            </select>
          </>
        )}
        <input
          placeholder="Основание — в журнал"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          data-availability-note
        />
        {group.restriction ? (
          <button
            type="button"
            disabled={busy || note.trim().length < 3}
            data-availability-clear
            onClick={() => void act(() => api.clearGroupRestriction(group.group, note.trim()))}
          >
            Снять ограничение
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || note.trim().length < 3}
            data-availability-restrict
            onClick={() =>
              void act(() =>
                api.restrictGroup(group.group, {
                  // У «Почты» один режим — отправка: ограничение закрывает её целиком.
                  mode: isMail ? 'unavailable' : mode,
                  reasonCode,
                  note: note.trim(),
                }),
              )
            }
          >
            Ввести ограничение
          </button>
        )}
      </div>
    </div>
  );
}
