import { useEffect, useState } from 'react';
import { addMonths, monthOf } from '../../shared/dates';
import type { PayoffPlan } from '../../shared/debt';
import type { GoalProgress } from '../../shared/goals';
import type { DebtRow } from '../aheadPlan';
import { useMoneyText } from '../amounts';
import { api, errorMessage, patch, post } from '../api';
import { monthShortLabel, shortDate } from '../format';
import { go } from '../router';
import { useApp, useLoad } from '../state';
import { AmountInput, Button, Card, CategorySelect, Empty, ErrorNote, Field, Loading, Money, Progress, Segmented, Sheet } from '../ui';
import { DebtFlagChips, DebtSheet } from './DebtSheet';
import { PlannedCostsSection } from './PlannedCosts';

type Tab = 'goals' | 'debts';

/** The Goals view inside Plan (#/plan?view=goals&tab=debts). */
export function Goals({ params }: { params: URLSearchParams }) {
  const tab = (params.get('tab') as Tab) || 'goals';
  return (
    <div className="stack">
      <Segmented
        value={tab}
        onChange={(t) => go('plan', { view: 'goals', tab: t })}
        options={[
          { value: 'goals', label: 'Savings goals' },
          { value: 'debts', label: 'Debt payoff' },
        ]}
      />
      {tab === 'goals' ? (
        <>
          <PlannedCostsSection />
          <section className="stack" aria-labelledby="goals-title">
            <div className="section-title">
              <h3 id="goals-title">Savings goals</h3>
            </div>
            <GoalsView />
          </section>
        </>
      ) : (
        <DebtsView />
      )}
    </div>
  );
}

export interface Goal {
  id: number;
  name: string;
  targetCents: number;
  targetDate: string | null;
  categoryId: number | null;
  categoryName: string | null;
  startingSavedCents: number;
  savedCents: number;
  progress: GoalProgress;
}

const STATUS_LABEL: Record<GoalProgress['status'], { text: string; className: string }> = {
  done: { text: 'Done!', className: 'chip chip-brand' },
  on_track: { text: 'On track', className: 'chip chip-brand' },
  behind: { text: 'Behind', className: 'chip chip-warn' },
  no_date: { text: 'No date', className: 'chip' },
};

function GoalsView() {
  const goals = useLoad(() => api<Goal[]>('/goals'), []);
  const [editing, setEditing] = useState<Goal | 'new' | null>(null);

  if (goals.error) return <ErrorNote message={goals.error} onRetry={() => void goals.reload()} />;
  if (!goals.data) return <Loading />;

  return (
    <>
      {goals.data.length === 0 ? (
        <Empty title="No goals yet">An emergency fund is a great first one: it turns surprises into non-events.</Empty>
      ) : (
        goals.data.map((g) => (
          <Card key={g.id} onClick={() => setEditing(g)}>
            <div className="spread">
              <strong>{g.name}</strong>
              <span className={STATUS_LABEL[g.progress.status].className}>{STATUS_LABEL[g.progress.status].text}</span>
            </div>
            <div className="spread" style={{ margin: '6px 0' }}>
              <Money cents={g.savedCents} whole className="big" />
              <span className="muted">of <Money cents={g.targetCents} whole /></span>
            </div>
            <Progress value={g.savedCents} max={g.targetCents} tone="good" />
            <p className="muted small">
              {g.progress.monthlyNeededCents !== null && g.progress.status !== 'done'
                ? <><Money cents={g.progress.monthlyNeededCents} whole />/month to reach it by {g.targetDate ? shortDate(g.targetDate) : ''}. </>
                : ''}
              {g.progress.recentAverageCents > 0 && <>Lately about <Money cents={g.progress.recentAverageCents} whole />/month.</>}
            </p>
          </Card>
        ))
      )}
      <Button variant="primary" onClick={() => setEditing('new')}>
        Add a goal
      </Button>
      <p className="muted small">
        Money you file under a goal’s category counts toward it, including transfers into savings.
      </p>
      {editing && (
        <GoalSheet
          goal={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await goals.reload();
          }}
        />
      )}
    </>
  );
}

