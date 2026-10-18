import { describe, expect, it } from 'vitest';
import {
  activityQueryString,
  EMPTY_FILTERS,
  effectiveMonth,
  hasFilters,
  parseActivityParams,
  transactionsQuery,
} from '../src/shared/activityQuery';
import { categoryRules, categoryTree, mergeTargets, moveId, moveItem, pickerOptions, possibleParents } from '../src/client/categoryTree';
import { transactionsCsv } from '../src/client/csvExport';
import { describeSearch, resultSummary } from '../src/client/searchHelp';
import { isTyping, shortcutFor, step } from '../src/client/shortcuts';
import type { Category, Transaction } from '../src/client/types';

describe('search help', () => {
  it('says what an amount, a size and words look for', () => {
    expect(describeSearch('45')).toBe('Amounts $45.00 to $45.99, in or out, or text with “45”');
    expect(describeSearch('$45.12')).toBe('Amounts of $45.12, in or out, or text with “$45.12”');
    expect(describeSearch('>100')).toBe('$100.01 or more');
    expect(describeSearch('shell <20')).toBe('Text with “shell”, $19.99 or less');
    expect(describeSearch('>=10 <=20')).toBe('Sized $10.00 to $20.00');
    expect(describeSearch('   ')).toBeNull();
  });

  it('summarises the server totals', () => {
    expect(resultSummary({ count: 23, outCents: 41260, inCents: 0 })).toBe('23 charges · $412.60 out · $0 in');
    expect(resultSummary({ count: 1, outCents: 0, inCents: 1250 })).toBe('1 charge · $0.00 out · $12.50 in');
  });
});

describe('Activity filters in the URL', () => {
  it('round-trips and reads older links', () => {
    const f = parseActivityParams('q=shell&month=2026-09&categoryId=3,5&account=2&kid=4&needs=1&private=1&leftOut=1');
    expect(f).toMatchObject({ q: 'shell', month: '2026-09', categoryIds: [3, 5], accountId: 2, kidId: 4, needsLook: true, private: true, leftOut: true });
    expect(parseActivityParams(activityQueryString(f))).toEqual(f);
    expect(parseActivityParams('filter=uncategorized&category=7&month=bogus')).toMatchObject({ needsLook: true, categoryIds: [7], month: null });
    expect(parseActivityParams('categoryId=3&categoryId=3,x,0')).toMatchObject({ categoryIds: [3] });
  });

  it('defaults to All time while searching and this month otherwise', () => {
    expect(effectiveMonth(EMPTY_FILTERS, '2026-10')).toBe('2026-10');
    expect(effectiveMonth({ ...EMPTY_FILTERS, q: 'shell' }, '2026-10')).toBeNull();
    expect(effectiveMonth({ ...EMPTY_FILTERS, q: 'shell', month: '2026-08' }, '2026-10')).toBe('2026-08');
    expect(effectiveMonth({ ...EMPTY_FILTERS, month: 'all' }, '2026-10')).toBeNull();
  });

  it('builds the server query', () => {
    const qs = transactionsQuery({ ...EMPTY_FILTERS, q: ' 45 ', categoryIds: [3, 5], leftOut: true, needsLook: true }, '2026-10');
    expect(Object.fromEntries(qs)).toEqual({ q: '45', categoryId: '3,5', ignored: 'only', uncategorized: '1' });
    expect(hasFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasFilters({ ...EMPTY_FILTERS, month: '2026-01' })).toBe(false);
    expect(hasFilters({ ...EMPTY_FILTERS, kidId: 1 })).toBe(true);
  });
});

describe('keyboard shortcuts', () => {
  const input = { tagName: 'INPUT', type: 'search' };
  it('fire on plain keys outside fields', () => {
    expect(shortcutFor({ key: '/' })).toBe('search');
    expect(shortcutFor({ key: 'j', target: { tagName: 'BUTTON' } })).toBe('next');
    expect(shortcutFor({ key: 'k' })).toBe('previous');
    expect(shortcutFor({ key: 'c' })).toBe('category');
    expect(shortcutFor({ key: 'x', target: { tagName: 'INPUT', type: 'checkbox' } })).toBe('select');
    expect(shortcutFor({ key: 'u' })).toBe('undo');
    expect(shortcutFor({ key: '?' })).toBe('help');
    expect(shortcutFor({ key: 'q' })).toBeNull();
  });

  it('never fire while typing or with a modifier', () => {
    expect(shortcutFor({ key: 'j', target: input })).toBeNull();
    expect(shortcutFor({ key: '/', target: { tagName: 'TEXTAREA' } })).toBeNull();
    expect(shortcutFor({ key: 'c', target: { tagName: 'SELECT' } })).toBeNull();
    expect(shortcutFor({ key: 'u', target: { tagName: 'DIV', isContentEditable: true } })).toBeNull();
    expect(shortcutFor({ key: 'c', ctrlKey: true })).toBeNull();
    expect(shortcutFor({ key: 'j', metaKey: true })).toBeNull();
    expect(shortcutFor({ key: 'u', altKey: true })).toBeNull();
    expect(isTyping({ tagName: 'INPUT' })).toBe(true);
    expect(isTyping({ tagName: 'INPUT', type: 'radio' })).toBe(false);
    expect(isTyping(null)).toBe(false);
  });

  it('j and k stay inside the list', () => {
    expect(step(-1, 3, 'next')).toBe(0);
    expect(step(-1, 3, 'previous')).toBe(2);
    expect(step(2, 3, 'next')).toBe(2);
    expect(step(0, 3, 'previous')).toBe(0);
    expect(step(1, 3, 'next')).toBe(2);
    expect(step(0, 0, 'next')).toBe(-1);
  });
});

