import { useEffect, useMemo, useState } from 'react';
import { Button, Field, Input } from '@unicorn/ui';
import type { FormValues, Notebook, Operation } from '../types';

/**
 * Форма одной операции.
 *
 * Значения полей пересобираются при смене операции: остаточное состояние
 * прошлой формы («сумму ввёл там, отправил здесь») — источник ошибок, которые
 * потом ищут в сервере.
 */
export function OperationForm({
  operation,
  notebook,
  busy,
  onSubmit,
}: {
  operation: Operation;
  notebook: Notebook;
  busy: boolean;
  onSubmit: (values: FormValues) => void;
}) {
  const initial = useMemo(() => {
    const values: FormValues = {};
    for (const field of operation.fields ?? []) {
      // Идентификатор, полученный в этом прогоне, важнее значения по умолчанию:
      // ради этого блокнот и заведён.
      const remembered = notebook.get(field.name);
      if (remembered !== undefined && field.kind !== 'checkbox') {
        values[field.name] = remembered;
        continue;
      }
      if (field.defaultValue !== undefined) values[field.name] = field.defaultValue;
      else if (field.kind === 'checkbox') values[field.name] = false;
      else values[field.name] = '';
    }
    return values;
    // Пересборка именно по идентификатору операции: объект описания стабилен.
  }, [operation.id, operation.fields, notebook]);

  const [values, setValues] = useState<FormValues>(initial);
  useEffect(() => setValues(initial), [initial]);

  function set(name: string, value: FormValues[string]): void {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  const fields = operation.fields ?? [];

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
      noValidate
    >
      {fields.length === 0 ? (
        <p style={{ color: 'var(--u-text-muted)', margin: '0 0 16px' }}>
          Параметров нет — операция вызывается как есть.
        </p>
      ) : null}

      {fields.map((field) => {
        const id = `${operation.id}-${field.name}`;
        const value = values[field.name];

        if (field.kind === 'checkbox') {
          return (
            <div key={field.name} style={{ margin: '0 0 16px' }}>
              <label htmlFor={id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  id={id}
                  type="checkbox"
                  checked={value === true || value === 'true'}
                  onChange={(event) => set(field.name, event.target.checked)}
                />
                <span>{field.label}</span>
              </label>
              {field.help ? <p className="console-help">{field.help}</p> : null}
            </div>
          );
        }

        if (field.kind === 'select') {
          return (
            <Field key={field.name} label={field.label} htmlFor={id} hint={field.help}>
              <select
                id={id}
                className="console-control"
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => set(field.name, event.target.value)}
              >
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
          );
        }

        if (field.kind === 'textarea' || field.kind === 'json') {
          return (
            <Field key={field.name} label={field.label} htmlFor={id} hint={field.help}>
              <textarea
                id={id}
                className="console-control"
                rows={field.kind === 'json' ? 4 : 3}
                spellCheck={field.kind !== 'json'}
                placeholder={field.placeholder}
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => set(field.name, event.target.value)}
              />
            </Field>
          );
        }

        if (field.kind === 'file') {
          return (
            <Field key={field.name} label={field.label} htmlFor={id} hint={field.help}>
              <input
                id={id}
                className="console-control"
                type="file"
                onChange={(event) => set(field.name, event.target.files?.[0])}
              />
            </Field>
          );
        }

        return (
          <Field key={field.name} label={field.label} htmlFor={id} hint={field.help}>
            <Input
              id={id}
              type={
                field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'
              }
              placeholder={field.placeholder}
              value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
              onChange={(event) => set(field.name, event.target.value)}
            />
          </Field>
        );
      })}

      <Button type="submit" disabled={busy}>
        {busy ? 'Выполняется…' : `Выполнить ${operation.method} ${operation.path}`}
      </Button>
    </form>
  );
}
