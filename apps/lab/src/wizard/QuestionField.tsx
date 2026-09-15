import { Badge, Field, Input, Markdown, Select, TextArea } from '@unicorn/ui';
import type { FormQuestionView, ProjectMaterial } from '@unicorn/contracts';
import { S } from '../strings';
import { TermHints, useGlossary, useTermsFor } from './glossary';

/**
 * Один вопрос анкеты — по типу из опубликованной конфигурации.
 *
 * Компонент ничего не знает о конкретных вопросах: формулировка, подсказка,
 * примеры и варианты приходят с сервера. Здесь только сопоставление типа
 * поля с элементом ввода и подписи «обязательный / рекомендуется».
 * Никакой валидации «на всякий случай»: черновик свободен, а тип значения
 * проверяет сервер и отвечает ошибкой у поля.
 */
export function QuestionField({
  question,
  value,
  evidence,
  materials,
  error,
  onChange,
  onEvidence,
  onBlurCommit,
}: {
  question: FormQuestionView;
  value: unknown;
  evidence: readonly string[];
  materials: ProjectMaterial[];
  error?: string;
  onChange: (value: unknown) => void;
  onEvidence?: (materialIds: string[]) => void;
  /** Для системных текстовых полей: зафиксировать значение при уходе из поля. */
  onBlurCommit?: () => void;
}) {
  const id = `q-${question.key}`;
  const mandatory = question.state === 'mandatory';
  const glossary = useGlossary();
  const terms = useTermsFor(glossary, question.label, question.helpMd);

  return (
    <div
      data-question={question.key}
      style={{
        display: 'grid',
        gap: 'var(--u-space-2)',
        paddingBottom: 'var(--u-space-4)',
        borderBottom: '1px solid var(--u-border)',
      }}
    >
      <div
        style={{ display: 'flex', gap: 'var(--u-space-2)', alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Badge tone={mandatory ? 'accent' : 'neutral'}>
          {mandatory ? S.wizard.levels.mandatory : S.wizard.levels.recommended}
        </Badge>
        {question.evidence ? <Badge tone="neutral">{S.wizard.field.evidence}</Badge> : null}
      </div>
      <Field label={question.label} htmlFor={id} error={error ?? null}>
        <div onBlur={onBlurCommit}>
          <Control
            question={question}
            id={id}
            value={value}
            materials={materials}
            onChange={onChange}
          />
        </div>
      </Field>
      {question.helpMd ? (
        <Markdown source={question.helpMd} className="u-help" maxLength={4000} />
      ) : null}
      <TermHints terms={terms} />
      {question.exampleGoodMd || question.exampleWeakMd ? (
        <details>
          <summary
            style={{ cursor: 'pointer', fontSize: 'var(--u-text-sm)', color: 'var(--u-accent)' }}
          >
            {S.wizard.field.examples}
          </summary>
          <div
            style={{
              display: 'grid',
              gap: 'var(--u-space-3)',
              marginTop: 'var(--u-space-2)',
              fontSize: 'var(--u-text-sm)',
            }}
          >
            {question.exampleGoodMd ? (
              <div
                style={{
                  borderLeft: '3px solid var(--u-success)',
                  paddingLeft: 'var(--u-space-3)',
                }}
              >
                <strong>{S.wizard.field.good}.</strong> <Markdown source={question.exampleGoodMd} />
              </div>
            ) : null}
            {question.exampleWeakMd ? (
              <div
                style={{
                  borderLeft: '3px solid var(--u-warning)',
                  paddingLeft: 'var(--u-space-3)',
                }}
              >
                <strong>{S.wizard.field.weak}.</strong> <Markdown source={question.exampleWeakMd} />
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
      {question.evidence && onEvidence ? (
        <details open={evidence.length > 0}>
          <summary
            style={{ cursor: 'pointer', fontSize: 'var(--u-text-sm)', color: 'var(--u-accent)' }}
          >
            {S.wizard.field.evidence}
            {evidence.length > 0 ? ` (${evidence.length})` : ''}
          </summary>
          <MaterialPicker
            id={`${id}-evidence`}
            materials={materials}
            selected={evidence}
            hint={S.wizard.field.evidenceHint}
            onChange={onEvidence}
          />
        </details>
      ) : null}
    </div>
  );
}

function Control({
  question,
  id,
  value,
  materials,
  onChange,
}: {
  question: FormQuestionView;
  id: string;
  value: unknown;
  materials: ProjectMaterial[];
  onChange: (value: unknown) => void;
}) {
  const max = question.constraints?.maxLength ?? undefined;
  switch (question.type) {
    case 'textarea':
      return (
        <TextArea
          id={id}
          value={typeof value === 'string' ? value : ''}
          maxLength={max}
          rows={5}
          placeholder={question.placeholder ?? undefined}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        />
      );
    case 'text':
      return (
        <Input
          id={id}
          value={typeof value === 'string' ? value : ''}
          maxLength={max}
          placeholder={question.placeholder ?? undefined}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        />
      );
    case 'number':
      return (
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          value={typeof value === 'number' ? String(value) : ''}
          min={question.constraints?.min}
          max={question.constraints?.max}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'money':
      return (
        <div style={{ display: 'flex', gap: 'var(--u-space-2)', alignItems: 'center' }}>
          <Input
            id={id}
            inputMode="decimal"
            value={typeof value === 'string' ? value : ''}
            placeholder="1000000.00"
            onChange={(e) => onChange(e.target.value === '' ? null : e.target.value.trim())}
            aria-describedby={`${id}-hint`}
          />
          <span style={{ color: 'var(--u-text-muted)' }}>{S.wizard.field.currency}</span>
        </div>
      );
    case 'select':
      return (
        <Select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">{S.wizard.field.empty}</option>
          {(question.options ?? []).map((o) => (
            <option key={o.code} value={o.code}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    case 'multiselect': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div id={id} role="group" style={{ display: 'grid', gap: 'var(--u-space-1)' }}>
          {(question.options ?? []).map((o) => (
            <label
              key={o.code}
              style={{ display: 'flex', gap: 'var(--u-space-2)', alignItems: 'center' }}
            >
              <input
                type="checkbox"
                checked={selected.includes(o.code)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...selected, o.code]
                    : selected.filter((c) => c !== o.code);
                  onChange(next.length === 0 ? null : next);
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'boolean':
      return (
        <Select
          id={id}
          value={value === true ? 'yes' : value === false ? 'no' : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'yes')}
        >
          <option value="">{S.wizard.field.empty}</option>
          <option value="yes">{S.wizard.field.yes}</option>
          <option value="no">{S.wizard.field.no}</option>
        </Select>
      );
    case 'url':
      return (
        <Input
          id={id}
          type="url"
          inputMode="url"
          placeholder="https://"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value.trim())}
        />
      );
    case 'date':
      return (
        <Input
          id={id}
          type="date"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        />
      );
    case 'material_ref':
      return (
        <MaterialPicker
          id={id}
          materials={materials}
          selected={Array.isArray(value) ? (value as string[]) : []}
          onChange={(ids) => onChange(ids.length === 0 ? null : ids)}
        />
      );
  }
}

const MATERIAL_TYPE_LABEL: Record<string, string> = {
  deck: 'Презентация',
  video: 'Видео',
  doc: 'Документ',
  product_link: 'Ссылка на продукт',
};

/** Выбор материалов проекта — для ответа-материала и для подтверждений. */
function MaterialPicker({
  id,
  materials,
  selected,
  hint,
  onChange,
}: {
  id: string;
  materials: ProjectMaterial[];
  selected: readonly string[];
  hint?: string;
  onChange: (ids: string[]) => void;
}) {
  if (materials.length === 0) {
    return (
      <span id={id} style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
        {S.wizard.field.noMaterials}
      </span>
    );
  }
  return (
    <div id={id} role="group" style={{ display: 'grid', gap: 'var(--u-space-1)' }}>
      {hint ? (
        <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-xs)' }}>{hint}</span>
      ) : null}
      {materials.map((m) => (
        <label
          key={m.id}
          style={{ display: 'flex', gap: 'var(--u-space-2)', alignItems: 'center' }}
        >
          <input
            type="checkbox"
            checked={selected.includes(m.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...selected, m.id] : selected.filter((x) => x !== m.id))
            }
          />
          <span>
            {MATERIAL_TYPE_LABEL[m.type] ?? m.type}
            {m.url ? ` — ${m.url}` : ` (версия ${m.version})`}
          </span>
        </label>
      ))}
    </div>
  );
}
