import { useState } from 'react';
import { DEBT_KINDS, type DebtKind } from '../../shared/planAhead';
import { debtFlags, KIND_LABEL, monthChoices, suggestBill, type DebtRow } from '../aheadPlan';
import { api, errorMessage, patch, post } from '../api';
import { centsToInput, shortDate } from '../format';
import { useApp, useLoad } from '../state';
import { AmountInput, Button, CategorySelect, Field, Money, Sheet, Toggle } from '../ui';

interface ConfirmedBill {
  id: number;
  name: string;
  merchant: string;
}

/** "Add the interest rate" and "estimated minimum": shown on a debt's row, in Goals › Debts and in Plan › Ahead. */
export function DebtFlagChips({ debt }: { debt: DebtRow }) {
  const flags = debtFlags(debt);
  return (
    <>
      {flags.noRate && <span className="chip chip-warn">Add the interest rate</span>}
      {flags.estimated && <span className="chip">Minimum estimated</span>}
    </>
  );
}

/**
 * ＋ Add a debt, or edit one: anything not at a bank (a car or student loan, a medical bill, money owed to
 * family…), or a card or loan the bank links. A linked debt's balance comes from its account. A blank minimum is
 * estimated until one is typed in. Linking it to a bill or a budget category counts its minimum once (P7-R8);
 * a matching bill is suggested, never linked silently.
 */
