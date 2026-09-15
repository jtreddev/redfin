import { useEffect, useState } from 'react';
import { api, del, errorMessage, patch, post, put } from '../api';
import { money, plural, weekdayDate } from '../format';
import { categoryName, useApp } from '../state';
import type { RuleSuggestion, Split, Transaction } from '../types';
import { AmountInput, Button, CategorySelect, Field, KidSelect, Money, Sheet, Toggle } from '../ui';

export function TransactionSheet({
  txn,
  onClose,
  onChanged,
  onNext,
}: {
  txn: Transaction;
  onClose: () => void;
  /** Called with the updated row, or null when it was removed. */
  onChanged: (updated: Transaction | null, refreshAll?: boolean) => void;
  onNext?: () => void;
}) {
  const { me, categories, toast } = useApp();
  const [t, setT] = useState(txn);
  const [notes, setNotes] = useState(txn.notes ?? '');
  const [suggestion, setSuggestion] = useState<RuleSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [splitting, setSplitting] = useState(false);

  useEffect(() => {
    setT(txn);
    setNotes(txn.notes ?? '');
    setSuggestion(null);
    setSplitting(false);
    if (txn.transferPairId) {
      api<Transaction>(`/transactions/${txn.id}`)
        .then(setT)
        .catch(() => undefined);
    }
  }, [txn]);

  async function update(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await patch<{ transaction: Transaction | null; suggestion: RuleSuggestion | null }>(`/transactions/${t.id}`, body);
      if (res.transaction) setT(res.transaction);
      setSuggestion(res.suggestion);
      onChanged(res.transaction);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function acceptRule() {
    if (!suggestion) return;
    try {
      const res = await post<{ updated: number }>('/rules', {
        matchField: suggestion.matchField,
        matchText: suggestion.matchText,
        categoryId: suggestion.categoryId,
        applyToExisting: true,
      });
      toast(res.updated ? `Rule saved and ${plural(res.updated, 'transaction')} updated` : 'Rule saved');
      setSuggestion(null);
      onChanged(t, true);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
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
        <Field label="Category">
          <CategorySelect value={t.categoryId} onChange={(id) => void update({ categoryId: id })} />
        </Field>
      )}

      {suggestion && (
        <div className="banner banner-good">
          <span>
            Always file “{suggestion.matchText}” as {categoryName(categories, suggestion.categoryId)}?
            {suggestion.otherCount > 0 && ` That also fixes ${plural(suggestion.otherCount, 'other transaction')}.`}
          </span>
          <div className="cluster">
            <Button small variant="primary" onClick={() => void acceptRule()}>
              Yes
            </Button>
            <Button small variant="ghost" onClick={() => setSuggestion(null)}>
              No
            </Button>
          </div>
        </div>
      )}

      {me.kids.length > 0 && !t.isSplit && (
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
        <div key={i} className="stack-sm" style={{ borderTop: i ? '1px solid var(--border)' : undefined, paddingTop: i ? 8 : 0 }}>
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
