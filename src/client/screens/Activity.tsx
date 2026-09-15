import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage, post } from '../api';
import { monthLabel, weekdayDate } from '../format';
import { go } from '../router';
import { categoryName, useApp } from '../state';
import type { Transaction } from '../types';
import { AmountInput, Button, CategorySelect, Empty, ErrorNote, Field, KidSelect, Loading, Money, PageHeader, Segmented, Sheet, Toggle } from '../ui';
import { TransactionSheet } from './TransactionSheet';

const FILTERS = [
  { value: 'uncategorized', label: 'Needs category' },
  { value: 'all', label: 'All' },
  { value: 'private', label: 'My fun money' },
  { value: 'ignored', label: 'Include left out' },
];

export function Activity({ params }: { params: URLSearchParams }) {
  const { categories, me, accounts } = useApp();
  const filter = params.get('filter') ?? 'all';
  const categoryId = params.get('category');
  const month = params.get('month');
  const kidId = params.get('kid');
  const batch = params.get('batch');
  const accountId = params.get('account');

  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Transaction[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<Transaction | null>(null);
  const [adding, setAdding] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const fetchPage = useCallback(
    async (offset: number) => {
      const qs = new URLSearchParams({ limit: '100', offset: String(offset) });
      if (filter === 'uncategorized') qs.set('uncategorized', '1');
      if (filter === 'private') qs.set('private', '1');
      if (filter === 'ignored') qs.set('ignored', '1');
      if (categoryId) qs.set('categoryId', categoryId);
      if (month) qs.set('month', month);
      if (kidId) qs.set('kidId', kidId);
      if (batch) qs.set('importBatchId', batch);
      if (accountId) qs.set('accountId', accountId);
      if (query) qs.set('q', query);
      return api<{ transactions: Transaction[]; hasMore: boolean }>(`/transactions?${qs}`);
    },
    [filter, categoryId, month, kidId, batch, accountId, query],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPage(0)
      .then((res) => {
        if (cancelled) return;
        setItems(res.transactions);
        setHasMore(res.hasMore);
        setError(undefined);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [fetchPage, refreshKey]);

  async function loadMore() {
    const res = await fetchPage(items.length);
    setItems((list) => [...list, ...res.transactions]);
    setHasMore(res.hasMore);
  }

  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const t of items) map.set(t.date, [...(map.get(t.date) ?? []), t]);
    return [...map.entries()];
  }, [items]);

  function setParam(next: Record<string, string | null>) {
    const merged: Record<string, string | null> = {
      filter,
      category: categoryId,
      month,
      kid: kidId,
      batch,
      account: accountId,
      ...next,
    };
    go('activity', merged);
  }

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
    const index = items.findIndex((t) => t.id === open.id);
    const remaining = items.filter((t) => t.id !== open.id && t.categoryId === null && !t.isSplit && !t.isIgnored && !t.transferPairId);
    setItems((list) => list.filter((t) => t.id !== open.id || (t.categoryId === null && !t.isIgnored && !t.transferPairId)));
    const next = remaining.find((t) => items.indexOf(t) > index) ?? remaining[0] ?? null;
    setOpen(next);
  }

  const activeContext = [
    categoryId && categoryName(categories, Number(categoryId)),
    month && monthLabel(month),
    kidId && me.kids.find((k) => String(k.id) === kidId)?.name,
    batch && 'One import',
    accountId && accounts.find((a) => String(a.id) === accountId)?.name,
  ].filter(Boolean);

  return (
    <div className="stack">
      <PageHeader title="Activity" />
      <input type="search" placeholder="Search descriptions and notes" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="chips">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" className={`filter-chip ${filter === f.value ? 'active' : ''}`} onClick={() => setParam({ filter: f.value })}>
            {f.label}
          </button>
        ))}
      </div>
      {activeContext.length > 0 && (
        <div className="banner">
          <span>{activeContext.join(' · ')}</span>
          <Button small variant="ghost" onClick={() => go('activity', { filter })}>
            Clear
          </Button>
        </div>
      )}

      {error && <ErrorNote message={error} onRetry={() => setRefreshKey((k) => k + 1)} />}
      {loading && !items.length ? (
        <Loading />
      ) : !items.length ? (
        <Empty title={filter === 'uncategorized' ? 'All sorted!' : 'Nothing here yet'}>
          {filter === 'uncategorized' ? 'Every transaction has a home.' : 'Connect a bank or import a file from More › Accounts.'}
        </Empty>
      ) : (
        <div className="list">
          {groups.map(([date, txns]) => (
            <Fragment key={date}>
              <div className="date-heading">{weekdayDate(date)}</div>
              {txns.map((t) => (
                <TransactionRow key={t.id} t={t} onClick={() => setOpen(t)} />
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

      <button type="button" className="fab" aria-label="Add a transaction" onClick={() => setAdding(true)}>
        +
      </button>

      {open && (
        <TransactionSheet
          txn={open}
          onClose={() => setOpen(null)}
          onChanged={handleChanged}
          onNext={filter === 'uncategorized' ? nextUncategorized : undefined}
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
    </div>
  );
}

function TransactionRow({ t, onClick }: { t: Transaction; onClick: () => void }) {
  const { categories, me } = useApp();
  const kid = me.kids.find((k) => k.id === t.kidId);
  const needsCategory = t.categoryId === null && !t.isSplit && !t.isIgnored && !t.transferPairId;
  return (
    <button type="button" className="row row-button" onClick={onClick}>
      <div className="row-main">
        <div className="row-title">
          {t.isPrivate && '🔒 '}
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
    </button>
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
      {me.kids.length > 0 && (
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
