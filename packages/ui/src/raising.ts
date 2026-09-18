import { formatMoney } from './format';

/**
 * Состояние привлечения в карточках и списках (план 0.2 §0г.2 п.9).
 *
 * Источник — раунд и его состояние, не сумма старой формы в кеше проекта.
 * Три состояния показываются по-разному, чтобы «привлечение приостановлено»
 * не читалось как активный сбор. Пакет не знает доменных типов: на вход —
 * три строки, на выход — подпись.
 */
export type RaisingState = 'open' | 'paused' | 'none';

export const RAISING_LABEL: Record<RaisingState, string> = {
  open: 'Раунд открыт',
  paused: 'Привлечение приостановлено',
  none: 'Сейчас не привлекает инвестиции',
};

export function describeRaising(input: {
  raising: RaisingState;
  investmentAsk: string | null;
  askCurrency?: string;
}): string {
  if (input.raising === 'none' || input.investmentAsk === null) return RAISING_LABEL.none;
  const money = formatMoney(input.investmentAsk, input.askCurrency ?? 'RUB');
  return input.raising === 'open' ? money : `${RAISING_LABEL.paused} · ${money}`;
}

export function raisingTone(raising: RaisingState): 'success' | 'warning' | 'neutral' {
  return raising === 'open' ? 'success' : raising === 'paused' ? 'warning' : 'neutral';
}
