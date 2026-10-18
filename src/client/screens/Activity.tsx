import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addMonths, monthOf } from '../../shared/dates';
import {
  activityQueryString,
  effectiveMonth,
  hasFilters,
  parseActivityParams,
  transactionsQuery,
  type ActivityFilters,
} from '../../shared/activityQuery';
import { GROUP_ORDER } from '../../shared/trends';
import { api, del, errorMessage, patch, post } from '../api';
import { capSelection, MAX_BULK } from '../bulk';
import { categoryTree } from '../categoryTree';
import { transactionsCsv } from '../csvExport';
import { monthLabel, plural, weekdayDate } from '../format';
import { Icon } from '../icons';
import { replaceRoute } from '../router';
import { describeSearch, resultSummary } from '../searchHelp';
import { SHORTCUTS, shortcutFor, step } from '../shortcuts';
import { categoryName, useApp } from '../state';
import type { Transaction } from '../types';
import { AmountInput, Button, CategorySelect, Empty, ErrorNote, Field, KidSelect, Loading, Money, PageHeader, Segmented, Sheet, Toggle, useCommitSelect } from '../ui';
import { TransactionSheet } from './TransactionSheet';

type Totals = { count: number; outCents: number; inCents: number };
type Page = { transactions: Transaction[]; hasMore: boolean; totals?: Totals };
interface SavedSearch {
  id: number;
  name: string;
  query: string;
}

const PAGE = 100;

