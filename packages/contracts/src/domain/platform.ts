import { z } from 'zod';
import { IsoDateTimeSchema } from '../common/primitives';

/**
 * Флаги функций и скин платформы.
 *
 * Прежде жили в контрактах заявки и биллинга; эти контракты удалены вместе с
 * инвестиционным процессом (2.1-W05), а флаги и скин — общие для платформы.
 */

export const FeatureFlagSchema = z.object({
  key: z.string(),
  enabled: z.boolean(),
  rules: z.record(z.string(), z.unknown()),
  updatedAt: IsoDateTimeSchema,
});
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;

export const UpdateFeatureFlagRequestSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(500),
});
export type UpdateFeatureFlagRequest = z.infer<typeof UpdateFeatureFlagRequestSchema>;

/**
 * Флаги, которые кабинеты читают без входа. Строгий allowlist: остальные
 * флаги — состояние платформы, а не интерфейса, и наружу не отдаются. Сейчас
 * таких нет: прежние (`lab.ui.application_v2`, `seasons.enabled`) удалены.
 */
export const PUBLIC_FEATURE_KEYS: readonly string[] = [];

/**
 * Скины платформы — значения атрибута `data-brand` у интерфейсов.
 *
 * Список должен совпадать со `SKINS` в `packages/ui/src/skins.ts`: пакет
 * интерфейса от контрактов не зависит, поэтому сверку делает каталог
 * `/admin/ui` и показывает расхождение на странице.
 */
export const SKIN_IDS = ['base', 'nova'] as const;
export type SkinId = (typeof SKIN_IDS)[number];

/**
 * Скин, пока выбор не сохранён (первый запуск) или сохранённое значение не
 * входит в `SKIN_IDS`. Совпадает с атрибутом `data-brand` в `index.html`
 * интерфейсов — поэтому при недоступной настройке ничего не меняется.
 */
export const DEFAULT_SKIN: SkinId = 'nova';

/** Ключ флага платформы со скином (M145); значение — `rules.value`. */
export const UI_SKIN_FLAG = 'ui.skin';

export const FeaturesSchema = z.object({
  flags: z.record(z.string(), z.boolean()),
  /** Скин всей платформы: флаг `ui.skin` (значение в `rules.value`). */
  skin: z.enum(SKIN_IDS),
});
export type Features = z.infer<typeof FeaturesSchema>;

/** Применить скин для всей платформы. Причина — как у любого флага платформы. */
export const SetUiSkinRequestSchema = z.object({
  skin: z.enum(SKIN_IDS),
  reason: z.string().trim().min(3).max(500),
});
export type SetUiSkinRequest = z.infer<typeof SetUiSkinRequestSchema>;

export const UiSkinSchema = z.object({
  skin: z.enum(SKIN_IDS),
  updatedAt: z.string(),
});
export type UiSkin = z.infer<typeof UiSkinSchema>;
