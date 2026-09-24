/**
 * @unicorn/ui — дизайн-токены и примитивы.
 *
 * Пакет НЕ знает про API, роутер и бизнес-правила: он про форму, состояния и
 * доступность. Это и делает его переиспользуемым всеми пятью фронтендами и
 * заменяемым вместе с любым из них (ADR-002).
 *
 * Что здесь не должно появляться: обращения к сети, доменные типы, тексты
 * конкретных экранов.
 */

export {
  Badge,
  Button,
  Card,
  Container,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  OfflineBanner,
  Select,
  Skeleton,
  Spinner,
  Stack,
  TextArea,
  UI_KEYFRAMES,
  type ButtonProps,
  type ButtonVariant,
  type FieldProps,
} from './primitives';

/**
 * Иконки и крупные формы темы Nova.
 *
 * Экспортируются отсюда, но НЕ включаются сами собой: без импорта
 * `@unicorn/ui/theme-nova.css` компоненты отрисуются базовыми токенами —
 * бледнее, но целиком рабочими. Это и есть цена отката: одна строка импорта.
 */
export { Icon, IconTile, type IconName, type IconProps } from './icons';

export {
  HeroBanner,
  NovaTopBar,
  PageHeading,
  SectionCard,
  StatCard,
  TileCard,
  TileGrid,
  TrustStrip,
} from './nova';

export { formatAmount, formatMoney, formatScore10 } from './format';
export { describeRaising, raisingTone, RAISING_LABEL, type RaisingState } from './raising';

export { PromptDialog } from './prompt-dialog';
export { SKINS, type Skin } from './skins';

/**
 * Безопасный Markdown продуктовых текстов: подсказки, примеры, словарь, ЧАВО.
 * Один компонент для формы, предпросмотра и админки; сырого HTML нет по
 * конструкции (план 0.2 §2.6).
 */
export { Markdown, type MarkdownProps } from './markdown';
export {
  markdownToPlainText,
  parseMarkdown,
  type BlockNode,
  type InlineNode,
} from './markdown-parser';
