import { useEffect, useRef, useState } from 'react';
import { alsoFileOnTick } from '../alsoFile';
import { api, del, errorMessage, patch, post, put } from '../api';
import { money, plural, weekdayDate } from '../format';
import { useApp } from '../state';
import type { CategoryMove, Split, Transaction } from '../types';
import { AmountInput, Button, CategorySelect, Field, KidSelect, Money, Sheet, Toggle } from '../ui';

export function TransactionSheet({
  txn,
  onClose,
  onChanged,
  onNext,
  focusCategory,
}: {
  txn: Transaction;
  /** Put focus on the category picker (the `c` shortcut). */
  focusCategory?: boolean;
  onClose: () => void;
  /** Called with the updated row, or null when it was removed. */
  onChanged: (updated: Transaction | null, refreshAll?: boolean) => void;
  onNext?: () => void;
}) {
  const { me, toast, reload } = useApp();
  const [t, setT] = useState(txn);
  const [notes, setNotes] = useState(txn.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [similar, setSimilar] = useState<{ count: number; merchant: string } | null>(null);
  const [alsoFile, setAlsoFile] = useState(false);
  /** A category was picked in this sheet (ticking "Also file" then files the others at once). */
  const [pickedThisSession, setPickedThisSession] = useState(false);
  const [similarTick, setSimilarTick] = useState(0);
  const categoryRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (focusCategory) categoryRef.current?.focus();
  }, [focusCategory, txn.id]);

  // How many other charges "also file" would move, for the category it has now (or none yet).
  useEffect(() => {
    if (t.isSplit) {
      setSimilar(null);
      return;
    }
    let cancelled = false;
    const qs = t.categoryId ? `?categoryId=${t.categoryId}` : '';
    api<{ count: number; merchant: string }>(`/transactions/${t.id}/similar${qs}`)
      .then((res) => !cancelled && setSimilar(res))
      .catch(() => !cancelled && setSimilar(null));
    return () => {
      cancelled = true;
    };
  }, [t.id, t.categoryId, t.isSplit, similarTick]);

  useEffect(() => {
    setT(txn);
    setNotes(txn.notes ?? '');
    setSplitting(false);
    setAlsoFile(false);
    setPickedThisSession(false);
    if (txn.transferPairId) {
      api<Transaction>(`/transactions/${txn.id}`)
        .then(setT)
        .catch(() => undefined);
    }
  }, [txn]);

  async function update(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await patch<{ transaction: Transaction | null; move: CategoryMove | null }>(`/transactions/${t.id}`, body);
      if (res.transaction) setT(res.transaction);
      onChanged(res.transaction, !!res.move?.moved);
      if (res.move) {
        showMove({ ...res.move, tappedId: t.id });
        setAlsoFile(false);
        setSimilarTick((n) => n + 1);
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  /** "Moved 41 Shell charges to Habits · Undo". Undo may run after the sheet has closed. */
  function showMove(move: CategoryMove & { tappedId: number }) {
    const merchant = merchantLabel(t, move.merchant);
    const text = move.moved
      ? `Moved ${plural(move.moved, `${merchant} charge`)} to ${move.categoryName}`
      : `${merchant} goes to ${move.categoryName} from now on`;
    toast(text, 'ok', {
      action: {
        label: 'Undo',
        run: () => {
          post(`/category-moves/${move.id}/undo`)
            .then(() => {
              onChanged(null, true);
              void reload();
              toast('Undone');
              setSimilarTick((n) => n + 1);
              // Undo put the tapped charge back too; show that if the sheet is still open.
              api<Transaction>(`/transactions/${move.tappedId}`)
                .then((restored) => setT((current) => (current.id === restored.id ? restored : current)))
                .catch(() => undefined);
            })
            .catch((error: unknown) => toast(errorMessage(error), 'error'));
        },
      },
    });
  }

  async function unlinkTransfer() {
    try {
      await post(`/transactions/${t.id}/unlink-transfer`);
      const updated = { ...t, transferPairId: null, transferPair: null };
      setT(updated);
      onChanged(updated, true);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function remove() {
    if (!window.confirm('Delete this transaction?')) return;
    try {
      await del(`/transactions/${t.id}`);
      onChanged(null, true);
      onClose();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  const isMine = t.privateMemberId === me.viewer.memberId;
  return (
    <Sheet open onClose={onClose} title={t.merchantName ?? t.name}>
      <div className="spread">
        <div>
          <div className="muted small">
            {weekdayDate(t.date)} · {t.accountName}
            {t.pending ? ' · pending' : ''}
          </div>
          {t.merchantName && <div className="muted small">{t.name}</div>}
        </div>
        <Money cents={t.amountCents} signed={t.amountCents > 0} tone={t.amountCents > 0 ? 'good' : undefined} className="big" />
      </div>

      {t.transferPairId && (
        <div className="banner">
          <span>
            Money moved between your own accounts{t.transferPair ? ` (${t.transferPair.accountName})` : ''}. It isn’t counted as
            spending unless you give it a savings or debt category.
          </span>
          <Button small onClick={() => void unlinkTransfer()}>
            Not a transfer
          </Button>
        </div>
      )}

      {!t.isSplit && (
        <div className="stack-sm">
          <Field label="Category" hint={categoryHint(t)}>
            <CategorySelect
              selectRef={categoryRef}
              value={t.categoryId}
              // One charge only, unless "Also file…" is ticked.
              onChange={(id) => {
                if (id !== null) setPickedThisSession(true);
                void update(id === null ? { categoryId: null } : { categoryId: id, alsoSimilar: alsoFile });
              }}
            />
          </Field>
          {similar && similar.count > 0 && (
            <label className="check-row also-file">
              <input
                type="checkbox"
                checked={alsoFile}
                disabled={busy}
                onChange={(e) => {
                  const on = e.target.checked;
                  setAlsoFile(on);
                  // Right after a pick here: file the others now. Otherwise it rides along with the next pick.
                  if (alsoFileOnTick({ checked: on, pickedThisSession, categoryId: t.categoryId }) === 'learn-now') {
                    void update({ categoryId: t.categoryId, alsoSimilar: true });
                  }
                }}
              />
              <span>
                Also file {plural(similar.count, `other ${merchantLabel(t, similar.merchant)} charge`)} this way, and new ones
              </span>
            </label>
          )}
          {t.categoryId !== null && (
            <a className="edit-link small" href={`#/more/categories?id=${t.categoryId}`}>
              Edit category
            </a>
          )}
        </div>
      )}


      {t.amountCents < 0 && !t.pending && <BillToggle txnId={t.id} />}

      {/* With no kids yet, a money-out charge still offers "＋ Add a kid". */}
      {!t.isSplit && (me.kids.length > 0 || t.amountCents < 0) && (
        <Field label="For which kid?">
          <KidSelect value={t.kidId} onChange={(id) => void update({ kidId: id })} />
        </Field>
      )}

      {t.amountCents < 0 && !t.isSplit && (
        <Toggle
          checked={isMine}
          onChange={(v) => void update({ isPrivate: v })}
          label="My fun money"
          hint="Only you see this purchase. Your partner just sees your remaining total."
        />
      )}

      <Toggle
        checked={t.isIgnored}
        onChange={(v) => void update({ isIgnored: v })}
        label="Leave out of the budget"
        hint="For duplicates, reimbursements, or anything that isn’t really spending."
      />

      <Field label="Notes">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (t.notes ?? '') && void update({ notes })}
          placeholder="Anything worth remembering"
        />
      </Field>

      {t.isSplit || splitting ? (
        <SplitEditor
          txn={t}
          onCancel={() => setSplitting(false)}
          onSaved={(updated) => {
            setT(updated);
            setSplitting(false);
            onChanged(updated);
          }}
        />
      ) : (
        t.amountCents !== 0 && (
          <Button variant="ghost" onClick={() => setSplitting(true)}>
            Split across categories or kids
          </Button>
        )
      )}

      <div className="cluster">
        {onNext && (
          <Button variant="primary" onClick={onNext} disabled={busy}>
            Next
          </Button>
        )}
        {t.source !== 'plaid' && (
          <Button variant="danger" onClick={() => void remove()}>
            Delete
          </Button>
        )}
      </div>
    </Sheet>
  );
}

type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
interface Bill {
  id: number;
  name: string;
  cadence: Cadence;
  amountCents: number;
  status: 'suggested' | 'confirmed' | 'dismissed';
}
interface BillGuess {
  name: string;
  cadence: Cadence;
  amountCents: number;
}

const CADENCES: { value: Cadence; label: string }[] = [
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Every month' },
  { value: 'quarterly', label: 'Every 3 months' },
  { value: 'yearly', label: 'Every year' },
];

/** Marks this charge's merchant as a bill, for bills "Find them" misses. */
function BillToggle({ txnId }: { txnId: number }) {
  const { toast } = useApp();
  const [bill, setBill] = useState<Bill | null>(null);
  const [guess, setGuess] = useState<BillGuess | null>(null);
  const [editing, setEditing] = useState(false);
  const [cadence, setCadence] = useState<Cadence>('monthly');
  const [amount, setAmount] = useState<number | null>(null);

  useEffect(() => {
    setBill(null);
    setGuess(null);
    setEditing(false);
    api<{ bill: Bill | null; guess: BillGuess | null }>(`/transactions/${txnId}/bill`)
      .then((res) => {
        setBill(res.bill);
        setGuess(res.guess);
      })
      .catch(() => undefined);
  }, [txnId]);

  if (!guess) return null;
  const isBill = bill?.status === 'confirmed';

  function startEditing() {
    const from = isBill && bill ? bill : guess!;
    setCadence(from.cadence);
    setAmount(from.amountCents);
    setEditing(true);
  }

  async function save(body: Record<string, unknown>) {
    try {
      const res = await put<{ bill: Bill | null }>(`/transactions/${txnId}/bill`, body);
      setBill(res.bill);
      setEditing(false);
      toast(res.bill ? `${res.bill.name} saved as a bill` : 'No longer a bill');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <div className="stack-sm">
      <Toggle
        checked={isBill || editing}
        onChange={(v) => (v ? startEditing() : isBill ? void save({ isBill: false, billId: bill?.id }) : setEditing(false))}
        label="This is a bill"
        hint={
          isBill && bill && !editing
            ? `${CADENCES.find((c) => c.value === bill.cadence)?.label ?? ''}, about ${money(bill.amountCents)}. Shows in Plan › Bills and upcoming bills.`
            : 'It repeats, like rent, a utility, or a subscription.'
        }
      />
      {isBill && !editing && (
        <Button small variant="ghost" onClick={startEditing}>
          Change how often or how much
        </Button>
      )}
      {editing && (
        <div className="card stack-sm">
          <div className="grid-2">
            <Field label="How often">
              <select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
                {CADENCES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Usually about">
              <AmountInput cents={amount} onChange={setAmount} />
            </Field>
          </div>
          <div className="cluster">
            <Button small variant="primary" disabled={!amount} onClick={() => void save({ isBill: true, billId: bill?.id, cadence, amountCents: amount })}>
              Save bill
            </Button>
            <Button small variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SplitEditor({ txn, onCancel, onSaved }: { txn: Transaction; onCancel: () => void; onSaved: (t: Transaction) => void }) {
  const { toast } = useApp();
  const sign = txn.amountCents < 0 ? -1 : 1;
  const total = Math.abs(txn.amountCents);
  const [parts, setParts] = useState<Split[]>(
    txn.splits.length
      ? txn.splits.map((s) => ({ ...s, amountCents: Math.abs(s.amountCents) }))
      : [
          { categoryId: txn.categoryId, kidId: txn.kidId, amountCents: total },
          { categoryId: null, kidId: null, amountCents: 0 },
        ],
  );
  const assigned = parts.reduce((sum, p) => sum + p.amountCents, 0);
  const left = total - assigned;

  function change(i: number, patchPart: Partial<Split>) {
    setParts((list) => list.map((p, j) => (j === i ? { ...p, ...patchPart } : p)));
  }

  async function save(clear = false) {
    try {
      const updated = await put<Transaction>(`/transactions/${txn.id}/splits`, {
        splits: clear ? [] : parts.filter((p) => p.amountCents !== 0).map((p) => ({ ...p, amountCents: sign * p.amountCents })),
      });
      onSaved(updated);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <div className="card stack-sm">
      <div className="spread">
        <h3>Split</h3>
        <span className={left === 0 ? 'muted small' : 'tone-warn small'}>
          {left === 0 ? 'All assigned' : `${money(left)} ${left > 0 ? 'left' : 'too much'}`}
        </span>
      </div>
      {parts.map((part, i) => (
        <div key={i} className="stack-sm" style={{ borderTop: i ? '1px solid var(--hairline)' : undefined, paddingTop: i ? 8 : 0 }}>
          <CategorySelect value={part.categoryId} onChange={(id) => change(i, { categoryId: id })} filter={(c) => c.funMemberId === null} />
          <div className="grid-2">
            <KidSelect value={part.kidId} onChange={(id) => change(i, { kidId: id })} />
            <AmountInput cents={part.amountCents} onChange={(cents) => change(i, { amountCents: cents ?? 0 })} />
          </div>
        </div>
      ))}
      <div className="cluster">
        <Button small onClick={() => setParts((list) => [...list, { categoryId: null, kidId: null, amountCents: Math.max(0, left) }])}>
          Add part
        </Button>
        <Button small variant="primary" onClick={() => void save()} disabled={left !== 0}>
          Save split
        </Button>
        {txn.isSplit ? (
          <Button small variant="danger" onClick={() => void save(true)}>
            Remove split
          </Button>
        ) : (
          <Button small variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

/** Why a charge sits in its category: the app's reason, or "Set by you" for a hand pick. */
function categoryHint(t: Transaction): string | undefined {
  if (t.categoryId === null) return undefined;
  if (t.categorySource === 'user') return 'Set by you';
  return t.categoryReason ?? undefined;
}

/** "Shell" for "SHELL": the charge's merchant name when it has one, else the learned key in title case. */
function merchantLabel(t: Transaction, key: string): string {
  if (t.merchantName) return t.merchantName;
  return key.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
}
