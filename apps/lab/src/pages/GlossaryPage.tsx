import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Card, EmptyState, ErrorState, LoadingState, Markdown, Stack } from '@unicorn/ui';
import type { TextsResponse } from '@unicorn/contracts';
import { api } from '../api';
import { S } from '../strings';

/**
 * Словарь терминов и ЧАВО основателя (план 0.2 §2.6, этап 5.3).
 *
 * Содержимое целиком из БД: администратор правит записи в своём кабинете,
 * здесь только вывод. Ссылка `/glossary#ключ` из подсказки в мастере
 * прокручивает к термину. Язык — пока только ru-RU: переключателя языка в
 * кабинете ещё нет, а fallback на русский сервер делает сам.
 */
export function GlossaryPage() {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const [glossary, setGlossary] = useState<TextsResponse | null>(null);
  const [faq, setFaq] = useState<TextsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.texts('glossary'), api.texts('faq')])
      .then(([g, f]) => {
        setGlossary(g);
        setFaq(f);
      })
      .catch(() => setError(S.glossary.loadError));
  }, []);

  useEffect(() => {
    if (!glossary || !hash) return;
    const el = document.getElementById(hash.slice(1));
    if (el) {
      el.scrollIntoView({ block: 'start' });
      el.focus();
    }
  }, [glossary, hash]);

  if (error) return <ErrorState title={error} />;
  if (!glossary || !faq) return <LoadingState label={S.glossary.loading} />;

  const terms = glossary.entries.filter((e) => (e.texts.term ?? '').trim() !== '');
  const questions = faq.entries.filter((e) => (e.texts.question ?? '').trim() !== '');

  return (
    <Stack gap="var(--u-space-5)">
      <div
        style={{ display: 'flex', gap: 'var(--u-space-3)', alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Button variant="secondary" onClick={() => navigate(-1)}>
          ← {S.glossary.back}
        </Button>
        <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>{S.glossary.title}</h1>
      </div>

      <Card>
        <Stack gap="var(--u-space-4)">
          <h2 style={{ margin: 0 }}>{S.glossary.terms}</h2>
          {terms.length === 0 ? <EmptyState title={S.glossary.emptyTerms} /> : null}
          {terms.map((entry) => (
            <article
              key={entry.key}
              id={entry.key}
              tabIndex={-1}
              data-glossary-term={entry.key}
              style={{
                scrollMarginTop: 'var(--u-space-6)',
                paddingBottom: 'var(--u-space-3)',
                borderBottom: '1px solid var(--u-border)',
              }}
            >
              <h3 style={{ margin: '0 0 var(--u-space-2)' }}>{entry.texts.term}</h3>
              {entry.texts.full_md ? (
                <Markdown source={entry.texts.full_md} maxLength={20_000} />
              ) : (
                <Markdown source={entry.texts.short_md} maxLength={4000} />
              )}
            </article>
          ))}
        </Stack>
      </Card>

      <Card>
        <Stack gap="var(--u-space-4)">
          <h2 style={{ margin: 0 }}>{S.glossary.faq}</h2>
          {questions.length === 0 ? <EmptyState title={S.glossary.emptyFaq} /> : null}
          {questions.map((entry) => (
            <details key={entry.key} id={entry.key} data-faq={entry.key}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                {entry.texts.question}
              </summary>
              <div style={{ marginTop: 'var(--u-space-2)' }}>
                <Markdown source={entry.texts.answer_md} maxLength={20_000} />
              </div>
            </details>
          ))}
        </Stack>
      </Card>
    </Stack>
  );
}
