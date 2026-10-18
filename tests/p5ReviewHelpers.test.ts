import { describe, expect, it } from 'vitest';
import { alsoFileOnTick } from '../src/client/alsoFile';
import { capSelection } from '../src/client/bulk';
import { selectStep, type SelectState } from '../src/client/selectCommit';

describe('"Also file" ticked', () => {
  it('learns now only after a pick in this sheet; otherwise rides along with the next pick', () => {
    expect(alsoFileOnTick({ checked: true, pickedThisSession: true, categoryId: 5 })).toBe('learn-now');
    expect(alsoFileOnTick({ checked: true, pickedThisSession: false, categoryId: 5 })).toBe('with-next-pick');
    expect(alsoFileOnTick({ checked: true, pickedThisSession: true, categoryId: null })).toBe('with-next-pick');
    expect(alsoFileOnTick({ checked: false, pickedThisSession: true, categoryId: 5 })).toBe('off');
  });
});

describe('select all, capped', () => {
  it('takes at most the bulk limit and says so', () => {
    expect(capSelection([1, 2, 3], 500)).toEqual({ ids: [1, 2, 3], capped: false });
    const many = Array.from({ length: 620 }, (_, i) => i + 1);
    const res = capSelection(many, 500);
    expect(res.ids).toHaveLength(500);
    expect(res.ids[0]).toBe(1);
    expect(res.capped).toBe(true);
  });
});

describe('a native select commits on a real choice, not on each arrow step', () => {
  const start: SelectState = { pending: null, keyNav: false };
  it('commits a mouse or touch choice at once', () => {
    expect(selectStep(start, { type: 'change', value: '7' })).toEqual({ state: start, commit: '7' });
  });
  it('holds arrow-key steps until Enter or leaving the field', () => {
    let s = selectStep(start, { type: 'key', key: 'ArrowDown' }).state;
    let r = selectStep(s, { type: 'change', value: '8' });
    expect(r.commit).toBeNull();
    s = r.state;
    s = selectStep(s, { type: 'key', key: 'ArrowDown' }).state;
    r = selectStep(s, { type: 'change', value: '9' });
    expect(r.commit).toBeNull();
    expect(selectStep(r.state, { type: 'key', key: 'Enter' }).commit).toBe('9');
    expect(selectStep(r.state, { type: 'blur' }).commit).toBe('9');
  });
  it('never opens "＋ New" by arrowing past it; Enter on it does', () => {
    let s = selectStep(start, { type: 'key', key: 'ArrowDown' }).state;
    const r = selectStep(s, { type: 'change', value: '__new' });
    expect(r.commit).toBeNull();
    expect(selectStep(r.state, { type: 'blur' }).commit).toBeNull();
    s = r.state;
    expect(selectStep(s, { type: 'key', key: 'Enter' }).commit).toBe('__new');
  });
  it('a click after arrowing commits normally', () => {
    const s = selectStep(start, { type: 'key', key: 'ArrowUp' }).state;
    const down = selectStep(s, { type: 'pointer' }).state;
    expect(selectStep(down, { type: 'change', value: '3' }).commit).toBe('3');
  });
  it('nothing pending: blur and Enter do nothing', () => {
    expect(selectStep(start, { type: 'blur' }).commit).toBeNull();
    expect(selectStep(start, { type: 'key', key: 'Enter' }).commit).toBeNull();
  });
});
