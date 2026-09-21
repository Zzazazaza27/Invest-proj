import { z } from 'zod';

/**
 * Тестовые сессии: договор между админкой, кабинетами и ядром.
 *
 * Здесь же — контекст доступа. Он описан рядом с сессиями намеренно: это
 * один механизм, и разнесение по разным файлам однажды привело бы к двум
 * несогласованным представлениям об одном и том же.
 */

/** Состояние сессии. Итог проверки — отдельно: это разные вопросы. */
export const TestingSessionStatusSchema = z.enum([
  'active',
  'finished',
  'cleaning',
  'cleaned',
  'clean_failed',
]);
export type TestingSessionStatus = z.infer<typeof TestingSessionStatusSchema>;

export const TestingSessionResultSchema = z.enum(['unknown', 'passed', 'failed']);
export type TestingSessionResult = z.infer<typeof TestingSessionResultSchema>;

export const TestingSessionSourceSchema = z.enum(['manual', 'automated']);

/** Вид контекста доступа. `guest` — без личности вовсе. */
export const AccessContextKindSchema = z.enum(['participant', 'readonly', 'guest']);
export type AccessContextKind = z.infer<typeof AccessContextKindSchema>;

export const TestingParticipantSchema = z.object({
  userId: z.string().uuid(),
  role: z.string(),
  label: z.string(),
  displayName: z.string(),
  status: z.string(),
});
export type TestingParticipant = z.infer<typeof TestingParticipantSchema>;

export const TestingStepSchema = z.object({
  ordinal: z.number().int().positive(),
  name: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  actor: z.string().nullable(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
  createdAt: z.string(),
});
export type TestingStep = z.infer<typeof TestingStepSchema>;

export const TestingSessionSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  source: TestingSessionSourceSchema,
  status: TestingSessionStatusSchema,
  result: TestingSessionResultSchema,
  environment: z.string(),
  scenarioId: z.string().nullable(),
  codeVersion: z.string().nullable(),
  cleanupError: z.string().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  finishedAt: z.string().nullable(),
  cleanedAt: z.string().nullable(),
});
export type TestingSession = z.infer<typeof TestingSessionSchema>;

export const TestingSessionCardSchema = z.object({
  session: TestingSessionSchema,
  participants: z.array(TestingParticipantSchema),
  steps: z.array(TestingStepSchema),
  objects: z.array(z.object({ table: z.string(), count: z.number().int().nonnegative() })),
});
export type TestingSessionCard = z.infer<typeof TestingSessionCardSchema>;

export const TestingSessionListSchema = z.object({ sessions: z.array(TestingSessionSchema) });

export const CreateTestingSessionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  source: TestingSessionSourceSchema.optional(),
  scenarioId: z.string().trim().min(1).max(120).nullish(),
  codeVersion: z.string().trim().min(1).max(80).nullish(),
  withStandardCast: z.boolean().optional(),
});

/** Что уберёт очистка: показ обязателен до применения. */
export const CleanupPlanSchema = z.object({
  plan: z.array(
    z.object({
      table: z.string(),
      count: z.number().int().nonnegative(),
      /** `mark` — пометка удалённым: строку человека физически удалить нельзя. */
      mode: z.enum(['delete', 'mark']),
    }),
  ),
});

export const CleanupResultSchema = z.object({
  deleted: z.number().int().nonnegative(),
  marked: z.number().int().nonnegative(),
});

export const OpenedContextSchema = z.object({
  contextId: z.string().uuid(),
  expiresAt: z.string(),
});
export type OpenedContext = z.infer<typeof OpenedContextSchema>;

/** Что показывает плашка в тестовой вкладке. */
export const CurrentContextSchema = z.object({
  id: z.string().uuid(),
  kind: AccessContextKindSchema,
  sessionId: z.string().uuid().nullable(),
  subjectUserId: z.string().uuid().nullable(),
  readOnly: z.boolean(),
});
export type CurrentContext = z.infer<typeof CurrentContextSchema>;

/** Подписи состояний: список и карточка обязаны называть одно одинаково. */
export const TESTING_STATUS_LABEL: Record<TestingSessionStatus, string> = {
  active: 'идёт',
  finished: 'завершена',
  cleaning: 'убирается',
  cleaned: 'убрана',
  clean_failed: 'уборка не удалась',
};

export const TESTING_RESULT_LABEL: Record<TestingSessionResult, string> = {
  unknown: 'без итога',
  passed: 'успех',
  failed: 'падение',
};
