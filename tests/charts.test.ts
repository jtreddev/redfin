import { describe, expect, it } from 'vitest';
import { barPath, dollarsShort, labelsFit, monthTick, niceMax, rangeTicks, stackLayout, ticks } from '../src/client/charts/scale';

describe('chart scale: niceMax and ticks', () => {
  it('rounds the top of the axis up to a readable step', () => {
    expect(niceMax(95_000)).toBe(100_000); // $950 → $1,000
    expect(niceMax(100_000)).toBe(100_000); // already round
    expect(niceMax(123_456)).toBe(150_000); // $1,234.56 → $1,500
    expect(niceMax(812_345)).toBe(1_000_000); // $8,123 → $10,000
    expect(niceMax(4_200)).toBe(5_000); // $42 → $50
    expect(niceMax(430_000)).toBe(500_000); // $4,300 → $5,000, not $6,000
  });

  it('never returns 0, so an empty chart still has an axis', () => {
    expect(niceMax(0)).toBeGreaterThan(0);
    expect(niceMax(-5_000)).toBeGreaterThan(0);
    expect(niceMax(1)).toBe(100); // whole dollars: $1 at least
  });

  it('ticks run from 0 to niceMax in equal whole-dollar steps', () => {
    expect(ticks(95_000)).toEqual([0, 20_000, 40_000, 60_000, 80_000, 100_000]);
    expect(ticks(123_456)).toEqual([0, 50_000, 100_000, 150_000]);
    expect(ticks(95_000, 2)).toEqual([0, 50_000, 100_000]);
    for (const max of [1, 999, 4_200, 95_000, 120_000, 123_456, 430_000, 812_345, 7_654_321]) {
      const t = ticks(max);
      expect(t[0]).toBe(0);
      expect(t.at(-1)).toBe(niceMax(max));
      expect(t.every((v) => v % 100 === 0)).toBe(true);
      expect(t.length).toBeLessThanOrEqual(6);
      // Every tick reads exactly in its short form (no $1,250 shown as "$1.3k").
      for (const v of t.filter((v) => v >= 100_000)) expect(Math.round(Number(dollarsShort(v).slice(1, -1)) * 100_000)).toBe(v);
    }
  });
});

describe('chart scale: dollarsShort', () => {
  it('whole dollars, with "k" from $1,000', () => {
    expect(dollarsShort(0)).toBe('$0');
    expect(dollarsShort(95_000)).toBe('$950');
    expect(dollarsShort(95_049)).toBe('$950');
    expect(dollarsShort(120_000)).toBe('$1.2k');
    expect(dollarsShort(100_000)).toBe('$1k');
    expect(dollarsShort(99_950)).toBe('$1k'); // rounds to $1,000, not "$1,000" or "$1.0k"
    expect(dollarsShort(1_234_500)).toBe('$12k');
    expect(dollarsShort(15_000_000)).toBe('$150k');
    expect(dollarsShort(-5_000)).toBe('-$50');
    expect(dollarsShort(-250_000)).toBe('-$2.5k');
  });
});

describe('chart layout: stackLayout', () => {
  it('stacks from the baseline up with a 2px gap between segments', () => {
    const [a, b] = stackLayout([5_000, 5_000], 100, 10_000);
    expect(a).toMatchObject({ y: 50, height: 50, top: false });
    expect(b).toMatchObject({ y: 0, height: 48, top: true });
    expect(a!.y - (b!.y + b!.height)).toBe(2);
  });

  it('negative segment drawn as zero, keeping its true value', () => {
    const segs = stackLayout([10_000, -2_000, 5_000], 100, 20_000);
    expect(segs[1]).toMatchObject({ value: -2_000, height: 0, top: false });
    expect(segs[0]).toMatchObject({ y: 50, height: 50 });
    // The refund doesn't eat into the stack: the next segment sits on the first with one 2px gap.
    expect(segs[2]).toMatchObject({ y: 25, height: 23, top: true });
  });

  it('defaults the scale to the positive total, so negatives never shrink it', () => {
    const segs = stackLayout([60_000, -50_000, 30_000], 100);
    // positive total $900 → axis $1,000
    expect(segs[0]!.height).toBe(60);
  });

  it('a tiny segment never gets a negative height from the gap', () => {
    const segs = stackLayout([10_000, 100, 10_000], 100, 40_000);
    expect(segs.every((s) => s.height >= 0)).toBe(true);
    expect(segs[1]!.height).toBe(0); // 0.25px minus the 2px gap
    expect(segs[2]).toMatchObject({ height: 23, top: true });
  });

  it('zeros: nothing drawn, nothing rounded', () => {
    const segs = stackLayout([0, 0, 0], 100, 10_000);
    expect(segs.every((s) => s.height === 0 && !s.top)).toBe(true);
  });

  it('only the topmost drawn segment gets the rounded top', () => {
    const segs = stackLayout([2_000, 3_000, 0], 100, 10_000);
    expect(segs.map((s) => s.top)).toEqual([false, true, false]);
  });
});

describe('chart layout: barPath', () => {
  it('rounds the top corners only, square at the baseline', () => {
    expect(barPath(10, 20, 24, 50, true)).toBe('M10,70V24A4,4 0 0 1 14,20H30A4,4 0 0 1 34,24V70Z');
    expect(barPath(10, 20, 24, 50, false)).toBe('M10,70V20H34V70Z');
  });

  it('a bar shorter than 4px gets a smaller radius', () => {
    expect(barPath(0, 0, 10, 2, true)).toBe('M0,2V2A2,2 0 0 1 2,0H8A2,2 0 0 1 10,2V2Z');
  });

  it('nothing for a zero-height bar', () => {
    expect(barPath(0, 0, 10, 0, true)).toBe('');
  });
});

describe('chart layout: labels and month ticks', () => {
  it('a label fits inside a segment only with room on both axes', () => {
    expect(labelsFit({ width: 40, height: 20 }, '$950')).toBe(true);
    expect(labelsFit({ width: 24, height: 20 }, '$950')).toBe(false); // too narrow
    expect(labelsFit({ width: 40, height: 10 }, '$950')).toBe(false); // too short
  });

  it('single-letter months on narrow charts, short names otherwise', () => {
    expect(monthTick('2026-01', true)).toBe('J');
    expect(monthTick('2026-01', false)).toBe('Jan');
    expect(monthTick('2026-09', false)).toBe('Sep');
  });
});

describe('chart scale: rangeTicks', () => {
  it('matches ticks when nothing is below 0', () => {
    expect(rangeTicks(40_000, 95_000)).toEqual(ticks(95_000));
  });

  it('keeps 0 on the axis and rounds both ends out to whole steps', () => {
    expect(rangeTicks(-30_000, 120_000)).toEqual([-50_000, 0, 50_000, 100_000, 150_000]);
    for (const [lo, hi] of [
      [-1, 1],
      [-250_000, -10_000],
      [-4_200, 812_345],
    ] as const) {
      const t = rangeTicks(lo, hi);
      expect(t).toContain(0);
      expect(t[0]).toBeLessThanOrEqual(lo);
      expect(t.at(-1)).toBeGreaterThanOrEqual(hi);
      expect(t.every((v) => v % 100 === 0)).toBe(true);
      expect(t.length).toBeLessThanOrEqual(7);
    }
  });
});
