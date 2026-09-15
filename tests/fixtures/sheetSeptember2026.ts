import type { Timing } from '../../src/shared/allocation';

/**
 * Budget lines from the original Google Sheet ("Monthly_Budget_Weekly_Breakdown"),
 * September 2026, sample figures. Used as the golden month for the forecast.
 * Weekly pay of $1,935 on Fridays (first payday Sep 4); starting cash $1,000.
 */
export const SHEET_LINES: { name: string; dollars: number; timing: Timing; dueDay?: number }[] = [
  { name: 'Mortgage — Primary (PITI)', dollars: 1600, timing: 'due_day', dueDay: 1 },
  { name: 'Home Maintenance — Primary', dollars: 0, timing: 'even' },
  { name: 'Electric — Primary', dollars: 165, timing: 'due_day', dueDay: 12 },
  { name: 'Natural Gas — Primary', dollars: 55, timing: 'due_day', dueDay: 12 },
  { name: 'Water / Sewer — Primary', dollars: 70, timing: 'due_day', dueDay: 20 },
  { name: 'Trash — Primary', dollars: 35, timing: 'due_day', dueDay: 20 },
  { name: 'Internet — Primary', dollars: 75, timing: 'due_day', dueDay: 8 },
  { name: 'Mobile Phones', dollars: 200, timing: 'due_day', dueDay: 22 },
  { name: 'Car Payment', dollars: 200, timing: 'due_day', dueDay: 10 },
  { name: 'Fuel', dollars: 200, timing: 'even' },
  { name: 'Auto Insurance', dollars: 160, timing: 'due_day', dueDay: 5 },
  { name: 'Auto Maintenance', dollars: 90, timing: 'even' },
  { name: 'Groceries', dollars: 1200, timing: 'even' },
  { name: 'Dining Out', dollars: 200, timing: 'even' },
  { name: 'Health Insurance Premium', dollars: 600, timing: 'due_day', dueDay: 1 },
  { name: 'Medical & Prescriptions', dollars: 120, timing: 'even' },
  { name: 'Fitness', dollars: 60, timing: 'due_day', dueDay: 3 },
  { name: 'Life Insurance', dollars: 0, timing: 'due_day', dueDay: 7 },
  { name: 'Umbrella Policy', dollars: 0, timing: 'due_day', dueDay: 7 },
  { name: 'Student Loan', dollars: 0, timing: 'due_day', dueDay: 21 },
  { name: 'Credit Card Paydown', dollars: 250, timing: 'due_day', dueDay: 25 },
  { name: 'Subscriptions & Streaming', dollars: 75, timing: 'due_day', dueDay: 14 },
  { name: 'Clothing', dollars: 100, timing: 'even' },
  { name: 'Household Goods', dollars: 120, timing: 'even' },
  { name: 'Pets', dollars: 90, timing: 'even' },
  { name: 'Gifts & Misc', dollars: 80, timing: 'even' },
  { name: 'Emergency Fund', dollars: 400, timing: 'due_day', dueDay: 5 },
  { name: 'Retirement — Roth', dollars: 500, timing: 'due_day', dueDay: 5 },
  { name: 'Sinking Fund — Transition', dollars: 300, timing: 'due_day', dueDay: 5 },
  { name: 'Mortgage — Second Home', dollars: 861, timing: 'due_day', dueDay: 1 },
  { name: 'HOA / Lawn Care — Second Home', dollars: 80, timing: 'due_day', dueDay: 1 },
  { name: 'Security Monitoring — Second Home', dollars: 45, timing: 'due_day', dueDay: 18 },
  { name: 'Electric — Second Home', dollars: 95, timing: 'due_day', dueDay: 12 },
  { name: 'Natural Gas — Second Home', dollars: 40, timing: 'due_day', dueDay: 12 },
  { name: 'Water / Sewer — Second Home', dollars: 55, timing: 'due_day', dueDay: 20 },
  { name: 'Trash — Second Home', dollars: 30, timing: 'due_day', dueDay: 20 },
  { name: 'Contractor Payments — Scheduled', dollars: 1800, timing: 'due_day', dueDay: 26 },
  { name: 'Repairs & Materials', dollars: 350, timing: 'even' },
  { name: 'Cleaning & Staging', dollars: 200, timing: 'due_day', dueDay: 24 },
];

/** The sheet's Weekly Cash Flow tab (whole dollars). */
export const SHEET_WEEKS = {
  income: [1935, 1935, 1935, 1935, 0],
  outflow: [5156, 1300, 830, 3045, 170],
  endBalance: [-2221, -1586, -481, -1591, -1761],
};
