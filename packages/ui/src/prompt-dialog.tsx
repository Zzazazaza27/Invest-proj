import { useEffect, useState } from 'react';
import { Button, Field, Input } from './primitives';

/**
 * Диалог с одним полем — замена `window.prompt`.
 *
 * Зачем свой, а не системный. `window.prompt` блокирует поток страницы целиком,
 * выглядит как окно браузера, а не как часть платформы, не переводится, не
 * стилизуется, отключается настройками браузера и в некоторых из них просто не
 * показывается — оператор нажимает кнопку и не понимает, почему ничего не
 * произошло. При этом здесь через него вводились ОСНОВАНИЯ действий, которые
 * уходят в неизменяемый журнал: терять их из-за настройки браузера нельзя.
 *
 * Что делает этот диалог правильно: возвращает фокус на поле при открытии,
 * закрывается по Escape, не даёт отправить пустое основание (журнал с пустой
 * причиной бесполезен) и объявляет себя как `role="dialog"` с подписью.
 */
export function PromptDialog({
  open,
  title,
  description,
  label,
  placeholder,
  confirmText = 'Подтвердить',
  initialValue = '',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  confirmText?: string;
  initialValue?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      // Фокус на поле: диалог, в который нужно ещё попасть мышью, — это лишний
      // шаг для того, кто работает с клавиатуры.
      // Поле ищется по id: `Input` из @unicorn/ui не пробрасывает ref, а
      // менять его сигнатуру ради одного диалога — трогать всё, что на нём
      // построено.
      const id = window.setTimeout(
        () => document.getElementById('prompt-dialog-value')?.focus(),
        0,
      );
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open, initialValue]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const trimmed = value.trim();

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--u-space-4)',
        background: 'rgba(0, 0, 0, 0.45)',
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) onConfirm(trimmed);
        }}
        style={{
          width: 'min(32rem, 100%)',
          display: 'grid',
          gap: 'var(--u-space-4)',
          padding: 'var(--u-space-5)',
          borderRadius: 'var(--u-radius-lg)',
          border: '1px solid var(--u-border)',
          background: 'var(--u-surface)',
          boxShadow: 'var(--u-shadow-lg, 0 24px 60px rgba(0,0,0,0.35))',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>{title}</h2>
        {description ? (
          <p style={{ margin: 0, color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
            {description}
          </p>
        ) : null}

        <Field label={label} htmlFor="prompt-dialog-value">
          <Input
            id="prompt-dialog-value"
            value={value}
            placeholder={placeholder}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>

        <div style={{ display: 'flex', gap: 'var(--u-space-3)', justifyContent: 'flex-end' }}>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Отмена
          </Button>
          <Button type="submit" disabled={trimmed.length === 0}>
            {confirmText}
          </Button>
        </div>
      </form>
    </div>
  );
}