export function GoalSheet({ goal, onClose, onSaved }: { goal: Goal | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { toast, reload } = useApp();
  const [name, setName] = useState(goal?.name ?? '');
  const [target, setTarget] = useState<number | null>(goal?.targetCents ?? null);
  const [date, setDate] = useState(goal?.targetDate ?? '');
  const [starting, setStarting] = useState<number | null>(goal?.startingSavedCents ?? 0);
  const [categoryId, setCategoryId] = useState<number | null>(goal?.categoryId ?? null);

  async function save() {
    try {
      const body = { name, targetCents: target, targetDate: date || null, startingSavedCents: starting ?? 0, categoryId };
      if (goal) await patch(`/goals/${goal.id}`, body);
      else await post('/goals', body);
      await reload();
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function archive() {
    if (!goal || !window.confirm(`Archive “${goal.name}”?`)) return;
    try {
      await patch(`/goals/${goal.id}`, { archived: true });
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title={goal ? goal.name : 'New goal'}>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Emergency fund" />
      </Field>
      <div className="grid-2">
        <Field label="Target">
          <AmountInput cents={target} onChange={setTarget} />
        </Field>
        <Field label="By (optional)">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <Field label="Already saved" hint="What’s set aside today, before the app started tracking.">
        <AmountInput cents={starting} onChange={setStarting} />
      </Field>
      <Field label="Counts money filed under" hint={goal ? undefined : 'Leave empty to create a category with the goal’s name.'}>
        <CategorySelect value={categoryId} onChange={setCategoryId} noneLabel={goal ? 'None' : 'New category'} filter={(c) => c.kind === 'savings' || c.kind === 'debt'} />
      </Field>
      <div className="cluster">
        <Button variant="primary" onClick={() => void save()} disabled={!name || !target}>
          Save
        </Button>
        {goal && (
          <Button variant="danger" onClick={() => void archive()}>
            Archive
          </Button>
        )}
      </div>
    </Sheet>
  );
}

function DebtsView() {
  const { me } = useApp();
  const moneyText = useMoneyText();
  const debts = useLoad(() => api<DebtRow[]>('/debts'), []);
  const [extra, setExtra] = useState(10000);
  const [plan, setPlan] = useState<{ snowball: PayoffPlan; avalanche: PayoffPlan } | null>(null);
  const [editing, setEditing] = useState<DebtRow | 'new' | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api<{ snowball: PayoffPlan; avalanche: PayoffPlan }>(`/debts/plan?extra=${extra}`)
        .then(setPlan)
        .catch(() => setPlan(null));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [extra, debts.data]);

  if (debts.error) return <ErrorNote message={debts.error} onRetry={() => void debts.reload()} />;
  if (!debts.data) return <Loading />;

  const debtFree = (months: number | null) =>
    months === null ? 'Not with these payments' : months === 0 ? 'Now' : monthShortLabel(addMonths(monthOf(me.today), months));
  const names = new Map(debts.data.map((d) => [d.id, d.name]));
  const better = plan && plan.avalanche.totalInterestCents < plan.snowball.totalInterestCents ? 'avalanche' : 'snowball';
  const paying = debts.data.filter((d) => !d.paidInFull);
  const paidInFull = debts.data.filter((d) => d.paidInFull);

  const row = (d: DebtRow) => (
    <button key={d.id} type="button" className="row row-button" onClick={() => setEditing(d)}>
      <div className="row-main">
        <div className="row-title">{d.name}</div>
        <div className="row-sub">
          {d.paidInFull ? (
            'Paid in full each month'
          ) : (
            <>
              {d.aprPercent > 0 ? `${d.aprPercent}% APR · ` : ''}min <Money cents={d.minPaymentCents} />
              {d.source === 'plaid' && ' · from bank'}
            </>
          )}
          <DebtFlagChips debt={d} />
        </div>
      </div>
      <Money cents={d.balanceCents} />
    </button>
  );

  return (
    <>
      {debts.data.length === 0 ? (
        <Empty title="No debts tracked">Linked credit cards and loans show up here automatically. You can also add one.</Empty>
      ) : (
        <>
          {paying.length > 0 && <div className="list">{paying.map(row)}</div>}
          {paidInFull.length > 0 && (
            <section className="stack-sm" aria-labelledby="paid-in-full-title">
              <div className="section-title">
                <h3 id="paid-in-full-title">Paid in full</h3>
              </div>
              <p className="muted small">Cleared every month, so they’re left out of payoff. Tap one to change that.</p>
              <div className="list">{paidInFull.map(row)}</div>
            </section>
          )}
        </>
      )}
      <div className="cluster">
        <Button onClick={() => setEditing('new')}>＋ Add a debt</Button>
        <Button variant="ghost" onClick={() => go('plan', { view: 'ahead' })}>
          Plan where extra goes
        </Button>
      </div>

      {plan && paying.some((d) => d.balanceCents > 0) && (
        <Card>
          <h2>Payoff plan</h2>
          <Field label={`Extra each month on top of minimums: ${moneyText(extra, { whole: true })}`}>
            <input
              type="range"
              min={0}
              max={200000}
              step={2500}
              value={extra}
              aria-valuetext={moneyText(extra, { whole: true })}
              onChange={(e) => setExtra(Number(e.target.value))}
            />
          </Field>
          <table className="compare">
            <thead>
              <tr>
                <th>Method</th>
                <th>Debt-free</th>
                <th>Interest</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  Snowball <span className="muted small">smallest first</span>
                </td>
                <td>{debtFree(plan.snowball.months)}</td>
                <td><Money cents={plan.snowball.totalInterestCents} whole /></td>
              </tr>
              <tr>
                <td>
                  Avalanche <span className="muted small">highest rate first</span>
                </td>
                <td>{debtFree(plan.avalanche.months)}</td>
                <td><Money cents={plan.avalanche.totalInterestCents} whole /></td>
              </tr>
            </tbody>
          </table>
          <p className="muted small">
            Order ({better}): {plan[better].order.map((id) => names.get(Number(id)) ?? id).join(' → ')}. Snowball gives quick wins;
            avalanche costs less. Pick together.
          </p>
          {plan.avalanche.minimumBelowInterest.length > 0 && (
            <div className="banner banner-bad">
              <span>
                {plan.avalanche.minimumBelowInterest.map((id) => names.get(Number(id))).join(', ')}: the minimum payment doesn’t cover
                the interest. Paying only the minimum, it never goes away.
              </span>
            </div>
          )}
        </Card>
      )}

      {editing && (
        <DebtSheet
          debt={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await debts.reload();
          }}
        />
      )}
    </>
  );
}
