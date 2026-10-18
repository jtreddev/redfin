import { money } from './format';

/**
 * The words behind a budget row's amber or red bar, so its state never rests on color alone
 * (the same thresholds as Progress: over the budget, or past 90% of it).
 */
export function budgetState(actualCents: number, budgetCents: number): { tone: 'warn' | 'bad'; text: string } | null {
  if (budgetCents <= 0) return actualCents > 0 ? { tone: 'warn', text: 'No budget set' } : null;
  if (actualCents > budgetCents) return { tone: 'bad', text: `Over by ${money(actualCents - budgetCents, { whole: true })}` };
  if (actualCents / budgetCents > 0.9) return { tone: 'warn', text: 'Almost all used' };
  return null;
}
