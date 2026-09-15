import type { Timing } from './allocation';

/**
 * Starter budget amounts, from the original spreadsheet's sample month (second-home
 * lines removed, a few kids lines added). They're placeholders to adjust, not advice.
 */
export const SUGGESTED_BUDGET: { section: string; category: string; dollars: number; timing: Timing; dueDay?: number }[] = [
  { section: 'Housing', category: 'Mortgage / Rent', dollars: 1600, timing: 'due_day', dueDay: 1 },
  { section: 'Utilities', category: 'Electric', dollars: 165, timing: 'due_day', dueDay: 12 },
  { section: 'Utilities', category: 'Natural Gas', dollars: 55, timing: 'due_day', dueDay: 12 },
  { section: 'Utilities', category: 'Water / Sewer', dollars: 70, timing: 'due_day', dueDay: 20 },
  { section: 'Utilities', category: 'Trash', dollars: 35, timing: 'due_day', dueDay: 20 },
  { section: 'Utilities', category: 'Internet', dollars: 75, timing: 'due_day', dueDay: 8 },
  { section: 'Utilities', category: 'Mobile Phones', dollars: 200, timing: 'due_day', dueDay: 22 },
  { section: 'Transportation', category: 'Car Payment', dollars: 200, timing: 'due_day', dueDay: 10 },
  { section: 'Transportation', category: 'Fuel', dollars: 200, timing: 'even' },
  { section: 'Transportation', category: 'Auto Insurance', dollars: 160, timing: 'due_day', dueDay: 5 },
  { section: 'Transportation', category: 'Auto Maintenance', dollars: 90, timing: 'even' },
  { section: 'Food', category: 'Groceries', dollars: 1200, timing: 'even' },
  { section: 'Food', category: 'Dining Out', dollars: 200, timing: 'even' },
  { section: 'Kids', category: 'School & Supplies', dollars: 100, timing: 'even' },
  { section: 'Kids', category: 'Kids Clothing', dollars: 100, timing: 'even' },
  { section: 'Kids', category: 'Activities & Sports', dollars: 100, timing: 'even' },
  { section: 'Health', category: 'Health Insurance Premium', dollars: 600, timing: 'due_day', dueDay: 1 },
  { section: 'Health', category: 'Medical & Prescriptions', dollars: 120, timing: 'even' },
  { section: 'Health', category: 'Fitness', dollars: 60, timing: 'due_day', dueDay: 3 },
  { section: 'Debt Payments', category: 'Credit Card Paydown', dollars: 250, timing: 'due_day', dueDay: 25 },
  { section: 'Personal & Household', category: 'Subscriptions & Streaming', dollars: 75, timing: 'due_day', dueDay: 14 },
  { section: 'Personal & Household', category: 'Clothing', dollars: 100, timing: 'even' },
  { section: 'Personal & Household', category: 'Household Goods', dollars: 120, timing: 'even' },
  { section: 'Personal & Household', category: 'Pets', dollars: 90, timing: 'even' },
  { section: 'Personal & Household', category: 'Gifts & Misc', dollars: 80, timing: 'even' },
  { section: 'Savings & Goals', category: 'Emergency Fund', dollars: 400, timing: 'due_day', dueDay: 5 },
  { section: 'Savings & Goals', category: 'Retirement — Roth', dollars: 500, timing: 'due_day', dueDay: 5 },
];
