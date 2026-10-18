/**
 * Pure scale and layout helpers for the hand-written SVG charts. Amounts are cents; axes are whole dollars.
 */

/** Cents in a dollar; every tick is a whole number of dollars. */
const DOLLAR = 100;
/** An empty chart still gets an axis up to $100. */
const EMPTY_MAX = 100 * DOLLAR;

/** The smallest readable step (1, 2 or 5 × 10ⁿ whole dollars) at least `raw` cents. */
function niceStep(raw: number): number {
  let magnitude = DOLLAR;
  while (magnitude * 10 <= raw) magnitude *= 10;
  for (const m of [1, 2, 5]) if (magnitude * m >= raw) return magnitude * m;
  return magnitude * 10;
}

/**
 * Axis ticks from 0 up to a readable top at or above `max`: the smallest step that covers `max` in at most
 * `count + 1` steps, so the top sits close above the data. Steps are 1, 2 or 5 × 10ⁿ dollars (never 2.5, whose
 * ticks like $1,250 would read as "$1.3k").
 */
export function ticks(max: number, count = 4): number[] {
  const top = max > 0 ? max : EMPTY_MAX;
  const step = niceStep(top / (count + 1));
  const steps = Math.ceil(top / step);
  return Array.from({ length: steps + 1 }, (_, i) => i * step);
}

/** The top of the axis: `max` rounded up to a readable step (never 0). */
export function niceMax(max: number): number {
  return ticks(max).at(-1)!;
}

/**
 * Axis ticks for a domain that can go below 0 (a cash balance): 0 is always on the axis, the ends round out
 * to whole steps (1, 2 or 5 × 10ⁿ dollars) and there are at most `count + 2` steps in all.
 */
export function rangeTicks(lo: number, hi: number, count = 4): number[] {
  const low = Math.min(0, lo);
  const high = Math.max(0, hi);
  if (low === 0) return ticks(high, count);
  const step = niceStep((high - low) / (count + 1));
  const first = Math.floor(low / step);
  const last = Math.max(1, Math.ceil(high / step));
  return Array.from({ length: last - first + 1 }, (_, i) => (first + i) * step);
}

/** "$950", "$1.2k", "$12k": whole dollars, compact from $1,000. */
export function dollarsShort(cents: number): string {
  const dollars = Math.round(Math.abs(cents) / DOLLAR);
  const sign = cents < 0 && dollars > 0 ? '-' : '';
  if (dollars < 1000) return `${sign}$${dollars}`;
  const tenths = Math.round(dollars / 100) / 10;
  const k = tenths < 10 ? String(tenths) : String(Math.round(dollars / 1000));
  return `${sign}$${k}k`;
}

export interface Segment {
  /** The true value (may be negative: a refund month). */
  value: number;
  /** Top edge, in SVG coordinates (0 = top of the plot). */
  y: number;
  height: number;
  /** The topmost drawn segment: it gets the rounded top. */
  top: boolean;
}

/**
 * Lays out one stacked bar in a plot `height` px tall scaled to `max` (default: the readable top above the
 * positive total). Negative values are drawn as 0 and take no room; segments above a drawn one leave a
 * `gap` px surface gap beneath them, never going below 0 px.
 */
export function stackLayout(values: readonly number[], height: number, max?: number, gap = 2): Segment[] {
  const scaleMax = max ?? niceMax(values.reduce((sum, v) => sum + Math.max(0, v), 0));
  const px = (v: number) => (Math.max(0, v) / scaleMax) * height;
  let stacked = 0;
  let drawnBelow = false;
  const segments = values.map((value): Segment => {
    const bottom = height - stacked - (drawnBelow ? gap : 0);
    stacked += px(value);
    const y = height - stacked;
    const h = Math.max(0, bottom - y);
    if (h > 0) drawnBelow = true;
    return { value, y, height: h, top: false };
  });
  const last = segments.findLastIndex((s) => s.height > 0);
  if (last >= 0) segments[last]!.top = true;
  return segments;
}

const n = (v: number) => +v.toFixed(2);

/** A bar from (x, y) w × h: the top corners rounded (radius ≤ 4) when `roundTop`, square at the baseline. */
export function barPath(x: number, y: number, w: number, h: number, roundTop: boolean): string {
  if (h <= 0 || w <= 0) return '';
  const r = roundTop ? Math.min(4, h, w / 2) : 0;
  const bottom = n(y + h);
  if (r === 0) return `M${n(x)},${bottom}V${n(y)}H${n(x + w)}V${bottom}Z`;
  return (
    `M${n(x)},${bottom}V${n(y + r)}A${n(r)},${n(r)} 0 0 1 ${n(x + r)},${n(y)}` +
    `H${n(x + w - r)}A${n(r)},${n(r)} 0 0 1 ${n(x + w)},${n(y + r)}V${bottom}Z`
  );
}

/** Whether `text` fits inside a box with padding (an estimate for the system sans at `fontSize`). */
export function labelsFit(box: { width: number; height: number }, text: string, fontSize = 11): boolean {
  return text.length * fontSize * 0.6 + 8 <= box.width && fontSize + 4 <= box.height;
}

const monthShort = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

/** "Jan", or "J" on narrow charts. */
export function monthTick(month: string, narrow: boolean): string {
  const name = monthShort.format(new Date(`${month}-01T12:00:00Z`));
  return narrow ? name.charAt(0) : name;
}
