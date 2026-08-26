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
  Skeleton,
  Spinner,
  Stack,
  UI_KEYFRAMES,
  type ButtonProps,
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

export { PromptDialog } from './prompt-dialog';
