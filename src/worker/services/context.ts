import type { CategoryKind } from '../../shared/actuals';
import { SPECIAL } from '../../shared/categorySet';
import type { ISODate } from '../../shared/dates';
import type { IncomeSourceMatcher } from '../../shared/paychecks';
import type { PayFrequency, PaySchedule } from '../../shared/paySchedule';
import type { Rule } from '../../shared/rules';
import { all } from '../lib/db';

export interface RuleRow {
  id: number;
  position: number;
  matchField: Rule['matchField'];
  matchText: string;
  accountId: number | null;
  categoryId: number | null;
  kidId: number | null;
  privateMemberId: number | null;
  ignoreTxn: number;
  ownerMemberId: number | null;
}

export const RULE_SELECT = `SELECT r.id, r.position, r.match_field AS matchField, r.match_text AS matchText,
  r.account_id AS accountId, r.category_id AS categoryId, r.kid_id AS kidId,
  r.private_member_id AS privateMemberId, r.ignore_txn AS ignoreTxn, r.owner_member_id AS ownerMemberId
  FROM rules r`;

export function toRule(row: RuleRow): Rule {
  return {
    id: row.id,
    position: row.position,
    matchField: row.matchField,
    matchText: row.matchText,
    accountId: row.accountId,
    action: {
      ...(row.categoryId != null ? { categoryId: row.categoryId } : {}),
      ...(row.kidId != null ? { kidId: row.kidId } : {}),
      ...(row.privateMemberId != null ? { privateMemberId: row.privateMemberId } : {}),
      ignore: row.ignoreTxn === 1,
    },
  };
}

export interface IncomeSourceRow {
  id: number;
  memberId: number | null;
  name: string;
  netPayCents: number;
  frequency: PayFrequency;
  anchorDate: ISODate;
  semimonthlyDay1: number | null;
  semimonthlyDay2: number | null;
  matchText: string | null;
  accountId: number | null;
  drivesAllowance: number;
  active: number;
}

export const INCOME_SOURCE_SELECT = `SELECT id, member_id AS memberId, name, net_pay_cents AS netPayCents, frequency,
  anchor_date AS anchorDate, semimonthly_day1 AS semimonthlyDay1, semimonthly_day2 AS semimonthlyDay2,
  match_text AS matchText, account_id AS accountId, drives_allowance AS drivesAllowance, active
  FROM income_sources`;

export function scheduleOf(row: IncomeSourceRow): PaySchedule {
  return {
    frequency: row.frequency,
    anchorDate: row.anchorDate,
    ...(row.frequency === 'semimonthly'
      ? { semimonthlyDays: [row.semimonthlyDay1 ?? 15, row.semimonthlyDay2 ?? 31] as [number, number] }
      : {}),
  };
}

export function loadIncomeSources(db: D1Database, activeOnly = true): Promise<IncomeSourceRow[]> {
  return all<IncomeSourceRow>(db, `${INCOME_SOURCE_SELECT} ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`);
}

export interface CategoryRow {
  id: number;
  sectionId: number;
  sectionName: string;
  sectionSort: number;
  name: string;
  kind: CategoryKind;
  kidScoped: number;
  funMemberId: number | null;
  archived: number;
  sort: number;
}

export const CATEGORY_SELECT = `SELECT c.id, c.section_id AS sectionId, s.name AS sectionName, s.sort AS sectionSort,
  c.name, c.kind, c.kid_scoped AS kidScoped, c.fun_member_id AS funMemberId, c.archived, c.sort
  FROM categories c JOIN sections s ON s.id = c.section_id`;

export function loadCategories(db: D1Database): Promise<CategoryRow[]> {
  return all<CategoryRow>(db, `${CATEGORY_SELECT} ORDER BY s.sort, c.sort, c.name`);
}

export function findSpecialCategory(categories: readonly CategoryRow[], section: string, name: string): number | null {
  return categories.find((c) => c.sectionName === section && c.name === name)?.id ?? null;
}

/** Everything the classifier needs, loaded once per import chunk or sync step. */
export interface IngestContext {
  rules: Rule[];
  paySources: IncomeSourceMatcher[];
  accountType: Map<number, string>;
  /** Account → member whose private fun money it defaults to. */
  privateAccountOwner: Map<number, number>;
  /** Fun money category → its member. */
  funCategoryOwner: Map<number, number>;
  funCategoryByMember: Map<number, number>;
  paychecksCategoryId: number | null;
  cardPaymentCategoryId: number | null;
}

export async function loadIngestContext(db: D1Database): Promise<IngestContext> {
  const [ruleRows, sources, accounts, members, categories] = await Promise.all([
    all<RuleRow>(db, `${RULE_SELECT} ORDER BY r.position, r.id`),
    loadIncomeSources(db),
    all<{ id: number; type: string }>(db, 'SELECT id, type FROM accounts'),
    all<{ id: number; defaultPrivateAccountId: number | null }>(
      db,
      'SELECT id, default_private_account_id AS defaultPrivateAccountId FROM members',
    ),
    loadCategories(db),
  ]);

  const funCategoryOwner = new Map<number, number>();
  const funCategoryByMember = new Map<number, number>();
  for (const c of categories) {
    if (c.funMemberId != null) {
      funCategoryOwner.set(c.id, c.funMemberId);
      funCategoryByMember.set(c.funMemberId, c.id);
    }
  }

  return {
    rules: ruleRows.map(toRule),
    paySources: sources.map((s) => ({ id: s.id, matchText: s.matchText, accountId: s.accountId, schedule: scheduleOf(s) })),
    accountType: new Map(accounts.map((a) => [a.id, a.type])),
    privateAccountOwner: new Map(
      members.filter((m) => m.defaultPrivateAccountId != null).map((m) => [m.defaultPrivateAccountId as number, m.id]),
    ),
    funCategoryOwner,
    funCategoryByMember,
    paychecksCategoryId: findSpecialCategory(categories, ...SPECIAL.paychecks),
    // Card payments are transfers.
    cardPaymentCategoryId: findSpecialCategory(categories, ...SPECIAL.transfers),
  };
}
