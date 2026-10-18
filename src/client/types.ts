import type { CategoryKind } from '../shared/actuals';
import type { Timing } from '../shared/allocation';
import type { Forecast, ForecastWeek } from '../shared/forecast';
import type { SafeToSpend } from '../shared/safeToSpend';

export interface Member {
  id: number;
  name: string;
  email: string;
  color: string;
  funAllowanceCents: number;
  defaultPrivateAccountId: number | null;
}

export interface Kid {
  id: number;
  name: string;
  color: string;
  birthDate: string | null;
  sort: number;
  archived?: number;
}

export interface Me {
  viewer: { memberId: number; email: string; name: string };
  today: string;
  household: {
    name: string;
    timezone: string;
    lowBalanceCents: number;
    cardPayMode: 'when_made' | 'when_paid';
    funMoneyStartDate: string | null;
    habitCutoffCents: number;
    categorizedAllAt: string | null;
  };
  members: Member[];
  kids: Kid[];
  plaid: { configured: boolean; env: string };
  setup: { accounts: number; incomeSources: number; budgetLines: number };
  devMode: boolean;
}

export interface Category {
  id: number;
  sectionId: number;
  sectionName: string;
  name: string;
  kind: CategoryKind;
  kidScoped: boolean;
  funMemberId: number | null;
  archived: boolean;
}

export interface Account {
  id: number;
  name: string;
  institution: string | null;
  mask: string | null;
  type: 'checking' | 'savings' | 'credit' | 'investment' | 'loan' | 'cash' | 'other';
  isCash: boolean;
  hidden: boolean;
  plaidItemId: number | null;
  currentBalanceCents: number | null;
  availableBalanceCents: number | null;
  creditLimitCents: number | null;
  balanceUpdatedAt: string | null;
  ownerMemberId: number | null;
  plaidStatus: string | null;
  plaidInstitution: string | null;
  transactionCount: number;
}

export interface Split {
  id?: number;
  categoryId: number | null;
  kidId: number | null;
  amountCents: number;
  notes?: string | null;
}

export interface Transaction {
  id: number;
  accountId: number;
  accountName: string;
  accountType: string;
  institution: string | null;
  date: string;
  amountCents: number;
  name: string;
  merchantName: string | null;
  memo: string | null;
  pending: boolean;
  source: 'plaid' | 'import' | 'manual';
  categoryId: number | null;
  categorySource: 'rule' | 'user' | 'auto' | null;
  kidId: number | null;
  privateMemberId: number | null;
  isPrivate: boolean;
  incomeSourceId: number | null;
  payDate: string | null;
  notes: string | null;
  transferPairId: number | null;
  isIgnored: boolean;
  isSplit: boolean;
  importBatchId: number | null;
  splits: Split[];
  transferPair?: Transaction | null;
}

/** What a category fix did: charges re-filed under the rule it learned (see POST /category-moves/:id/undo). */
export interface CategoryMove {
  id: number;
  moved: number;
  merchant: string;
  categoryName: string;
}

export interface BudgetRow {
  categoryId: number;
  name: string;
  sectionId: number;
  sectionName: string;
  kind: CategoryKind;
  kidScoped: boolean;
  funMemberId: number | null;
  lineId: number | null;
  budgetCents: number;
  timing: Timing;
  dueDay: number | null;
  notes: string | null;
  actualCents: number;
  byWeek: number[];
  computed: 'paychecks' | 'fun_money' | null;
}

export interface BudgetResponse {
  month: string;
  rows: BudgetRow[];
  uncategorized: { inCents: number; outCents: number; count: number };
  totals: { incomeBudgetCents: number; incomeActualCents: number; outBudgetCents: number; outActualCents: number };
  hasLines: boolean;
  previousMonthHasLines: boolean;
}

export interface Bill {
  name: string;
  date: string;
  amountCents: number;
  overdue: boolean;
  source: 'budget' | 'recurring';
  categoryId: number | null;
}

export interface FunBalance {
  memberId: number;
  name: string;
  color: string;
  balanceCents: number;
  isViewer: boolean;
  allowancePerPaydayCents?: number;
  accruedCents?: number;
  spentCents?: number;
  paydaysCounted?: number;
  nextPayDate?: string | null;
}

export interface BankItem {
  id: number;
  institutionName: string | null;
  status: 'ok' | 'login_required' | 'error';
  lastSyncedAt: string | null;
  errorMessage: string | null;
}

export interface HomeResponse {
  today: string;
  month: string;
  safe: SafeToSpend;
  week: ForecastWeek | null;
  weeks: Pick<ForecastWeek, 'index' | 'start' | 'end' | 'endBalance' | 'status' | 'isCurrent' | 'isPast'>[];
  lowBalanceCents: number;
  startingBalance: { cents: number; source: string };
  extraPaychecks: number;
  bills: Bill[];
  fun: FunBalance[];
  uncategorizedCount: number;
  banks: BankItem[];
  lastSyncedAt: string | null;
  checkin: { month: string; status: string } | null;
}

export interface PlannerResponse {
  month: string;
  today: string;
  startingBalance: { cents: number; source: 'manual' | 'bank' | 'previous_month' | 'none' };
  safe: SafeToSpend;
  lowBalanceCents: number;
  forecast: Omit<Forecast, 'remainingByLine'> & { remainingByLine: Record<string, number[]> };
  lines: { categoryId: number; name: string; sectionName: string; kind: CategoryKind; timing: Timing; dueDay: number | null; budgetCents: number; actualCents: number }[];
  sources: { id: number; name: string }[];
  bills: Bill[];
}

export interface SyncStepResult {
  itemId: number | null;
  institutionName: string | null;
  done: boolean;
  added: number;
  modified: number;
  removed: number;
  status: 'ok' | 'login_required' | 'error' | 'idle';
  error?: string;
  note?: string;
  busy?: boolean;
}
