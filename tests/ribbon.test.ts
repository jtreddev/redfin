import { describe, expect, it } from 'vitest';
import { ribbonLayout, usableCachedRibbon } from '../src/client/ribbon';

describe('cached month ribbon', () => {
  it('is used only in the month it was made', () => {
    const cached = { partialMonth: '2026-10' };
    expect(usableCachedRibbon(cached, '2026-10-31')).toBe(cached);
    expect(usableCachedRibbon(cached, '2026-11-01')).toBeNull();
    expect(usableCachedRibbon(null, '2026-10-18')).toBeNull();
  });
});

describe('month ribbon layout', () => {
  it('scales to the usual month while spending is under it', () => {
    const r = ribbonLayout([1000, 500, 500], 4000);
    expect(r.widths).toEqual([25, 12.5, 12.5]);
    expect(r.usualAt).toBe(100);
    expect(r.total).toBe(2000);
  });

  it('scales to the spending once it passes the usual month', () => {
    const r = ribbonLayout([3000, 1000], 2000);
    expect(r.widths).toEqual([75, 25]);
    expect(r.usualAt).toBe(50);
  });

  it('draws refund months as nothing and leaves out the mark with no usual yet', () => {
    const r = ribbonLayout([-300, 600], 0);
    expect(r.widths).toEqual([0, 100]);
    expect(r.usualAt).toBeNull();
    expect(r.total).toBe(600);
  });

  it('is empty, not NaN, with nothing spent and no usual', () => {
    expect(ribbonLayout([0, 0], 0)).toEqual({ widths: [0, 0], usualAt: null, total: 0 });
  });
});
