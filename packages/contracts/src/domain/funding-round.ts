import { z } from 'zod';
import {
  boundedString,
  IsoDateTimeSchema,
  MoneyAmountSchema,
  UuidSchema,
} from '../common/primitives';
import {
  ApplicationAnswersSchema,
  ApplicationEvidenceSchema,
  FundingScopeSchema,
} from './application';
import { RaisingStateSchema, type RaisingState } from './visibility';

/**
 * Раунд привлечения (план 0.2 §0г, заявка-03 §2.5; таблица M081).
 *
 * Раунд — конкретное привлечение: сумма, условия и основание в виде поданной
 * версии профиля. Он отделён от заявки и её версий: профиль живёт без раунда,
 * версия профиля не создаёт раунд, раунд не переписывает снимок. Всё
 * коммерческое (пакеты, оплата, учёт бесплатной границы) — не здесь.
 */

export const FundingRoundStatusSchema = z.enum(['draft', 'open', 'paused', 'closed', 'cancelled']);
export type FundingRoundStatus = z.infer<typeof FundingRoundStatusSchema>;

/**
 * Три состояния привлечения для тизера и фильтров (план 0.2 §0г.2 п.9):
 * «раунд открыт», «привлечение приостановлено», «сейчас не привлекает».
 * Приостановленный раунд — не активный поиск денег, и одним `true` их не
 * смешивают.
 */
/**
 * Проекция раунда для зрителя — то, что о раунде отдаётся наружу. Две
 * связанные группы: «текущий запрос» (состояние + сумма + валюта; видимость
 * вопроса `investment_ask`) и «предмет финансирования» (`funding_scope`;
 * пояснение — только вместе с предметом и по видимости `funding_scope_note`).
 * Остальные поля раунда (формат сделки, чек, подтверждённое) наружу не
 * отдаются: у них нет вопроса формы, а значит и настройки раскрытия.
 */
export const RoundProjectionSchema = z.object({
  raising: RaisingStateSchema,
  investmentAsk: MoneyAmountSchema.nullable(),
  askCurrency: z.string().nullable(),
  fundingScope: FundingScopeSchema.nullable(),
  fundingScopeNote: z.string().nullable(),
});
export type RoundProjection = z.infer<typeof RoundProjectionSchema>;

export function raisingState(
  round: { status: FundingRoundStatus } | null | undefined,
): RaisingState {
  if (!round) return 'none';
  if (round.status === 'open') return 'open';
  if (round.status === 'paused') return 'paused';
  return 'none';
}

export const InvestorModeSchema = z.enum(['single', 'multiple', 'either']);
export type InvestorMode = z.infer<typeof InvestorModeSchema>;

/** Закрытие ≠ поступление денег: причина со слов основателя. */
export const RoundCloseReasonSchema = z.enum([
  'completed',
  'partially_funded',
  'not_funded',
  'withdrawn',
]);
export type RoundCloseReason = z.infer<typeof RoundCloseReasonSchema>;

/** Подтверждённая сумма может быть нулём; иначе — как MoneyAmountSchema. */
const NonNegativeAmountSchema = z.string().regex(/^\d{1,14}(\.\d{1,2})?$/, 'сумма');

/** Код валюты ISO 4217; допустимые значения задаёт политика страны обслуживания. */
export const RoundCurrencySchema = z.string().regex(/^[A-Z]{3}$/, 'код валюты');

/** Разрешённые переходы статусов; терминальные — closed и cancelled. */
export const FUNDING_ROUND_TRANSITIONS: Record<FundingRoundStatus, readonly FundingRoundStatus[]> =
  {
    draft: ['open', 'cancelled'],
    open: ['paused', 'closed', 'cancelled'],
    paused: ['open', 'closed', 'cancelled'],
    closed: [],
    cancelled: [],
  };

