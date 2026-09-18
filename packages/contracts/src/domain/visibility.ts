import { z } from 'zod';

/**
 * Аудитории раскрытия и одно правило видимости (этап 5.6.4, решение владельца
 * 2026-09-18). Модуль без зависимостей от доменных схем: его импортируют и
 * проект, и раунд, и представления заявки.
 *
 * Уровни те же, что у видимости вопроса формы (`FormVisibilitySchema`):
 * поле видно аудитории, если его видимость не строже уровня аудитории. Одно
 * правило для ответов анкеты, системных полей раунда, каталога и
 * предпросмотра; в SQL — `lab.visible_to` (M085), паритет проверяет
 * `database/tests/round-visibility.test.ts`.
 */
export const AudienceSchema = z.enum(['public', 'investors', 'platform', 'private']);
export type Audience = z.infer<typeof AudienceSchema>;

const AUDIENCE_RANK: Record<Audience, number> = {
  public: 0,
  investors: 1,
  platform: 2,
  private: 3,
};

export function visibleTo(visibility: Audience, audience: Audience): boolean {
  return AUDIENCE_RANK[visibility] <= AUDIENCE_RANK[audience];
}

/**
 * Состояние привлечения для зрителя. `undisclosed` — группа «текущий запрос»
 * (состояние, сумма, валюта) закрыта для этой аудитории настройкой видимости
 * вопроса `investment_ask`: зритель не узнаёт даже того, идёт ли привлечение.
 */
export const RaisingStateSchema = z.enum(['open', 'paused', 'none', 'undisclosed']);
export type RaisingState = z.infer<typeof RaisingStateSchema>;
