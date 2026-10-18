/**
 * Geometry for Home's month ribbon: this month's spending so far, split by group, on one bar, with a mark
 * where a usual month ends. Everything is a percentage of the track. The track spans whichever is larger,
 * the spending so far or the usual month, so neither runs off the end. Negative groups (refund months)
 * draw as nothing.
 */
export interface RibbonLayout {
  /** Width of each segment, in the order given (% of the track). */
  widths: number[];
  /** Where the usual month ends (% of the track), or null with no usual yet. */
  usualAt: number | null;
  /** Spending so far (negatives count as 0). */
  total: number;
}

export function ribbonLayout(values: readonly number[], usual: number): RibbonLayout {
  const positive = values.map((v) => Math.max(0, v));
  const total = positive.reduce((sum, v) => sum + v, 0);
  const span = Math.max(total, usual, 0);
  const pct = (v: number) => (span > 0 ? Math.round((v / span) * 10000) / 100 : 0);
  return {
    widths: positive.map(pct),
    usualAt: usual > 0 ? pct(usual) : null,
    total,
  };
}
