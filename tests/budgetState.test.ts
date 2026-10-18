import { describe, expect, it } from 'vitest';
import { budgetState } from '../src/client/budgetState';

describe('budget row state in words', () => {
  it('says nothing while comfortably under budget, or with nothing budgeted or spent', () => {
    expect(budgetState(5000, 10000)).toBeNull();
    expect(budgetState(9000, 10000)).toBeNull();
    expect(budgetState(0, 0)).toBeNull();
  });

  it('warns past 90% of the budget', () => {
    expect(budgetState(9001, 10000)).toEqual({ tone: 'warn', text: 'Almost all used' });
    expect(budgetState(10000, 10000)).toEqual({ tone: 'warn', text: 'Almost all used' });
  });

  it('says how far over', () => {
    expect(budgetState(16500, 16000)).toEqual({ tone: 'bad', text: 'Over by $5' });
  });

  it('flags spending with no budget', () => {
    expect(budgetState(2300, 0)).toEqual({ tone: 'warn', text: 'No budget set' });
  });
});
