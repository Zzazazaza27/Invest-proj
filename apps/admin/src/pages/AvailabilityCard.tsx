import { useCallback, useEffect, useState } from 'react';
import {
  RESTRICTION_REASON_CODES,
  type AdminGroupStatus,
  type RestrictionMode,
} from '@fifth/contracts';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Доступность группы «Файлы» для эксплуатации (4.11).
 *
 * Видно раздельно: исправность хранилища (чтение и запись по свежим наблюдениям экземпляров)
 * и ручное ограничение. Автоматическое восстановление ручной запрет не снимает — снять его
 * можно только здесь, с основанием в журнал. Заметка видна только эксплуатации.
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

export function AvailabilityCard() {
  const [group, setGroup] = useState<AdminGroupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<RestrictionMode>('read_only');
  const [reasonCode, setReasonCode] =
    useState<(typeof RESTRICTION_REASON_CODES)[number]>('maintenance');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setGroup((await api.availability())[0] ?? null);
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить доступность функций'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(work: () => Promise<AdminGroupStatus>) {
    setBusy(true);
    setError(null);
    try {
      setGroup(await work());
      setNote('');
    } catch (err) {
      setError(problemText(err, 'Изменение не сохранено'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-availability="files">
      <h2>Доступность функций</h2>
      {error ? <div className="alert alert--error">{error}</div> : null}
      {group ? (
        <>
          <p>
            Файлы: <strong data-availability-state>{STATE[group.status.state]}</strong>. Хранилище —
            чтение {HEALTH[group.dependency.read]}, запись{' '}
            <span data-availability-write>{HEALTH[group.dependency.write]}</span>.
          </p>
          {group.restriction ? (
            <p data-availability-restriction={group.restriction.mode}>
              Ручное ограничение:{' '}
              {group.restriction.mode === 'read_only' ? 'только чтение' : 'недоступна'} (
              {REASON[group.restriction.reasonCode]}, {formatDate(group.restriction.setAt)}) —{' '}
              {group.restriction.note}. Автоматическое восстановление его не снимает.
            </p>
          ) : (
            <p className="small muted">Ручного ограничения нет.</p>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {group.restriction ? null : (
              <>
                <select value={mode} onChange={(e) => setMode(e.target.value as RestrictionMode)}>
                  <option value="read_only">Только чтение</option>
                  <option value="unavailable">Недоступна</option>
                </select>
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
                onClick={() => void act(() => api.clearFilesRestriction(note.trim()))}
              >
                Снять ограничение
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || note.trim().length < 3}
                data-availability-restrict
                onClick={() =>
                  void act(() => api.restrictFiles({ mode, reasonCode, note: note.trim() }))
                }
              >
                Ввести ограничение
              </button>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
