/**
 * @unicorn/cabinet — общие продуктовые блоки кабинетов и витрины.
 *
 * Чем отличается от `@unicorn/ui`: тот про форму и состояния и намеренно не
 * знает ни доменных типов, ни текстов экранов. Здесь — наоборот: блоки, у
 * которых есть предметный смысл и которые обязаны вести себя ОДИНАКОВО во всех
 * кабинетах. Четыре копии такого блока расходятся по одной за раз (проверено:
 * Ф44, ошибка сброса CSRF-токена жила в трёх кабинетах из четырёх).
 *
 * Чего здесь не должно появляться: обращений к сети. Транспорт приходит
 * функциями-портами — тогда граница «фронтенд ходит в сеть только через свой
 * клиент» видна в сигнатуре, а не держится на договорённости.
 */
export { NotificationsCard, type NotificationsPort } from './NotificationsCard';
export { BusinessEntitiesCard, type EntitiesPort } from './BusinessEntitiesCard';
export { SupportCard, type SupportPort } from './SupportCard';
export { VerificationCard, type VerificationPort, type VerificationKind } from './VerificationCard';
export { BugReportWidget, BUG_REPORT_HOTKEY_LABEL, type BugReportPort } from './BugReportWidget';
export {
  ScoreProvenance,
  SCORE_DISCLAIMER,
  publishedScore10,
  translationPending,
} from './ScoreProvenance';
export {
  decideAccess,
  cabinetsForRoles,
  hrefFor,
  CABINET_PATH,
  LOGIN_PATH,
  ROLE_TO_CABINET,
  type CabinetKey,
  type AccessDecision,
} from './access';
export {
  classifySessionFailure,
  SessionCheckFailed,
  useSessionCheck,
  type SessionFailure,
} from './session';
export { ProfilePage, ProfileAvatar, ProfileLink, type ProfilePort } from './ProfilePage';
export {
  ProjectCard,
  type ProjectCardMedia,
  type ProjectCardProps,
  type ProjectCardSource,
} from './ProjectCard';
