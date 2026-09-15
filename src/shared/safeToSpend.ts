import type { Forecast } from './forecast';
import type { Cents } from './money';

export interface SafeToSpend {
  /** What you can still spend this week without breaking the plan. */
  safeCents: Cents;
  /** Unspent flexible budget (groceries, gas, etc.) left for this week. */
  flexibleLeftCents: Cents;
  /** Lowest projected end-of-week balance for the rest of the month, minus the low-balance line. */
  cushionCents: Cents;
  /** Money beyond the plan that could be spent without any week dipping below the low-balance line. */
  extraRoomCents: Cents;
}

/**
 * "Are we OK this week?" If a later week is projected to fall below the low-balance
 * line, that shortfall comes out of this week's flexible money first.
 */
export function safeToSpend(forecast: Forecast, lowBalanceCents: Cents): SafeToSpend {
  const t = forecast.currentWeekPosition;
  if (t === null) return { safeCents: 0, flexibleLeftCents: 0, cushionCents: 0, extraRoomCents: 0 };

  const ahead = forecast.weeks.slice(t);
  const lowest = Math.min(...ahead.map((w) => w.endBalance));
  const cushionCents = lowest - lowBalanceCents;
  const flexibleLeftCents = forecast.flexibleLeftThisWeek;
  return {
    safeCents: Math.max(0, flexibleLeftCents + Math.min(0, cushionCents)),
    flexibleLeftCents,
    cushionCents,
    extraRoomCents: Math.max(0, cushionCents),
  };
}
