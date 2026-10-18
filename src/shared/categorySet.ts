/** Category groups (stored as sections). Migration 0003 creates them; code finds them by name. */
export const GROUPS = {
  bills: 'Bills',
  everyday: 'Everyday',
  habits: 'Habits',
  fun: 'Fun & Wants',
  saving: 'Saving',
  income: 'Income',
  transfers: 'Transfers',
} as const;

/** Categories the app looks up by (section, name), for findSpecialCategory. */
export const SPECIAL = {
  paychecks: ['Income', 'Paychecks'],
  transfers: ['Transfers', 'Transfers'],
  habits: ['Habits', 'Habits'],
  gas: ['Everyday', 'Gas'],
  savings: ['Saving', 'Savings & Planned Costs'],
} as const;

/** The kind a new category in this group gets. */
export function kindForGroup(group: string): 'income' | 'expense' | 'savings' | 'transfer' {
  if (group === GROUPS.income) return 'income';
  if (group === GROUPS.saving) return 'savings';
  if (group === GROUPS.transfers) return 'transfer';
  return 'expense';
}