const sections = [
  { id: 1, name: 'Bills', sort: 20 },
  { id: 2, name: 'Habits', sort: 30 },
  { id: 3, name: 'Income', sort: 10 },
];
let nextId = 1;
function c(sectionId: number, name: string, extra: Partial<Category> = {}): Category {
  const section = sections.find((s) => s.id === sectionId)!;
  return { id: nextId++, sectionId, sectionName: section.name, parentId: null, name, kind: 'expense', kidScoped: false, funMemberId: null, archived: false, sort: 10, ...extra };
}

describe('reordering and nesting categories', () => {
  it('moves items and refuses to fall off the ends', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
    expect(moveId([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
    expect(moveId([1, 2, 3], 1, -1)).toBeNull();
    expect(moveId([1, 2, 3], 3, 1)).toBeNull();
    expect(moveId([1, 2, 3], 9, 1)).toBeNull();
  });

  it('builds the tree in group order, children under parents, hidden ones only when asked', () => {
    nextId = 1;
    const habits = c(2, 'Habits', { sort: 10 });
    const cigs = c(2, 'Cigarettes', { parentId: habits.id, sort: 20 });
    const snacks = c(2, 'Snacks', { parentId: habits.id, sort: 10 });
    const phone = c(1, 'Phone', { sort: 20 });
    const rent = c(1, 'Rent', { sort: 10 });
    const old = c(1, 'Old', { archived: true });
    const pay = c(3, 'Paychecks', { kind: 'income' });
    const all = [habits, cigs, snacks, phone, rent, old, pay];
    const tree = categoryTree(sections, all, (x) => !x.archived);
    expect(tree.map((g) => g.section.name)).toEqual(['Income', 'Bills', 'Habits']);
    expect(tree[1]!.nodes.map((n) => n.category.name)).toEqual(['Rent', 'Phone']);
    expect(tree[2]!.nodes[0]!.children.map((k) => k.name)).toEqual(['Snacks', 'Cigarettes']);
    expect(pickerOptions(tree)[2]!.options.map((o) => `${o.depth}${o.category.name}`)).toEqual(['0Habits', '1Snacks', '1Cigarettes']);
    // A child whose parent is left out shows at the top level.
    const orphan = categoryTree(sections, all, (x) => x.name !== 'Habits');
    expect(orphan.find((g) => g.section.name === 'Habits')!.nodes.map((n) => n.category.name)).toEqual(['Snacks', 'Cigarettes']);
  });

  it('says what a special, a parent and a fun money category can’t do', () => {
    nextId = 1;
    const habits = c(2, 'Habits');
    const kid = c(2, 'Snacks', { parentId: habits.id });
    const vape = c(2, 'Vape');
    const fun = c(2, 'Sam’s Fun Money', { funMemberId: 1 });
    const all = [habits, kid, vape, fun];
    const special = categoryRules(habits, all);
    expect(special.rename).toMatch(/by name/);
    expect(special.nest).toMatch(/stays a top-level/);
    expect(special.merge).toMatch(/can’t be merged/);
    expect(special.hide).toMatch(/can’t be hidden/);
    expect(categoryRules(kid, all).moveGroup).toMatch(/out of its parent/);
    expect(categoryRules(vape, all)).toEqual({ rename: null, moveGroup: null, nest: null, merge: null, hide: null });
    expect(categoryRules(fun, all).merge).toMatch(/Fun money/);
    expect(possibleParents(vape, all).map((p) => p.name)).toEqual(['Habits']);
    expect(mergeTargets(habits, all).map((t) => t.name)).toEqual(['Vape']);
    expect(mergeTargets(vape, all).map((t) => t.name)).toEqual(['Habits', 'Snacks']);
  });
});

describe('CSV of the results', () => {
  it('names categories and kids, and defuses formulas', () => {
    nextId = 1;
    const parent = c(1, 'Phone');
    const child = c(1, 'Mobile', { parentId: parent.id });
    const t = {
      id: 1,
      date: '2026-10-05',
      accountName: 'Card',
      name: '=HYPERLINK("x")',
      merchantName: 'Phone Co',
      amountCents: -4512,
      categoryId: child.id,
      kidId: 2,
      notes: null,
      isPrivate: false,
      isIgnored: false,
      pending: false,
      isSplit: false,
      splits: [],
    } as unknown as Transaction;
    const csv = transactionsCsv([t], [parent, child], [{ id: 2, name: 'Ava', color: '#000', birthDate: null, sort: 10 }]);
    const lines = csv.replace('﻿', '').split('\r\n');
    expect(lines[1]).toBe(`2026-10-05,Card,"'=HYPERLINK(""x"")",Phone Co,-45.12,Mobile,Phone,Ava,,,,,`);
  });
});
