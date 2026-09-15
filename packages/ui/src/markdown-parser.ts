/**
 * Безопасный Markdown продуктовых текстов — разбор (план 0.2 §2.6).
 *
 * Подсказки, примеры, вводные разделов, словарь и ЧАВО правятся владельцем в
 * админке и показываются основателю. Поэтому разрешено ровно то, что
 * перечислено в постановке (§11.3): абзацы, заголовки второго–четвёртого
 * уровня, списки, курсив, жирный, код и ссылки только на `https://`. Всё
 * остальное — текст как есть: HTML-теги, `javascript:` и `data:` в ссылках,
 * заголовки первого уровня, картинки — не превращаются ни во что.
 *
 * Библиотека не берётся сознательно: любая рендерит подмножество HTML, и
 * безопасность зависит от санитайзера. Здесь разбор строит дерево из allowlist
 * узлов, а компонент (`markdown.tsx`) собирает из него React-элементы —
 * пути для сырого HTML нет по конструкции. Разбор вынесен отдельно от React,
 * чтобы его проверяли тесты без DOM.
 */

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: InlineNode[] };

export type BlockNode =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'heading'; level: 2 | 3 | 4; children: InlineNode[] }
  | { type: 'list'; ordered: boolean; items: InlineNode[][] };

export interface ParseOptions {
  /** Обрезка входа: подсказка длиной в роман — ошибка данных, а не сценарий. */
  maxLength?: number;
}

export const MARKDOWN_MAX_LENGTH = 20_000;

/** Ссылка допустима только на `https://`, без пробелов и управляющих символов. */
export function isSafeHref(href: string): boolean {
  if (!/^https:\/\/[^\s<>"'`]+$/i.test(href)) return false;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function parseMarkdown(source: string, options: ParseOptions = {}): BlockNode[] {
  const limit = options.maxLength ?? MARKDOWN_MAX_LENGTH;
  const text = (source ?? '').replace(/\r\n?/g, '\n').slice(0, limit);
  const lines = text.split('\n');
  const blocks: BlockNode[] = [];

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({
      type: 'list',
      ordered: list.ordered,
      items: list.items.map((item) => parseInline(item)),
    });
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{2,4})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: 'heading',
        level: heading[1]!.length as 2 | 3 | 4,
        children: parseInline(heading[2]!),
      });
      continue;
    }

    const item = line.match(/^(?:([-*•])|(\d{1,3})[.)])\s+(.+)$/);
    if (item) {
      flushParagraph();
      const ordered = item[2] !== undefined;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item[3]!);
      continue;
    }

    if (list) {
      // Продолжение пункта списка с новой строки — часть того же пункта.
      list.items[list.items.length - 1] += ` ${line}`;
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/**
 * Строчная разметка. Сканер идёт слева направо и пробует маркеры по очереди;
 * не совпавший маркер остаётся обычным текстом — незакрытая звёздочка или
 * скобка не ломают абзац и не превращаются ни во что.
 */
export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = '';
  const flushText = () => {
    if (buffer) nodes.push({ type: 'text', text: buffer });
    buffer = '';
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    const code = rest.match(/^`([^`\n]+)`/);
    if (code) {
      flushText();
      nodes.push({ type: 'code', text: code[1]! });
      i += code[0].length;
      continue;
    }

    const strong = rest.match(/^\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/);
    if (strong) {
      flushText();
      nodes.push({ type: 'strong', children: parseInline(strong[1]!) });
      i += strong[0].length;
      continue;
    }

    const em = rest.match(/^\*(?=[^\s*])([^*\n]+?)(?<=\S)\*/);
    if (em) {
      flushText();
      nodes.push({ type: 'em', children: parseInline(em[1]!) });
      i += em[0].length;
      continue;
    }

    const link = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/);
    if (link) {
      const href = link[2]!;
      // Картинка (`![alt](url)`) ссылкой не становится: восклицательный знак
      // перед скобкой оставляет всю конструкцию текстом.
      if (isSafeHref(href) && !buffer.endsWith('!')) {
        flushText();
        nodes.push({ type: 'link', href, children: parseInline(link[1]!) });
        i += link[0].length;
        continue;
      }
      // Небезопасная ссылка остаётся текстом целиком — видно, что она была.
      buffer += link[0];
      i += link[0].length;
      continue;
    }

    buffer += source[i];
    i += 1;
  }
  flushText();
  return mergeText(nodes);
}

function mergeText(nodes: InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (node.type === 'text' && last?.type === 'text') {
      last.text += node.text;
    } else {
      merged.push(node);
    }
  }
  return merged;
}

/** Только текст, без разметки: для `aria-label`, заголовков окна, поиска. */
export function markdownToPlainText(source: string, options?: ParseOptions): string {
  const inlineText = (nodes: InlineNode[]): string =>
    nodes
      .map((n) => (n.type === 'text' || n.type === 'code' ? n.text : inlineText(n.children)))
      .join('');
  return parseMarkdown(source, options)
    .map((block) =>
      block.type === 'list'
        ? block.items.map((item) => inlineText(item)).join('\n')
        : inlineText(block.children),
    )
    .join('\n\n');
}