export const FundingRoundSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  /** Основание — поданная версия профиля; NULL только у черновика. */
  applicationVersionId: UuidSchema.nullable(),
  /** Версия конфигурации формы для вопросов раунда; не зависит от основания. */
  schemaVersion: z.number().int().nonnegative(),
  status: FundingRoundStatusSchema,
  fundingScope: FundingScopeSchema.nullable(),
  fundingScopeNote: z.string().nullable(),
  target: MoneyAmountSchema.nullable(),
  currency: RoundCurrencySchema.nullable(),
  investorMode: InvestorModeSchema.nullable(),
  ticketMin: MoneyAmountSchema.nullable(),
  ticketMax: MoneyAmountSchema.nullable(),
  /** Подтверждено со слов основателя; предварительный интерес инвесторов сюда не входит. */
  committed: NonNegativeAmountSchema,
  committedSource: z.literal('self_reported'),
  answers: ApplicationAnswersSchema,
  evidence: ApplicationEvidenceSchema,
  /** Страна и версия условий, применённые при открытии — снимок, не ссылка на текущее. */
  serviceCountry: z.string().nullable(),
  policyVersion: z.number().int().positive().nullable(),
  closeReason: RoundCloseReasonSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  openedAt: IsoDateTimeSchema.nullable(),
  pausedAt: IsoDateTimeSchema.nullable(),
  closedAt: IsoDateTimeSchema.nullable(),
  cancelledAt: IsoDateTimeSchema.nullable(),
});
export type FundingRound = z.infer<typeof FundingRoundSchema>;

/**
 * Готовность раунда — отдельный показатель, не часть полноты профиля
 * (план 0.2 §0г.2 п.9, заявка-03 §2.6). `missing` — что не хватает для
 * открытия: системные поля раунда и обязательные вопросы раздела раунда.
 */
export const FundingRoundReadinessSchema = z.object({
  canOpen: z.boolean(),
  missing: z.array(z.object({ path: z.string(), message: z.string() })),
  percent: z.number().int().min(0).max(100),
});
export type FundingRoundReadiness = z.infer<typeof FundingRoundReadinessSchema>;

/**
 * Открытие раунда (5.7.3): владелец видел предпросмотр раскрытия по активной
 * версии условий и подтверждает именно её; смена версии между предпросмотром
 * и открытием — 409, повторный просмотр.
 */
export const OpenFundingRoundRequestSchema = z.object({
  confirmDisclosureVersion: z.number().int().nonnegative(),
});
export type OpenFundingRoundRequest = z.infer<typeof OpenFundingRoundRequestSchema>;

export const FundingRoundDetailSchema = z.object({
  round: FundingRoundSchema,
  readiness: FundingRoundReadinessSchema,
});
export type FundingRoundDetail = z.infer<typeof FundingRoundDetailSchema>;

export const FundingRoundBasisHistoryEntrySchema = z.object({
  id: UuidSchema,
  roundId: UuidSchema,
  fromVersionId: UuidSchema.nullable(),
  toVersionId: UuidSchema,
  changedBy: UuidSchema.nullable(),
  changedAt: IsoDateTimeSchema,
  reason: z.string(),
});
export type FundingRoundBasisHistoryEntry = z.infer<typeof FundingRoundBasisHistoryEntrySchema>;

// ------------------------------------------------------------ запросы

/** Черновик раунда создаётся пустым; основание можно указать сразу или позже. */
export const CreateFundingRoundRequestSchema = z.object({
  applicationVersionId: UuidSchema.optional(),
});
export type CreateFundingRoundRequest = z.infer<typeof CreateFundingRoundRequestSchema>;

/**
 * Частичное сохранение, как у заявки: `null` очищает поле, отсутствие не
 * трогает; ответы и подтверждения сливаются по ключам.
 */
export const UpdateFundingRoundRequestSchema = z.object({
  fundingScope: FundingScopeSchema.nullable().optional(),
  fundingScopeNote: boundedString(0, 200).nullable().optional(),
  target: MoneyAmountSchema.nullable().optional(),
  currency: RoundCurrencySchema.nullable().optional(),
  investorMode: InvestorModeSchema.nullable().optional(),
  ticketMin: MoneyAmountSchema.nullable().optional(),
  ticketMax: MoneyAmountSchema.nullable().optional(),
  committed: NonNegativeAmountSchema.optional(),
  answers: ApplicationAnswersSchema.optional(),
  evidence: ApplicationEvidenceSchema.optional(),
});
export type UpdateFundingRoundRequest = z.infer<typeof UpdateFundingRoundRequestSchema>;

/** Смена основания — тем же раундом, с историей (заявка-03 §2.5). */
export const ChangeFundingRoundBasisRequestSchema = z.object({
  applicationVersionId: UuidSchema,
  reason: boundedString(3, 500),
});
export type ChangeFundingRoundBasisRequest = z.infer<typeof ChangeFundingRoundBasisRequestSchema>;

export const CloseFundingRoundRequestSchema = z.object({
  closeReason: RoundCloseReasonSchema,
});
export type CloseFundingRoundRequest = z.infer<typeof CloseFundingRoundRequestSchema>;
