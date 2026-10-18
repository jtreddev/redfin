/**
 * Activity's search and filters as a query string (`q=shell&month=2026-09&categoryId=3,5&needs=1`).
 * The same string is the URL after `#/activity?` and what a saved search stores, so a category merge
 * can re-point saved searches (rewriteCategoryIds) without knowing anything else about them.
 */
export interface ActivityFilters {
  q: string;
  /** 'YYYY-MM', or 'all' for All time; null means the default (All time when searching, else this month). */
  month: string | null;
  categoryIds: number[];
  accountId: number | null;
  kidId: number | null;
  needsLook: boolean;
  private: boolean;
  leftOut: boolean;
  /** Older links from Trends and Kids: a Trends group key, an import batch. */
  group: string | null;
  batch: number | null;
}

export const EMPTY_FILTERS: ActivityFilters = {
  q: '',
  month: null,
  categoryIds: [],
  accountId: null,
  kidId: null,
  needsLook: false,
  private: false,
  leftOut: false,
  group: null,
  batch: null,
};

const positiveInt = (value: string | null | undefined): number | null => {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n > 0 && Number.isSafeInteger(n) ? n : null;
};

/** Category ids from `categoryId` (repeated or comma-separated) and the older `category` key, in order, once each. */
export function categoryIdsOf(params: URLSearchParams): number[] {
  const raw = [...params.getAll('categoryId'), ...params.getAll('category')].flatMap((v) => v.split(','));
  const ids: number[] = [];
  for (const value of raw) {
    const id = positiveInt(value);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function parseActivityParams(input: URLSearchParams | string): ActivityFilters {
  const params = typeof input === 'string' ? new URLSearchParams(input.replace(/^\?/, '')) : input;
  const month = params.get('month');
  const filter = params.get('filter');
  return {
    q: params.get('q') ?? '',
    month: month === 'all' || (month && /^\d{4}-\d{2}$/.test(month)) ? month : null,
    categoryIds: categoryIdsOf(params),
    accountId: positiveInt(params.get('account') ?? params.get('accountId')),
    kidId: positiveInt(params.get('kid') ?? params.get('kidId')),
    // `filter=` is the older single-choice form (Home and Plan link with filter=uncategorized).
    needsLook: params.get('needs') === '1' || filter === 'uncategorized',
    private: params.get('private') === '1' || filter === 'private',
    leftOut: params.get('leftOut') === '1' || filter === 'ignored',
    group: params.get('group') || null,
    batch: positiveInt(params.get('batch')),
  };
}

/** The canonical query string: keys in a fixed order, empty values left out. */
export function activityQueryString(f: ActivityFilters): string {
  const out = new URLSearchParams();
  if (f.q.trim()) out.set('q', f.q.trim());
  if (f.month) out.set('month', f.month);
  if (f.categoryIds.length) out.set('categoryId', f.categoryIds.join(','));
  if (f.accountId) out.set('account', String(f.accountId));
  if (f.kidId) out.set('kid', String(f.kidId));
  if (f.needsLook) out.set('needs', '1');
  if (f.private) out.set('private', '1');
  if (f.leftOut) out.set('leftOut', '1');
  if (f.group) out.set('group', f.group);
  if (f.batch) out.set('batch', String(f.batch));
  return out.toString();
}

/** The month actually shown: what was picked, else All time while searching, else this month. */
export function effectiveMonth(f: ActivityFilters, thisMonth: string): string | null {
  if (f.month === 'all') return null;
  if (f.month) return f.month;
  return f.q.trim() ? null : thisMonth;
}

/** The GET /transactions query for these filters (without paging). */
export function transactionsQuery(f: ActivityFilters, thisMonth: string): URLSearchParams {
  const qs = new URLSearchParams();
  const month = effectiveMonth(f, thisMonth);
  if (month) qs.set('month', month);
  if (f.q.trim()) qs.set('q', f.q.trim());
  if (f.categoryIds.length) qs.set('categoryId', f.categoryIds.join(','));
  if (f.accountId) qs.set('accountId', String(f.accountId));
  if (f.kidId) qs.set('kidId', String(f.kidId));
  if (f.needsLook) qs.set('uncategorized', '1');
  if (f.private) qs.set('private', '1');
  if (f.leftOut) qs.set('ignored', 'only');
  if (f.group) qs.set('group', f.group);
  if (f.batch) qs.set('importBatchId', String(f.batch));
  return qs;
}

/** True when any filter beyond the month is on (the "Clear all" case). */
export function hasFilters(f: ActivityFilters): boolean {
  return Boolean(f.q.trim() || f.categoryIds.length || f.accountId || f.kidId || f.needsLook || f.private || f.leftOut || f.group || f.batch);
}

/**
 * A saved query string with category `from` re-pointed to `into` (after a merge). Reads both the
 * `categoryId` and older `category` keys, in either the repeated or comma form; writes `categoryId`
 * once, without duplicates. Returns null when the query doesn't mention `from`, so it can be left alone.
 */
export function rewriteCategoryIds(query: string, from: number, into: number): string | null {
  const params = new URLSearchParams(query.replace(/^\?/, ''));
  const ids = categoryIdsOf(params);
  if (!ids.includes(from)) return null;
  const next: number[] = [];
  for (const id of ids.map((i) => (i === from ? into : i))) if (!next.includes(id)) next.push(id);
  // Keep every other key where it was; the category ids take the first category key's place.
  const out = new URLSearchParams();
  let placed = false;
  for (const [key, value] of params) {
    if (key === 'categoryId' || key === 'category') {
      if (!placed) out.append('categoryId', next.join(','));
      placed = true;
    } else {
      out.append(key, value);
    }
  }
  return out.toString();
}
