import type { Timing } from './allocation';

/**
 * Starter budget amounts, from the original spreadsheet's sample month (second-home
 * lines removed, a few kids lines added), summed into the current categories. Lines that
 * merged bills with different due days are spread evenly. They're placeholders to adjust,
 * not advice. Card paydowns are transfers now, so they have no line.
 */
export const SUGGESTED_BUDGET: { section: string; category: string; dollars: number; timing: Timing; dueDay?: number }[] = [
  { section: 'Bills', category: 'Housing', dollars: 1600, timing: 'due_day', dueDay: 1 },
  // Electric 165, natural gas 55, water 70, trash 35.
  { section: 'Bills', category: 'Utilities', dollars: 325, timing: 'even' },
  { section: 'Bills', category: 'Internet', dollars: 75, timing: 'due_day', dueDay: 8 },
  { section: 'Bills', category: 'Phone', dollars: 200, timing: 'due_day', dueDay: 22 },
  { section: 'Bills', category: 'Loans', dollars: 200, timing: 'due_day', dueDay: 10 },
  // Auto 160, health premium 600.
  { section: 'Bills', category: 'Insurance', dollars: 760, timing: 'even' },
  // Streaming 75, fitness 60.
  { section: 'Bills', category: 'Subscriptions', dollars: 135, timing: 'even' },
  { section: 'Everyday', category: 'Groceries', dollars: 1200, timing: 'even' },
  { section: 'Everyday', category: 'Gas', dollars: 200, timing: 'even' },
  { section: 'Everyday', category: 'Car Upkeep', dollars: 90, timing: 'even' },
  // Household goods 120, pets 90.
  { section: 'Everyday', category: 'Household & Personal', dollars: 210, timing: 'even' },
  { section: 'Everyday', category: 'Medical', dollars: 120, timing: 'even' },
  // School 100, clothing 100, activities 100.
  { section: 'Everyday', category: 'Kids', dollars: 300, timing: 'even' },
  { section: 'Fun & Wants', category: 'Eating Out', dollars: 200, timing: 'even' },
  { section: 'Fun & Wants', category: 'Shopping', dollars: 100, timing: 'even' },
  { section: 'Fun & Wants', category: 'Gifts', dollars: 80, timing: 'even' },
  // Emergency fund 400, Roth 500.
  { section: 'Saving', category: 'Savings & Planned Costs', dollars: 900, timing: 'due_day', dueDay: 5 },
];
