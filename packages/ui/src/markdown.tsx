import { createElement, Fragment, type ReactNode } from 'react';
import {
  parseMarkdown,
  type BlockNode,
  type InlineNode,
  type ParseOptions,
} from './markdown-parser';

export interface MarkdownProps extends ParseOptions {
  /** Текст в безопасном подмножестве Markdown (см. `markdown.ts`). */
  source: string | null | undefined;
  /**
   * Компактный режим для всплывающих подсказок: заголовки показываются как
   * абзацы, а число блоков ограничено — подсказка не должна быть статьёй.
   */
  compact?: boolean;
  /** Сколько блоков показать в компактном режиме. */
  maxBlocks?: number;
  className?: string;
}

/**
 * Безопасный Markdown: один компонент для формы, предпросмотра, словаря и
 * админского предпросмотра. HTML из текста не рендерится ни при каких
 * условиях — узлы строятся из allowlist разбора, сырых строк в DOM нет.
 */
export function Markdown({
  source,
  compact = false,
  maxBlocks = 3,
  className,
  maxLength,
}: MarkdownProps) {
  if (!source) return null;
  let blocks = parseMarkdown(source, { maxLength });
  if (compact) blocks = blocks.slice(0, maxBlocks);
  if (blocks.length === 0) return null;
  return createElement(
    'div',
    { className },
    blocks.map((block, index) => renderBlock(block, index, compact)),
  );
}

function renderBlock(block: BlockNode, key: number, compact: boolean): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return createElement('p', { key }, renderInline(block.children));
    case 'heading':
      return createElement(
        compact ? 'p' : `h${block.level}`,
        { key },
        renderInline(block.children),
      );
    case 'list':
      return createElement(
        block.ordered ? 'ol' : 'ul',
        { key },
        block.items.map((item, i) => createElement('li', { key: i }, renderInline(item))),
      );
  }
}

function renderInline(nodes: InlineNode[]): ReactNode {
  return createElement(
    Fragment,
    null,
    nodes.map((node, index) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'code':
          return createElement('code', { key: index }, node.text);
        case 'strong':
          return createElement('strong', { key: index }, renderInline(node.children));
        case 'em':
          return createElement('em', { key: index }, renderInline(node.children));
        case 'link':
          return createElement(
            'a',
            { key: index, href: node.href, target: '_blank', rel: 'noopener noreferrer' },
            renderInline(node.children),
          );
      }
    }),
  );
}