export function Activity({ params }: { params: URLSearchParams }) {
  const { categories, me, accounts, toast, undoLast } = useApp();
  const filters = useMemo(() => parseActivityParams(params), [params]);
  const thisMonth = monthOf(me.today);
  const queryKey = activityQueryString(filters);
  const power = me.viewer.powerTools;

  const [search, setSearch] = useState(filters.q);
  const [items, setItems] = useState<Transaction[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<{ txn: Transaction; focusCategory?: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [picker, setPicker] = useState<'category' | 'account' | 'kid' | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [focusIndex, setFocusIndex] = useState(-1);
  const [help, setHelp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [downloading, setDownloading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  function update(next: Partial<ActivityFilters>) {
    replaceRoute('activity', activityQueryString({ ...filters, ...next }));
  }

  // The box follows the URL (a saved search, Back); typing updates the URL after a pause.
  useEffect(() => setSearch((s) => (s.trim() === filters.q.trim() ? s : filters.q)), [filters.q]);
  useEffect(() => {
    if (search.trim() === filters.q.trim()) return;
    const timer = window.setTimeout(() => update({ q: search }), 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const fetchPage = useCallback(
    async (offset: number, limit = PAGE) => {
      const qs = transactionsQuery(filters, thisMonth);
      qs.set('limit', String(limit));
      qs.set('offset', String(offset));
      return api<Page>(`/transactions?${qs}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryKey, thisMonth],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPage(0)
      .then((res) => {
        if (cancelled) return;
        setItems(res.transactions);
        setHasMore(res.hasMore);
        setTotals(res.totals ?? null);
        setError(undefined);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [fetchPage, refreshKey]);

  // A new search starts a new selection and a new place in the list.
  useEffect(() => {
    setSelected(new Set());
    setFocusIndex(-1);
  }, [queryKey]);

  const loadSaved = useCallback(() => {
    if (!power) return;
    api<SavedSearch[]>('/saved-searches')
      .then(setSaved)
      .catch(() => undefined);
  }, [power]);
  useEffect(loadSaved, [loadSaved]);

  async function loadMore() {
    try {
      const res = await fetchPage(items.length);
      setItems((list) => [...list, ...res.transactions]);
      setHasMore(res.hasMore);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const t of items) map.set(t.date, [...(map.get(t.date) ?? []), t]);
    return [...map.entries()];
  }, [items]);

  function handleChanged(updated: Transaction | null, refreshAll?: boolean) {
    if (refreshAll) {
      setRefreshKey((k) => k + 1);
      return;
    }
    if (!updated) return;
    setItems((list) => list.map((t) => (t.id === updated.id ? updated : t)));
  }

  function nextUncategorized() {
    if (!open) return;
    const current = open.txn;
    const index = items.findIndex((t) => t.id === current.id);
    const remaining = items.filter((t) => t.id !== current.id && t.categoryId === null && !t.isSplit && !t.isIgnored && !t.transferPairId);
    setItems((list) => list.filter((t) => t.id !== current.id || (t.categoryId === null && !t.isIgnored && !t.transferPairId)));
    const next = remaining.find((t) => items.indexOf(t) > index) ?? remaining[0] ?? null;
    setOpen(next ? { txn: next } : null);
  }

  function toggle(id: number) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Power tools: keyboard shortcuts on a computer. Never while typing, and not behind an open sheet.
  const keyState = useRef({ items, focusIndex, selecting });
  keyState.current = { items, focusIndex, selecting };
  useEffect(() => {
    if (!power) return;
    const onKey = (e: KeyboardEvent) => {
      if (!window.matchMedia('(min-width: 900px)').matches) return;
      const action = shortcutFor({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, target: e.target as HTMLElement | null });
      if (!action) return;
      if (document.querySelector('.sheet')) return;
      const { items: list, focusIndex: at, selecting: inSelect } = keyState.current;
      e.preventDefault();
      if (action === 'search') {
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (action === 'help') {
        setHelp(true);
      } else if (action === 'undo') {
        if (!undoLast()) toast('Nothing to undo right now');
      } else if (action === 'next' || action === 'previous') {
        const next = step(at, list.length, action);
        setFocusIndex(next);
        const t = list[next];
        if (t) document.getElementById(`txn-${t.id}`)?.focus();
      } else {
        const t = list[at];
        if (!t) {
          toast('Press j to pick a charge first');
          return;
        }
        if (action === 'category') {
          setOpen({ txn: t, focusCategory: true });
        } else if (action === 'select') {
          if (!inSelect) setSelecting(true);
          toggle(t.id);
          window.setTimeout(() => document.getElementById(`txn-${t.id}`)?.focus(), 0);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [power, toast, undoLast]);

  async function downloadCsv() {
    setDownloading(true);
    try {
      const all: Transaction[] = [];
      for (let page = 0; page < 50; page++) {
        const res = await fetchPage(all.length, 200);
        all.push(...res.transactions);
        if (!res.hasMore) break;
      }
      const blob = new Blob([transactionsCsv(all, categories, me.kids)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `charges-${me.today}.csv`;
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(totals && totals.count > all.length ? `Downloaded the first ${all.length} of ${totals.count}` : `Downloaded ${plural(all.length, 'charge')}`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setDownloading(false);
    }
  }

  const month = effectiveMonth(filters, thisMonth);
  const searchHelp = describeSearch(search);
  const chips = activeChips(filters, {
    category: (id) => categoryName(categories, id),
    account: (id) => accounts.find((a) => a.id === id)?.name ?? 'An account',
    kid: (id) => me.kids.find((k) => k.id === id)?.name ?? 'A kid',
  });
  const savedActive = saved.find((s) => s.query === queryKey);
  const selectedItems = items.filter((t) => selected.has(t.id));

  return (
    <div className={`stack ${selecting ? 'is-selecting' : ''}`}>
      <PageHeader
        title="Activity"
        action={
          <Button
            small
            pressed={selecting}
            onClick={() => {
              setSelecting((v) => !v);
              setSelected(new Set());
            }}
          >
            {selecting ? 'Done' : 'Select'}
          </Button>
        }
      />

      {power && saved.length > 0 && (
        <div className="chips saved-searches" role="group" aria-label="Saved searches">
          {saved.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`filter-chip ${savedActive?.id === s.id ? 'active' : ''}`}
              aria-pressed={savedActive?.id === s.id}
              onClick={() => replaceRoute('activity', savedActive?.id === s.id ? '' : s.query)}
            >
              <Icon name="bookmark" />
              {s.name}
            </button>
          ))}
          <button type="button" className="filter-chip filter-chip-quiet" onClick={() => setManaging(true)}>
            Edit saved
          </button>
        </div>
      )}

      <div className="search-box">
        <Icon name="search" />
        <input
          ref={searchRef}
          type="search"
          aria-label="Search charges"
          aria-describedby="search-help"
          placeholder="Search or amount (45, >100)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && search) {
              e.preventDefault();
              setSearch('');
            }
          }}
        />
      </div>
      <p id="search-help" className="muted small search-help">
        {searchHelp ?? 'Searches descriptions, merchants, notes, categories and amounts.'}
      </p>

      <div className="month-row">
        <div className="month-picker">
          {/* From All time, ‹ starts at this month. */}
          <button type="button" className="icon-btn" onClick={() => update({ month: month ? addMonths(month, -1) : thisMonth })} aria-label={month ? 'Previous month' : 'This month'}>
            <Icon name="back" />
          </button>
          <strong aria-live="polite">{month ? monthLabel(month) : 'All time'}</strong>
          <button
            type="button"
            className="icon-btn"
            onClick={() => month && update({ month: addMonths(month, 1) })}
            aria-label="Next month"
            disabled={month === null || month >= thisMonth}
          >
            <Icon name="forward" />
          </button>
        </div>
        {month !== null && (
          <button type="button" className="filter-chip" onClick={() => update({ month: 'all' })}>
            All time
          </button>
        )}
      </div>

      <div className="chips" role="group" aria-label="Filters">
        <FilterChip label="Category" active={filters.categoryIds.length > 0} onClick={() => setPicker('category')} menu />
        <FilterChip label="Account" active={filters.accountId !== null} onClick={() => setPicker('account')} menu />
        {me.kids.length > 0 && <FilterChip label="Kid" active={filters.kidId !== null} onClick={() => setPicker('kid')} menu />}
        <FilterChip label="Needs a look" active={filters.needsLook} onClick={() => update({ needsLook: !filters.needsLook })} />
        <FilterChip label="Private" active={filters.private} onClick={() => update({ private: !filters.private })} />
        <FilterChip label="Left out" active={filters.leftOut} onClick={() => update({ leftOut: !filters.leftOut })} />
      </div>

      {chips.length > 0 && (
        <div className="active-filters" role="group" aria-label="Filters in use">
          {chips.map((chip) => (
            <span key={chip.key} className="removable-chip">
              <span>{chip.label}</span>
              <button type="button" aria-label={`Remove filter: ${chip.label}`} onClick={() => update(chip.remove)}>
                <Icon name="close" />
              </button>
            </span>
          ))}
          {hasFilters(filters) && (
            <Button
              small
              variant="ghost"
              onClick={() => {
                setSearch('');
                replaceRoute('activity', filters.month ? `month=${filters.month}` : '');
              }}
            >
              Clear all
            </Button>
          )}
        </div>
      )}
      {filters.group === 'fun' && <p className="muted small">Your partner’s fun money isn’t listed.</p>}

      <div className="result-bar">
        <p className="result-summary" aria-live="polite">
          {totals ? resultSummary(totals) : loading ? 'Looking…' : ''}
        </p>
        {power && (
          <div className="cluster">
            {hasFilters(filters) && !savedActive && (
              <Button small variant="ghost" onClick={() => setSaving(true)}>
                <Icon name="bookmark" />
                Save search
              </Button>
            )}
            <Button small variant="ghost" onClick={() => void downloadCsv()} disabled={downloading || !totals?.count}>
              <Icon name="export" />
              {downloading ? 'Preparing…' : 'Download CSV'}
            </Button>
          </div>
        )}
      </div>
      {items.some((t) => t.isSplit) && (filters.categoryIds.length > 0 || filters.q) && (
        <p className="muted small">Totals count a split charge’s whole amount when one of its parts matches.</p>
      )}

      {selecting && (
        <div className="cluster select-tools">
          <Button
            small
            variant="ghost"
            onClick={() => {
              const { ids, capped } = capSelection(items.map((t) => t.id));
              setSelected(new Set(ids));
              if (capped) toast(`Selected the first ${MAX_BULK}. One change takes up to ${MAX_BULK} charges at a time.`);
            }}
            disabled={!items.length}
          >
            Select all {Math.min(items.length, MAX_BULK)} shown
          </Button>
          {selected.size > 0 && (
            <Button small variant="ghost" onClick={() => setSelected(new Set())}>
              Unselect all
            </Button>
          )}
        </div>
      )}

      {error && <ErrorNote message={error} onRetry={() => setRefreshKey((k) => k + 1)} />}
      {loading && !items.length ? (
        <Loading />
      ) : !items.length ? (
        <Empty title={filters.needsLook && !hasOtherFilters(filters) ? 'All sorted!' : 'Nothing found'}>
          {filters.needsLook && !hasOtherFilters(filters)
            ? 'Every charge has a home.'
            : month
              ? 'Try All time, or fewer filters.'
              : hasFilters(filters)
                ? 'Try fewer filters or other words.'
                : 'Connect a bank or import a file from More › Accounts.'}
        </Empty>
      ) : (
        <div className="list">
          {groups.map(([date, txns]) => (
            <Fragment key={date}>
              <div className="date-heading">{weekdayDate(date)}</div>
              {txns.map((t) => (
                <TransactionRow
                  key={t.id}
                  t={t}
                  selecting={selecting}
                  checked={selected.has(t.id)}
                  onToggle={() => toggle(t.id)}
                  onFocus={() => setFocusIndex(items.indexOf(t))}
                  onClick={() => setOpen({ txn: t })}
                />
              ))}
            </Fragment>
          ))}
        </div>
      )}
      {hasMore && (
        <Button onClick={() => void loadMore()} className="btn-block">
          Load more
        </Button>
      )}

      {!selecting && (
        <button type="button" className="fab" aria-label="Add a transaction" onClick={() => setAdding(true)}>
          <Icon name="plus" />
        </button>
      )}

      {selecting && selectedItems.length > 0 && (
        <BulkBar
          items={selectedItems}
          onDone={() => {
            setSelected(new Set());
            setRefreshKey((k) => k + 1);
          }}
          onUndone={() => setRefreshKey((k) => k + 1)}
        />
      )}

      {open && (
        <TransactionSheet
          txn={open.txn}
          focusCategory={open.focusCategory}
          onClose={() => {
            const id = open.txn.id;
            setOpen(null);
            if (power) window.setTimeout(() => document.getElementById(`txn-${id}`)?.focus(), 0);
          }}
          onChanged={handleChanged}
          onNext={filters.needsLook ? nextUncategorized : undefined}
        />
      )}
      {adding && (
        <AddTransactionSheet
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
      {picker === 'category' && (
        <CategoryFilterSheet value={filters.categoryIds} onClose={() => setPicker(null)} onChange={(ids) => update({ categoryIds: ids })} />
      )}
      {picker === 'account' && (
        <ChoiceSheet
          title="Account"
          value={filters.accountId}
          options={accounts.filter((a) => !a.hidden || a.id === filters.accountId).map((a) => ({ id: a.id, label: a.name }))}
          onClose={() => setPicker(null)}
          onChange={(id) => update({ accountId: id })}
        />
      )}
      {picker === 'kid' && (
        <ChoiceSheet
          title="Kid"
          value={filters.kidId}
          options={me.kids.map((k) => ({ id: k.id, label: k.name }))}
          onClose={() => setPicker(null)}
          onChange={(id) => update({ kidId: id })}
        />
      )}
      {help && <ShortcutsSheet onClose={() => setHelp(false)} />}
      {saving && (
        <SaveSearchSheet
          query={queryKey}
          onClose={() => setSaving(false)}
          onSaved={() => {
            setSaving(false);
            loadSaved();
          }}
        />
      )}
      {managing && <ManageSavedSheet saved={saved} onClose={() => setManaging(false)} onChanged={loadSaved} />}
    </div>
  );
}

const hasOtherFilters = (f: ActivityFilters) => hasFilters({ ...f, needsLook: false });

function FilterChip({ label, active, onClick, menu }: { label: string; active: boolean; onClick: () => void; menu?: boolean }) {
  return (
    <button
      type="button"
      className={`filter-chip ${active ? 'active' : ''}`}
      aria-pressed={menu ? undefined : active}
      aria-haspopup={menu ? 'dialog' : undefined}
      onClick={onClick}
    >
      {active && <Icon name="check" />}
      {label}
      {active && <span className="sr-only"> (on)</span>}
    </button>
  );
}

/** One removable chip per filter in use. */
function activeChips(
  f: ActivityFilters,
  names: { category: (id: number) => string; account: (id: number) => string; kid: (id: number) => string },
): { key: string; label: string; remove: Partial<ActivityFilters> }[] {
  const chips: { key: string; label: string; remove: Partial<ActivityFilters> }[] = [];
  for (const id of f.categoryIds) chips.push({ key: `c${id}`, label: names.category(id), remove: { categoryIds: f.categoryIds.filter((c) => c !== id) } });
  if (f.accountId) chips.push({ key: 'a', label: names.account(f.accountId), remove: { accountId: null } });
  if (f.kidId) chips.push({ key: 'k', label: names.kid(f.kidId), remove: { kidId: null } });
  if (f.needsLook) chips.push({ key: 'n', label: 'Needs a look', remove: { needsLook: false } });
  if (f.private) chips.push({ key: 'p', label: 'Private', remove: { private: false } });
  if (f.leftOut) chips.push({ key: 'l', label: 'Left out', remove: { leftOut: false } });
  if (f.group) chips.push({ key: 'g', label: GROUP_ORDER.find((g) => g.key === f.group)?.name ?? f.group, remove: { group: null } });
  if (f.batch) chips.push({ key: 'b', label: 'One import', remove: { batch: null } });
  return chips;
}

function TransactionRow({
  t,
  onClick,
  selecting,
  checked,
  onToggle,
  onFocus,
}: {
  t: Transaction;
  onClick: () => void;
  selecting: boolean;
  checked: boolean;
  onToggle: () => void;
  onFocus: () => void;
}) {
  const { categories, me } = useApp();
  const kid = me.kids.find((k) => k.id === t.kidId);
  const needsCategory = t.categoryId === null && !t.isSplit && !t.isIgnored && !t.transferPairId;
  const content = (
    <>
      <div className="row-main">
        <div className="row-title">
          {t.isPrivate && (
            <span className="private-mark" title="My fun money: only you see this">
              <Icon name="lock" />
              <span className="sr-only">Private: </span>
            </span>
          )}
          {t.merchantName ?? t.name}
        </div>
        <div className="row-sub">
          {needsCategory ? (
            <span className="chip chip-warn">Needs category</span>
          ) : t.transferPairId && !t.categoryId ? (
            'Transfer'
          ) : t.isSplit ? (
            'Split'
          ) : (
            categoryName(categories, t.categoryId)
          )}
          {kid && ` · ${kid.name}`}
          {` · ${t.accountName}`}
          {t.pending && ' · pending'}
          {t.isIgnored && ' · left out'}
        </div>
      </div>
      <Money cents={t.amountCents} signed={t.amountCents > 0} tone={t.amountCents > 0 ? 'good' : t.isIgnored ? 'muted' : undefined} />
    </>
  );
  if (selecting) {
    return (
      <label className={`row row-button select-row ${checked ? 'is-selected' : ''}`}>
        <input id={`txn-${t.id}`} type="checkbox" checked={checked} onChange={onToggle} onFocus={onFocus} />
        {content}
      </label>
    );
  }
  return (
    <button id={`txn-${t.id}`} type="button" className="row row-button" onClick={onClick} onFocus={onFocus}>
      {content}
    </button>
  );
}

/** Bulk changes to the selected charges: one request, one Undo. */
function BulkBar({ items, onDone, onUndone }: { items: Transaction[]; onDone: () => void; onUndone: () => void }) {
  const { me, accounts, categories, toast } = useApp();
  const [busy, setBusy] = useState(false);
  // "Mark private" is for your own spending: money out on your card or a shared account, never a partner's card.
  const ownable = items.filter((t) => {
    const owner = accounts.find((a) => a.id === t.accountId)?.ownerMemberId ?? null;
    return t.amountCents < 0 && !t.isSplit && (owner === null || owner === me.viewer.memberId);
  });

  async function apply(set: Record<string, unknown>, ids: number[], done: (n: number) => string) {
    if (!ids.length) return;
    setBusy(true);
    try {
      const res = await post<{ updated: number; skipped: number; moveId: number | null }>('/transactions/bulk', { ids, set });
      const skipped = items.length - res.updated;
      const text = `${done(res.updated)}${skipped > 0 ? ` (${skipped} left as they were)` : ''}`;
      toast(text, 'ok', {
        action: res.moveId
          ? {
              label: 'Undo',
              run: () => {
                post<{ restored: number }>(`/category-moves/${res.moveId}/undo`)
                  .then((r) => {
                    toast(`Undone: ${plural(r.restored, 'charge')} put back`);
                    onUndone();
                  })
                  .catch((error: unknown) => toast(errorMessage(error), 'error'));
              },
            }
          : undefined,
        durationMs: 8000,
      });
      onDone();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  const ids = items.map((t) => t.id);
  const kidSelect = useCommitSelect(null, (v) => {
    const kidId = v === 'none' ? null : Number(v);
    void apply({ kidId }, ids, (n) => (kidId ? `${plural(n, 'charge')} tagged ${me.kids.find((k) => k.id === kidId)?.name}` : `Kid cleared on ${plural(n, 'charge')}`));
  });
  if (items.length > MAX_BULK) {
    return (
      <div className="bulk-bar" role="region" aria-label="Change the selected charges">
        <strong>{items.length} selected</strong>
        <p className="small" role="status">
          One change takes up to {MAX_BULK} charges. Unselect {items.length - MAX_BULK} to go on.
        </p>
      </div>
    );
  }
  return (
    <div className="bulk-bar" role="region" aria-label="Change the selected charges">
      <strong>{plural(items.length, 'selected', 'selected')}</strong>
      <div className="bulk-actions">
        <label className="sr-only" htmlFor="bulk-category">
          Set category
        </label>
        <CategorySelect
          id="bulk-category"
          value={null}
          noneLabel="Set category…"
          allowNew={false}
          disabled={busy}
          onChange={(id) => id && void apply({ categoryId: id }, ids, (n) => `${plural(n, 'charge')} moved to ${categoryName(categories, id)}`)}
        />
        {me.kids.length > 0 && (
          <>
            <label className="sr-only" htmlFor="bulk-kid">
              Set kid
            </label>
            <select id="bulk-kid" disabled={busy} {...kidSelect}>
              <option value="">Set kid…</option>
              {me.kids.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
              <option value="none">No kid</option>
            </select>
          </>
        )}
        <Button
          small
          disabled={busy || !ownable.length}
          onClick={() => void apply({ isPrivate: true }, ownable.map((t) => t.id), (n) => `${plural(n, 'charge')} now private to you`)}
        >
          <Icon name="lock" />
          Mark private
        </Button>
        <Button small disabled={busy} onClick={() => void apply({ isIgnored: true }, ids, (n) => `${plural(n, 'charge')} left out of the budget`)}>
          Leave out
        </Button>
      </div>
    </div>
  );
}

function CategoryFilterSheet({ value, onClose, onChange }: { value: number[]; onClose: () => void; onChange: (ids: number[]) => void }) {
  const { categories, sections, me } = useApp();
  const [picked, setPicked] = useState<number[]>(value);
  const tree = categoryTree(sections, categories, (c) => (!c.archived || value.includes(c.id)) && (c.funMemberId === null || c.funMemberId === me.viewer.memberId));
  const flip = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <Sheet open onClose={onClose} title="Categories">
      <p className="muted small">Pick one or more. A category includes its sub-categories.</p>
      {tree.map((g) => (
        <fieldset key={g.section.id} className="plain-fieldset check-group">
          <legend className="h3">{g.section.name}</legend>
          {g.nodes.map((n) => (
            <Fragment key={n.category.id}>
              <label className="check-row">
                <input type="checkbox" checked={picked.includes(n.category.id)} onChange={() => flip(n.category.id)} />
                <span>{n.category.name}</span>
              </label>
              {n.children.map((k) => (
                <label key={k.id} className="check-row check-child">
                  <input type="checkbox" checked={picked.includes(k.id) || picked.includes(n.category.id)} disabled={picked.includes(n.category.id)} onChange={() => flip(k.id)} />
                  <span>{k.name}</span>
                </label>
              ))}
            </Fragment>
          ))}
        </fieldset>
      ))}
      <div className="sheet-actions">
        <Button
          variant="primary"
          onClick={() => {
            onChange(picked);
            onClose();
          }}
        >
          Show {picked.length ? plural(picked.length, 'category', 'categories') : 'every category'}
        </Button>
        {picked.length > 0 && (
          <Button variant="ghost" onClick={() => setPicked([])}>
            Clear
          </Button>
        )}
      </div>
    </Sheet>
  );
}

function ChoiceSheet({
  title,
  value,
  options,
  onClose,
  onChange,
}: {
  title: string;
  value: number | null;
  options: { id: number; label: string }[];
  onClose: () => void;
  onChange: (id: number | null) => void;
}) {
  const pick = (id: number | null) => {
    onChange(id);
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title={title}>
      <fieldset className="plain-fieldset check-group">
        <legend className="sr-only">{title}</legend>
        <label className="check-row">
          <input type="radio" name={title} checked={value === null} onChange={() => pick(null)} />
          <span>Any {title.toLowerCase()}</span>
        </label>
        {options.map((o) => (
          <label key={o.id} className="check-row">
            <input type="radio" name={title} checked={value === o.id} onChange={() => pick(o.id)} />
            <span>{o.label}</span>
          </label>
        ))}
      </fieldset>
    </Sheet>
  );
}

function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet open onClose={onClose} title="Keyboard shortcuts">
      <dl className="shortcut-list">
        {SHORTCUTS.map((s) => (
          <div key={s.keys}>
            <dt>
              <kbd>{s.keys}</kbd>
            </dt>
            <dd>{s.text}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">They don’t fire while you’re typing in a box. Turn them off with Settings › Show more tools.</p>
    </Sheet>
  );
}

function SaveSearchSheet({ query, onClose, onSaved }: { query: string; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [name, setName] = useState('');
  async function save() {
    try {
      await post('/saved-searches', { name: name.trim(), query });
      toast(`Saved “${name.trim()}”`);
      onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }
  return (
    <Sheet open onClose={onClose} title="Save this search">
      <form
        className="stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void save();
        }}
      >
        <Field label="Name" hint="It shows as a chip at the top of Activity, just for you.">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus placeholder="e.g. Gas this year" />
        </Field>
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          Save
        </Button>
      </form>
    </Sheet>
  );
}

function ManageSavedSheet({ saved, onClose, onChanged }: { saved: SavedSearch[]; onClose: () => void; onChanged: () => void }) {
  const { toast } = useApp();
  const [names, setNames] = useState<Record<number, string>>(Object.fromEntries(saved.map((s) => [s.id, s.name])));
  async function rename(s: SavedSearch) {
    const name = names[s.id]?.trim();
    if (!name || name === s.name) return;
    try {
      await patch(`/saved-searches/${s.id}`, { name });
      toast('Renamed');
      onChanged();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }
  async function remove(s: SavedSearch) {
    try {
      await del(`/saved-searches/${s.id}`);
      toast(`Deleted “${s.name}”`);
      onChanged();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }
  return (
    <Sheet open onClose={onClose} title="Saved searches">
      {saved.length === 0 && <p className="muted">None left. Search or filter, then “Save search”.</p>}
      {saved.map((s) => (
        <form
          key={s.id}
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void rename(s);
          }}
        >
          <label className="sr-only" htmlFor={`saved-${s.id}`}>
            Name of {s.name}
          </label>
          <input id={`saved-${s.id}`} value={names[s.id] ?? ''} onChange={(e) => setNames((n) => ({ ...n, [s.id]: e.target.value }))} maxLength={60} />
          <Button type="submit" small disabled={!names[s.id]?.trim() || names[s.id]?.trim() === s.name}>
            Rename
          </Button>
          <Button small variant="danger" onClick={() => void remove(s)}>
            Delete
          </Button>
        </form>
      ))}
    </Sheet>
  );
}

function AddTransactionSheet({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { me, accounts, toast } = useApp();
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [cents, setCents] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [date, setDate] = useState(me.today);
  const [accountId, setAccountId] = useState<number | null>(accounts.find((a) => a.type === 'cash')?.id ?? null);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [kidId, setKidId] = useState<number | null>(null);
  const [isPrivate, setPrivate] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!cents || !name.trim()) {
      toast('Add an amount and a description', 'error');
      return;
    }
    setSaving(true);
    try {
      await post('/transactions', {
        amountCents: direction === 'out' ? -Math.abs(cents) : Math.abs(cents),
        name,
        date,
        accountId,
        categoryId,
        kidId,
        isPrivate: direction === 'out' && isPrivate,
      });
      toast('Added');
      onAdded();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title="Add a transaction">
      <Segmented
        value={direction}
        onChange={setDirection}
        options={[
          { value: 'out', label: 'Money out' },
          { value: 'in', label: 'Money in' },
        ]}
      />
      <Field label="Amount">
        <AmountInput cents={cents} onChange={setCents} autoFocus />
      </Field>
      <Field label="Description">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Farmers market" />
      </Field>
      <div className="grid-2">
        <Field label="Date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Account">
          <select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Cash</option>
            {accounts
              .filter((a) => !a.hidden && a.type !== 'cash')
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      {!isPrivate && (
        <Field label="Category">
          <CategorySelect value={categoryId} onChange={setCategoryId} />
        </Field>
      )}
      {(me.kids.length > 0 || direction === 'out') && (
        <Field label="For which kid?">
          <KidSelect value={kidId} onChange={setKidId} />
        </Field>
      )}
      {direction === 'out' && <Toggle checked={isPrivate} onChange={setPrivate} label="My fun money" hint="Only you see the details." />}
      <Button variant="primary" onClick={() => void save()} disabled={saving}>
        Save
      </Button>
    </Sheet>
  );
}
