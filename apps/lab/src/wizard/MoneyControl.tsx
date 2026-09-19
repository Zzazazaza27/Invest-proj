import { useEffect, useState } from 'react';
import { Input } from '@unicorn/ui';
import { parseMoneyInput } from './money';

/**
 * Ввод суммы: один элемент для анкеты и для параметров раунда.
 *
 * Что здесь важно (замечание ручного прохода 5.7):
 * — значение уходит на сервер по уходу из поля, а не на каждое нажатие: иначе
 *   промежуточная строка вроде `3500000.003` успевала попасть в автосохранение;
 * — разобранная сумма показывается в поле в нормализованном виде — замена
 *   `1 000 000,50` на `1000000.50` видна человеку, а не происходит молча;
 * — если разобрать не удалось, введённое ОСТАЁТСЯ в поле, а сообщение об
 *   ошибке показывается у поля; на сервер такая строка не отправляется;
 * — если сумму отверг сервер, черновик тоже остаётся: поле не откатывается
 *   к прежнему значению, пока сервер не подтвердит новое.
 *
 * Серверная проверка не отменяется: это подсказка человеку, а не защита.
 */
export function MoneyControl({
  id,
  value,
  allowZero = false,
  describedBy,
  onError,
  onCommit,
}: {
  id: string;
  /** Сумма, подтверждённая сервером, в формате контракта. */
  value: string | null;
  /** Ноль допустим (поле «уже подтверждено»). */
  allowZero?: boolean;
  describedBy?: string;
  /** Сообщение об ошибке ввода для показа у поля; `null` — ошибки нет. */
  onError: (message: string | null) => void;
  onCommit: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  // Сервер подтвердил ровно то, что в черновике — черновик больше не нужен.
  // Если значение изменилось иначе (перезагрузка раунда, другая вкладка),
  // черновик остаётся: несохранённый ввод человека не затираем.
  useEffect(() => {
    setDraft((current) => {
      if (current === null) return null;
      const parsed = parseMoneyInput(current, allowZero);
      return parsed.ok && parsed.value === value ? null : current;
    });
  }, [value, allowZero]);

  const commit = () => {
    if (draft === null) return;
    const parsed = parseMoneyInput(draft, allowZero);
    if (!parsed.ok) {
      onError(parsed.error);
      return;
    }
    onError(null);
    setDraft(parsed.value ?? '');
    if (parsed.value !== value) onCommit(parsed.value);
  };

  return (
    <Input
      id={id}
      inputMode="decimal"
      value={draft ?? value ?? ''}
      placeholder="1000000.00"
      aria-describedby={describedBy}
      onChange={(e) => {
        setDraft(e.target.value);
        onError(null);
      }}
      onBlur={commit}
    />
  );
}
