import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Markdown, markdownToPlainText } from '@unicorn/ui';
import type { TextsResponse } from '@unicorn/contracts';
import { api } from '../api';
import { S } from '../strings';

/**
 * Словарь терминов для подсказок в мастере (план 0.2 §2.6, этап 5.3).
 *
 * Термины приходят из `content.text_entries` — их редактирует администратор,
 * а не код. Загружаются один раз на страницу и делятся между вопросами:
 * объём — десятки записей, кеша сервера нет по замыслу (`no-store`).
 *
 * Термин показывается рядом с вопросом, если его название встречается в
 * формулировке или подсказке вопроса. Подсказка — короткое пояснение и
 * ссылка на полную статью; открывается кнопкой, поэтому одинаково работает
 * с клавиатуры, мышью и касанием (без hover-only поведения).
 */

export interface GlossaryTerm {
  key: string;
  term: string;
  shortMd: string | null;
  fullMd: string | null;
}

let cache: Promise<GlossaryTerm[]> | null = null;

export function loadGlossary(): Promise<GlossaryTerm[]> {
  if (!cache) {
    cache = api
      .texts('glossary')
      .then((response) => toTerms(response))
      .catch(() => {
        // Словарь — вспомогательная справка: без него мастер работает как
        // прежде. Следующая страница попробует снова.
        cache = null;
        return [];
      });
  }
  return cache;
}

export function toTerms(response: TextsResponse): GlossaryTerm[] {
  return response.entries
    .map((entry) => ({
      key: entry.key,
      term: (entry.texts.term ?? '').trim(),
      shortMd: entry.texts.short_md?.trim() || null,
      fullMd: entry.texts.full_md?.trim() || null,
    }))
    .filter((term) => term.term !== '');
}

export function useGlossary(): GlossaryTerm[] {
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  useEffect(() => {
    let alive = true;
    void loadGlossary().then((loaded) => {
      if (alive) setTerms(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);
  return terms;
}

/**
 * Термины, упомянутые в тексте: сравнение по словам без учёта регистра.
 * Русские окончания не разбираются намеренно — совпадение первых пяти
 * букв слова достаточно для подсказки и не требует морфологии.
 */
export function matchTerms(
  terms: GlossaryTerm[],
  ...texts: (string | null | undefined)[]
): GlossaryTerm[] {
  const haystack = texts
    .filter((t): t is string => typeof t === 'string' && t !== '')
    .map((t) => markdownToPlainText(t))
    .join(' ')
    .toLowerCase();
  if (haystack === '') return [];
  const words = new Set(haystack.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const stems = new Set([...words].map(stem));
  return terms.filter((term) => {
    const parts = term.term
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    if (parts.length === 0) return false;
    if (parts.length === 1) {
      const part = parts[0]!;
      return part.length <= 3 ? words.has(part) : stems.has(stem(part));
    }
    return haystack.includes(parts.join(' '));
  });
}

function stem(word: string): string {
  return word.length > 5 ? word.slice(0, 5) : word;
}

/** Строка подсказок под вопросом: по кнопке на каждый найденный термин. */
export function TermHints({ terms }: { terms: GlossaryTerm[] }) {
  if (terms.length === 0) return null;
  return (
    <div
      data-term-hints
      style={{
        display: 'flex',
        gap: 'var(--u-space-2)',
        flexWrap: 'wrap',
        alignItems: 'center',
        fontSize: 'var(--u-text-sm)',
      }}
    >
      <span style={{ color: 'var(--u-text-muted)' }}>{S.glossary.hintsLabel}</span>
      {terms.map((term) => (
        <TermHint key={term.key} term={term} />
      ))}
    </div>
  );
}

function TermHint({ term }: { term: GlossaryTerm }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={root} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        data-term={term.key}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          font: 'inherit',
          color: 'var(--u-accent)',
          textDecoration: 'underline dotted',
          textUnderlineOffset: 3,
          cursor: 'help',
        }}
      >
        {term.term}
      </button>
      {open ? (
        <span
          id={id}
          role="dialog"
          aria-label={term.term}
          data-term-popover={term.key}
          style={{
            position: 'absolute',
            zIndex: 20,
            top: 'calc(100% + 6px)',
            left: 0,
            minWidth: 240,
            maxWidth: 'min(360px, 80vw)',
            padding: 'var(--u-space-3)',
            background: 'var(--u-surface)',
            border: '1px solid var(--u-border)',
            borderRadius: 'var(--u-radius-md)',
            boxShadow: 'var(--u-shadow-md, 0 6px 24px rgba(0,0,0,.12))',
            display: 'grid',
            gap: 'var(--u-space-2)',
            textAlign: 'left',
          }}
        >
          <strong>{term.term}</strong>
          {term.shortMd ? (
            <Markdown source={term.shortMd} compact maxBlocks={2} maxLength={1200} />
          ) : (
            <span style={{ color: 'var(--u-text-muted)' }}>{S.glossary.noShort}</span>
          )}
          <Link to={`/glossary#${term.key}`} onClick={() => setOpen(false)}>
            {S.glossary.more}
          </Link>
        </span>
      ) : null}
    </span>
  );
}

/** Подбор терминов к одному вопросу — с мемоизацией по текстам. */
export function useTermsFor(
  terms: GlossaryTerm[],
  label: string,
  helpMd: string | null,
): GlossaryTerm[] {
  return useMemo(() => matchTerms(terms, label, helpMd), [terms, label, helpMd]);
}
