import { describe, expect, it } from 'vitest';
import {
  isSafeHref,
  markdownToPlainText,
  parseInline,
  parseMarkdown,
} from '../src/markdown-parser';

/**
 * Разбор безопасного Markdown (план 0.2 §2.6, постановка §11.3).
 *
 * Главное здесь — не что рендерится, а что НЕ рендерится: HTML, опасные
 * схемы ссылок и всё за пределами allowlist остаются текстом.
 */

describe('Безопасность', () => {
  it('HTML-теги остаются текстом, узла html не существует', () => {
    const blocks = parseMarkdown('<script>alert(1)</script> и <img src=x onerror=alert(1)>');
    expect(blocks).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: '<script>alert(1)</script> и <img src=x onerror=alert(1)>' },
        ],
      },
    ]);
  });

  it('ссылки только на https://; javascript:, data:, http: и относительные — текст', () => {
    for (const bad of [
      '[x](javascript:alert(1))',
      '[x](JAVASCRIPT:alert(1))',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '[x](http://example.com)',
      '[x](/relative)',
      '[x](https://exa mple.com)',
      '[x](https://example.com"onclick="alert(1))',
    ]) {
      const nodes = parseInline(bad);
      expect(nodes, bad).toEqual([{ type: 'text', text: bad }]);
    }
    expect(parseInline('см. [словарь](https://example.com/glossary?x=1#a)')).toEqual([
      { type: 'text', text: 'см. ' },
      {
        type: 'link',
        href: 'https://example.com/glossary?x=1#a',
        children: [{ type: 'text', text: 'словарь' }],
      },
    ]);
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('https://')).toBe(false);
  });

  it('картинки, сноски и сырые URL не превращаются в узлы', () => {
    const nodes = parseInline('![alt](https://example.com/a.png) https://example.com <b>x</b>');
    expect(nodes.every((n) => n.type === 'text')).toBe(true);
  });

  it('вход обрезается по лимиту', () => {
    const blocks = parseMarkdown('a'.repeat(100), { maxLength: 10 });
    expect(blocks).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'a'.repeat(10) }] },
    ]);
  });
});

describe('Блоки', () => {
  it('абзацы разделяются пустой строкой, мягкий перенос — пробел', () => {
    expect(parseMarkdown('первая\nстрока\n\nвторой абзац')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'первая строка' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'второй абзац' }] },
    ]);
  });

  it('заголовки только второго–четвёртого уровня', () => {
    expect(parseMarkdown('## Два\n### Три\n#### Четыре')).toEqual([
      { type: 'heading', level: 2, children: [{ type: 'text', text: 'Два' }] },
      { type: 'heading', level: 3, children: [{ type: 'text', text: 'Три' }] },
      { type: 'heading', level: 4, children: [{ type: 'text', text: 'Четыре' }] },
    ]);
    expect(parseMarkdown('# Один')[0]?.type).toBe('paragraph');
    expect(parseMarkdown('##### Пять')[0]?.type).toBe('paragraph');
    expect(parseMarkdown('##Без пробела')[0]?.type).toBe('paragraph');
  });

  it('списки: маркированные, нумерованные, с продолжением пункта', () => {
    expect(parseMarkdown('- один\n- два\n  продолжение\n\n1. раз\n2) два')).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [[{ type: 'text', text: 'один' }], [{ type: 'text', text: 'два продолжение' }]],
      },
      {
        type: 'list',
        ordered: true,
        items: [[{ type: 'text', text: 'раз' }], [{ type: 'text', text: 'два' }]],
      },
    ]);
  });
});

describe('Строчная разметка', () => {
  it('жирный, курсив, код и вложенность', () => {
    expect(parseInline('это **жирный с *курсивом* внутри** и `код`')).toEqual([
      { type: 'text', text: 'это ' },
      {
        type: 'strong',
        children: [
          { type: 'text', text: 'жирный с ' },
          { type: 'em', children: [{ type: 'text', text: 'курсивом' }] },
          { type: 'text', text: ' внутри' },
        ],
      },
      { type: 'text', text: ' и ' },
      { type: 'code', text: 'код' },
    ]);
  });

  it('незакрытые маркеры остаются текстом', () => {
    expect(parseInline('2 * 3 * 4 и **нет закрытия')).toEqual([
      { type: 'text', text: '2 * 3 * 4 и **нет закрытия' },
    ]);
    expect(parseInline('цена 5 ₽ * скидка')).toEqual([{ type: 'text', text: 'цена 5 ₽ * скидка' }]);
  });

  it('текст без разметки — как есть', () => {
    expect(markdownToPlainText('## Заголовок\n\n- **пункт** [ссылка](https://a.b)')).toBe(
      'Заголовок\n\nпункт ссылка',
    );
  });
});