export function DebtSheet({ debt, onClose, onSaved }: { debt: DebtRow | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { toast, me } = useApp();
  const bills = useLoad(() => api<ConfirmedBill[]>('/recurring?status=confirmed'), []);
  const linked = debt?.accountId != null;
  const [name, setName] = useState(debt?.name ?? '');
  const [kind, setKind] = useState<DebtKind>(debt?.kind ?? 'other');
  const [balance, setBalance] = useState<number | null>(debt?.balanceCents ?? null);
  const [apr, setApr] = useState(debt && debt.aprPercent > 0 ? String(debt.aprPercent) : '');
  // An estimated minimum shows as a placeholder: left alone, it stays an estimate.
  const [min, setMin] = useState<number | null>(debt && !debt.minEstimated ? debt.minPaymentCents : null);
  const [dueDay, setDueDay] = useState(debt?.dueDay ? String(debt.dueDay) : '');
  const [endMonth, setEndMonth] = useState(debt?.endMonth ?? '');
  const [billId, setBillId] = useState<number | null>(debt?.billId ?? null);
  const [categoryId, setCategoryId] = useState<number | null>(debt?.categoryId ?? null);
  const [paidInFull, setPaidInFull] = useState(debt?.paidInFull ?? false);
  const [saving, setSaving] = useState(false);

  const billList = bills.data ?? [];
  // Keep a linked bill that isn't confirmed any more in the list, so the select shows it.
  const billOptions = debt?.billId && !billList.some((b) => b.id === debt.billId) ? [{ id: debt.billId, name: debt.billName ?? 'A bill', merchant: '' }, ...billList] : billList;
  const suggestion =
    billId === null
      ? debt
        ? debt.suggestedBillId !== null
          ? { id: debt.suggestedBillId, name: debt.suggestedBillName ?? '' }
          : null
        : suggestBill(name, billList)
      : null;
  const endChoices = monthChoices(me.today, 60, 1);
  if (endMonth && !endChoices.some((c) => c.value === endMonth)) endChoices.unshift({ value: endMonth, label: endMonth });
  const flags = debt ? debtFlags(debt) : null;

  async function save() {
    const aprPercent = apr.trim() === '' ? 0 : Number(apr);
    if (!Number.isFinite(aprPercent) || aprPercent < 0 || aprPercent > 100) {
      toast('The interest rate is a percent from 0 to 100.', 'error');
      return;
    }
    const day = dueDay ? Number(dueDay) : null;
    setSaving(true);
    try {
      if (!debt) {
        await post('/debts', {
          name: name.trim(),
          kind,
          balanceCents: balance ?? 0,
          aprPercent,
          ...(min === null ? {} : { minPaymentCents: min }),
          dueDay: day,
          endMonth: endMonth || null,
          billId,
          categoryId,
        });
      } else {
        // Only what changed: a linked balance can't be sent, and a minimum left alone stays estimated.
        const body: Record<string, unknown> = {};
        if (name.trim() !== debt.name) body.name = name.trim();
        if (kind !== debt.kind) body.kind = kind;
        if (!linked && balance !== null && balance !== debt.balanceCents) body.balanceCents = balance;
        if (aprPercent !== debt.aprPercent) body.aprPercent = aprPercent;
        if (min !== null && (debt.minEstimated || min !== debt.minPaymentCents)) body.minPaymentCents = min;
        if (day !== debt.dueDay) body.dueDay = day;
        if ((endMonth || null) !== debt.endMonth) body.endMonth = endMonth || null;
        if (billId !== debt.billId) body.billId = billId;
        if (categoryId !== debt.categoryId) body.categoryId = categoryId;
        if (paidInFull !== debt.paidInFull) body.paidInFull = paidInFull;
        if (Object.keys(body).length) await patch(`/debts/${debt.id}`, body);
      }
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    if (!debt || !window.confirm(`Remove “${debt.name}”? Use this when it’s paid off.`)) return;
    try {
      await patch(`/debts/${debt.id}`, { archived: true });
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title={debt ? debt.name : 'Add a debt'}>
      <form
        className="stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Car loan" maxLength={60} autoFocus={!debt} />
        </Field>
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value as DebtKind)}>
            {DEBT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        {linked ? (
          <p className="small">
            Balance <Money cents={debt!.balanceCents} /> <span className="muted">from {debt!.accountName ?? 'the bank'}, kept up to date.</span>
          </p>
        ) : (
          <Field label="Balance" hint={debt?.balanceAsOf ? `Balance as of ${shortDate(debt.balanceAsOf)}. Update it now and then.` : undefined}>
            <AmountInput cents={balance} onChange={setBalance} />
          </Field>
        )}
        <div className="grid-2">
          <Field label="Interest rate (APR %)" hint={flags?.noRate ? 'Add it for a payoff date with interest.' : 'Optional'}>
            <input inputMode="decimal" value={apr} onChange={(e) => setApr(e.target.value)} placeholder="24.99" />
          </Field>
          <Field label="Due day" hint="Of the month">
            <input type="number" inputMode="numeric" min={1} max={31} value={dueDay} onChange={(e) => setDueDay(e.target.value)} placeholder="15" />
          </Field>
        </div>
        <Field
          label="Minimum payment"
          hint={
            min === null ? (
              debt?.minEstimated ? (
                <>
                  Estimated at <Money cents={debt.minPaymentCents} />: the larger of <Money cents={2500} whole /> and 1% of the balance plus a month’s interest. Type
                  the real one.
                </>
              ) : (
                'Leave empty to estimate it.'
              )
            ) : undefined
          }
        >
          <AmountInput cents={min} onChange={setMin} placeholder={debt?.minEstimated ? centsToInput(debt.minPaymentCents) : 'Estimate'} />
        </Field>
        <Field label="Last payment" hint="For a fixed-term loan, like buy now, pay later in 4 payments.">
          <select value={endMonth} onChange={(e) => setEndMonth(e.target.value)}>
            <option value="">No end date</option>
            {endChoices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Paid by a bill" hint="Linked, its minimum counts once: as that bill.">
          <select value={billId ?? ''} onChange={(e) => setBillId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Not linked</option>
            {billOptions.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        {suggestion && (
          <div className="debt-suggest">
            <span className="small">
              Looks like the bill <strong>{suggestion.name}</strong>.
            </span>
            <Button small onClick={() => setBillId(suggestion.id)}>
              Link it
            </Button>
          </div>
        )}
        <Field label="Or a budget category" hint="Its budget line pays it: the minimum counts once, as that line.">
          <CategorySelect value={categoryId} onChange={setCategoryId} noneLabel="Not linked" filter={(c) => c.kind === 'debt' || c.kind === 'expense'} />
        </Field>
        {debt && (
          <Toggle
            checked={paidInFull}
            onChange={setPaidInFull}
            label="Paid in full each month"
            hint="Left out of payoff, the sliders and the debt total: its spending already counts as everyday."
          />
        )}
        <div className="cluster">
          <Button type="submit" variant="primary" disabled={!name.trim() || saving}>
            {debt ? 'Save' : 'Add the debt'}
          </Button>
          {debt && (
            <Button variant="danger" onClick={() => void archive()}>
              Paid off / remove
            </Button>
          )}
        </div>
      </form>
    </Sheet>
  );
}
