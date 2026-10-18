import { useState } from 'react';
import { addMonths, monthOf } from '../../shared/dates';
import { api, del, errorMessage, patch, post, put } from '../api';
import { money, plural, shortDate } from '../format';
import { budgetState } from '../budgetState';
import { Icon } from '../icons';
import { go } from '../router';
import { useApp, useLoad } from '../state';
import type { BudgetResponse, BudgetRow, PlannerResponse } from '../types';
import {
  AmountInput,
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Loading,
  Money,
  MonthPicker,
  PageHeader,
  Progress,
  Segmented,
  Sheet,
  StatusDot,
  Toggle,
} from '../ui';
import { Goals } from './Goals';

type Tab = 'budget' | 'weeks' | 'bills';

export function Plan({ params }: { params: URLSearchParams }) {
  const { me } = useApp();
  // Goals live here as their own view (#/plan?view=goals); its own tab param picks goals or debts.
  const goals = params.get('view') === 'goals';
  const tab = (params.get('tab') as Tab) || 'budget';
  const month = params.get('month') ?? monthOf(me.today);
  const setRoute = (next: { tab?: Tab; month?: string }) => go('plan', { tab, month, ...next });

  return (
    <div className="stack">
      <PageHeader title="Plan" />
      <Segmented<Tab | 'goals'>
        value={goals ? 'goals' : tab}
        onChange={(t) => (t === 'goals' ? go('plan', { view: 'goals' }) : go('plan', { tab: t, month: params.get('month') }))}
        options={[
          { value: 'budget', label: 'Budget' },
          { value: 'weeks', label: 'Weeks' },
          { value: 'bills', label: 'Bills' },
          { value: 'goals', label: 'Goals' },
        ]}
      />
      {goals ? (
        <Goals params={params} />
      ) : (
        <>
          <MonthPicker month={month} onChange={(m) => setRoute({ month: m })} />
          {tab === 'budget' && <BudgetView month={month} />}
          {tab === 'weeks' && <WeeksView month={month} />}
          {tab === 'bills' && <BillsView month={month} />}
        </>
      )}
    </div>
  );
}

function BudgetView({ month }: { month: string }) {
  const { toast, reload: reloadApp } = useApp();
  const budget = useLoad(() => api<BudgetResponse>(`/budget?month=${month}`), [month]);
  const [editing, setEditing] = useState<BudgetRow | null>(null);
  const [showAll, setShowAll] = useState(false);

  async function start(kind: 'copy' | 'suggested') {
    try {
      if (kind === 'copy') {
        const res = await post<{ copied: number }>('/budget/copy', { from: addMonths(month, -1), to: month });
        toast(`Copied ${plural(res.copied, 'line')} from last month`);
      } else {
        const res = await post<{ added: number }>('/budget/suggested', { month });
        toast(`Added ${plural(res.added, 'starter line')}. Adjust them to fit your family.`);
      }
      await Promise.all([budget.reload(), reloadApp()]);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  if (budget.error) return <ErrorNote message={budget.error} onRetry={() => void budget.reload()} />;
  const b = budget.data;
  if (!b) return <Loading />;

  const left = b.totals.incomeBudgetCents - b.totals.outBudgetCents;
  const visibleRows = b.rows.filter((r) => r.kind !== 'transfer' && (showAll || r.budgetCents > 0 || r.actualCents > 0 || r.lineId !== null));
  const sections = [...new Set(visibleRows.map((r) => r.sectionName))];

  return (
    <>
      <Card>
        <h2 className="sr-only">This month’s totals</h2>
        <div className="figures">
          <div className="figure">
            <Money cents={b.totals.incomeActualCents} whole className="big" />
            <div className="label">income, of {money(b.totals.incomeBudgetCents, { whole: true })} expected</div>
          </div>
          <div className="figure">
            <Money cents={b.totals.outActualCents} whole className="big" />
            <div className="label">spending and saving, of {money(b.totals.outBudgetCents, { whole: true })} planned</div>
          </div>
        </div>
        <p className={left < 0 ? 'tone-bad' : 'muted'}>
          {left === 0
            ? 'Every dollar has a job.'
            : left > 0
              ? `${money(left, { whole: true })} of expected income isn’t planned yet.`
              : `The plan spends ${money(-left, { whole: true })} more than you expect to earn.`}
        </p>
      </Card>

      {!b.hasLines && (
        <Card>
          <h2>Start this month’s budget</h2>
          <div className="cluster">
            {b.previousMonthHasLines && (
              <Button variant="primary" onClick={() => void start('copy')}>
                Copy last month
              </Button>
            )}
            <Button onClick={() => void start('suggested')}>Use starter amounts</Button>
          </div>
        </Card>
      )}

      {b.uncategorized.count > 0 && (
        <div className="banner banner-warn">
          <span>
            {plural(b.uncategorized.count, 'transaction')} ({money(b.uncategorized.outCents, { whole: true })} out) not in a category yet.
          </span>
          <Button small onClick={() => go('activity', { filter: 'uncategorized', month })}>
            Sort
          </Button>
        </div>
      )}

      <div className="columns">
      {sections.map((section) => {
        const rows = visibleRows.filter((r) => r.sectionName === section);
        const planned = rows.reduce((s, r) => s + r.budgetCents, 0);
        const actual = rows.reduce((s, r) => s + r.actualCents, 0);
        return (
          <div key={section}>
            <div className="section-title">
              <h3>{section}</h3>
              <span className="muted small">
                {money(actual, { whole: true })} / {money(planned, { whole: true })}
              </span>
            </div>
            <div className="list">
              {rows.map((row) => {
                const line = (
                  <button
                    key={row.categoryId}
                    type="button"
                    className="row row-button"
                    onClick={() => {
                      if (row.computed === 'paychecks') go('more/income');
                      else if (row.computed === 'fun_money') go('more/fun');
                      else setEditing(row);
                    }}
                  >
                    <div className="row-main stack-sm">
                      <div className="spread">
                        <span className="row-title">{row.name}</span>
                        <span className="small">
                          <Money cents={row.actualCents} whole tone={row.kind !== 'income' && row.budgetCents > 0 && row.actualCents > row.budgetCents ? 'bad' : undefined} />
                          <span className="muted"> / {money(row.budgetCents, { whole: true })}</span>
                        </span>
                      </div>
                      <Progress value={row.actualCents} max={row.budgetCents} tone={row.kind === 'income' ? 'good' : undefined} />
                      <BudgetState row={row} />
                      {row.computed !== 'planned_costs' && (
                        <div className="row-sub">
                          {row.computed === 'paychecks'
                            ? 'From Income & paydays'
                            : row.computed === 'fun_money'
                              ? 'Allowance × paydays'
                              : row.timing === 'due_day' && row.dueDay
                                ? `Due on the ${ordinal(row.dueDay)}`
                                : 'Spread across the month'}
                        </div>
                      )}
                    </div>
                  </button>
                );
                if (row.computed !== 'planned_costs') return line;
                // The row edits the typed part; its planned-costs part has its own tap target.
                return (
                  <div key={row.categoryId} className="setaside-planrow">
                    {line}
                    <button type="button" className="setaside-planlink" onClick={() => go('plan', { view: 'goals' })}>
                      Includes {money(row.plannedCostsCents, { whole: true })} for planned costs
                      <Icon name="forward" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      </div>

      <Toggle checked={showAll} onChange={setShowAll} label="Show every category" hint="To add a budget for something new." />

      {editing && (
        <LineSheet
          month={month}
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await Promise.all([budget.reload(), reloadApp()]);
          }}
        />
      )}
    </>
  );
}

function BudgetState({ row }: { row: BudgetRow }) {
  if (row.kind === 'income') return null;
  const state = budgetState(row.actualCents, row.budgetCents);
  if (!state) return null;
  return (
    <div className={`row-state tone-${state.tone}`}>
      <Icon name={state.tone === 'bad' ? 'alert' : 'gauge'} />
      {state.text}
    </div>
  );
}

function ordinal(n: number) {
  const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

function LineSheet({ month, row, onClose, onSaved }: { month: string; row: BudgetRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const { toast } = useApp();
  // Only the typed part; planned-cost set-asides are added on top by the server.
  const [cents, setCents] = useState<number | null>(row.budgetCents - row.plannedCostsCents);
  const [timing, setTiming] = useState(row.timing);
  const [dueDay, setDueDay] = useState(row.dueDay ?? 1);
  const [notes, setNotes] = useState(row.notes ?? '');

  async function save() {
    try {
      await put('/budget/lines', { month, categoryId: row.categoryId, budgetCents: cents ?? 0, timing, dueDay: timing === 'due_day' ? dueDay : null, notes });
      toast('Saved');
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function remove() {
    if (!row.lineId) return;
    try {
      await del(`/budget/lines/${row.lineId}`);
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title={row.name}>
      <p className="muted">
        So far: {money(row.actualCents)} {row.kind === 'income' ? 'received' : 'spent'} this month.
      </p>
      <Field label="Budget for the month">
        <AmountInput cents={cents} onChange={setCents} autoFocus />
      </Field>
      {row.computed === 'planned_costs' && (
        <div className="setaside-suggest">
          <span className="muted small">Plus {money(row.plannedCostsCents, { whole: true })} for planned costs, added on top.</span>
          <Button variant="ghost" onClick={() => go('plan', { view: 'goals' })}>
            See planned costs
          </Button>
        </div>
      )}
      <Segmented
        value={timing}
        onChange={setTiming}
        options={[
          { value: 'even', label: 'Spread across month' },
          { value: 'due_day', label: 'Due on a day' },
        ]}
      />
      {timing === 'due_day' && (
        <Field label="Day of the month it’s due">
          <input type="number" min={1} max={31} value={dueDay} onChange={(e) => setDueDay(Math.min(31, Math.max(1, Number(e.target.value) || 1)))} />
        </Field>
      )}
      <Field label="Notes">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Rises Nov–Mar" />
      </Field>
      <div className="cluster">
        <Button variant="primary" onClick={() => void save()}>
          Save
        </Button>
        <Button onClick={() => go('activity', { category: row.categoryId, month })}>See transactions</Button>
        {row.lineId && (
          <Button variant="danger" onClick={() => void remove()}>
            Remove
          </Button>
        )}
      </div>
    </Sheet>
  );
}

function WeeksView({ month }: { month: string }) {
  const { toast } = useApp();
  const planner = useLoad(() => api<PlannerResponse>(`/planner?month=${month}`), [month]);
  const [editingStart, setEditingStart] = useState(false);
  const [startCents, setStartCents] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  if (planner.error) return <ErrorNote message={planner.error} onRetry={() => void planner.reload()} />;
  const p = planner.data;
  if (!p) return <Loading />;

  const sourceLabel = {
    manual: 'you entered',
    bank: 'from bank balances',
    previous_month: 'carried from last month’s plan',
    none: 'not set',
  }[p.startingBalance.source];

  async function saveStart(clear: boolean) {
    try {
      await put(`/months/${month}`, { startingBalanceCents: clear ? null : (startCents ?? 0) });
      setEditingStart(false);
      await planner.reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <>
      <Card
        onClick={() => {
          setStartCents(p.startingBalance.cents);
          setEditingStart(true);
        }}
      >
        <span className="spread">
          <span className="figure">
            <Money cents={p.startingBalance.cents} whole className="big" />
            <span className="label">cash on the 1st, {sourceLabel}</span>
          </span>
          <span className="link-like">Edit</span>
        </span>
      </Card>

      {p.forecast.extraPaychecks > 0 && (
        <div className="banner banner-good">
          <span>
            This month has {plural(p.forecast.extraPaychecks, 'extra paycheck')}. Decide together where it goes: a goal, a debt, or
            a cushion.
          </span>
        </div>
      )}

      {p.forecast.weeks.map((week, i) => {
        const bills = p.lines
          .filter((l) => l.timing === 'due_day' && (p.forecast.remainingByLine[String(l.categoryId)]?.[i] ?? 0) > 0)
          .map((l) => ({ name: l.name, cents: p.forecast.remainingByLine[String(l.categoryId)]?.[i] ?? 0, income: l.kind === 'income' }));
        const paydays = p.forecast.payDates.filter((d) => d.weekIndex === week.index);
        return (
          <Card key={week.index} onClick={() => setExpanded(expanded === i ? null : i)} className={week.isCurrent ? 'current-week' : ''}>
            <div className="spread">
              <div>
                <strong>
                  Week {week.index} {week.isCurrent && <span className="chip chip-brand">now</span>}
                </strong>
                <div className="muted small">
                  {shortDate(week.start)}–{shortDate(week.end)}
                  {paydays.length > 0 && ` · payday ${paydays.map((d) => shortDate(d.date)).join(', ')}`}
                </div>
              </div>
              <div className="week-end">
                <div className="week-end-amount">
                  <StatusDot status={week.status} />
                  <Money cents={week.endBalance} whole className="big" tone={week.status === 'negative' ? 'bad' : week.status === 'low' ? 'warn' : undefined} />
                </div>
                <div className="muted small">
                  {week.status === 'low' ? (
                    <span className="tone-warn week-state">low, </span>
                  ) : week.status === 'negative' ? (
                    <span className="tone-bad week-state">short, </span>
                  ) : null}
                  at week’s end
                </div>
              </div>
            </div>
            <div className="grid-2 small">
              <div>
                In <Money cents={week.projectedIncome} whole tone="good" />
              </div>
              <div>
                Out <Money cents={week.projectedOutflow} whole />
              </div>
            </div>
            {expanded === i && (
              <div className="stack-sm">
                {week.isPast && <p className="muted small">This week is over, so these are actual numbers.</p>}
                {bills.length === 0 ? (
                  <p className="muted small">No bills due this week.</p>
                ) : (
                  bills.map((bill) => (
                    <div key={bill.name} className="spread small">
                      <span>{bill.name}</span>
                      <Money cents={bill.cents} whole tone={bill.income ? 'good' : undefined} />
                    </div>
                  ))
                )}
              </div>
            )}
          </Card>
        );
      })}

      <Sheet open={editingStart} onClose={() => setEditingStart(false)} title="Cash on the 1st">
        <p className="muted">What your checking accounts held on the first day of the month. Connected banks fill this in for the current month.</p>
        <AmountInput cents={startCents} onChange={setStartCents} allowNegative />
        <div className="cluster">
          <Button variant="primary" onClick={() => void saveStart(false)}>
            Save
          </Button>
          {p.startingBalance.source === 'manual' && <Button onClick={() => void saveStart(true)}>Use bank balances</Button>}
        </div>
      </Sheet>
    </>
  );
}

interface RecurringBill {
  id: number;
  name: string;
  cadence: string;
  expectedAmountCents: number;
  lastDate: string | null;
  nextDate: string | null;
  categoryName: string | null;
  status: 'suggested' | 'confirmed' | 'dismissed';
}

function BillsView({ month }: { month: string }) {
  const { toast } = useApp();
  const planner = useLoad(() => api<PlannerResponse>(`/planner?month=${month}`), [month]);
  const recurring = useLoad(() => api<RecurringBill[]>('/recurring'), []);
  const [detecting, setDetecting] = useState(false);

  async function detect() {
    setDetecting(true);
    try {
      const res = await post<{ found: number }>('/recurring/detect');
      toast(res.found ? `Found ${plural(res.found, 'repeating charge')}` : 'No repeating charges found yet');
      await recurring.reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setDetecting(false);
    }
  }

  async function setStatus(bill: RecurringBill, status: RecurringBill['status']) {
    try {
      await patch(`/recurring/${bill.id}`, { status });
      await Promise.all([recurring.reload(), planner.reload()]);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  const suggested = (recurring.data ?? []).filter((r) => r.status === 'suggested');
  const confirmed = (recurring.data ?? []).filter((r) => r.status === 'confirmed');

  return (
    <>
      <div className="section-title">
        <h3>Still due this month</h3>
      </div>
      {!planner.data ? (
        <Loading />
      ) : planner.data.bills.length === 0 ? (
        <Empty title="Nothing left to pay">Bills come from budget lines with a due day and from confirmed repeating charges.</Empty>
      ) : (
        <div className="list">
          {planner.data.bills.map((bill) => (
            <div key={`${bill.name}-${bill.date}`} className="row">
              <div className="row-main">
                <div className="row-title">{bill.name}</div>
                <div className="row-sub">
                  {shortDate(bill.date)} {bill.overdue && <span className="chip chip-bad">not seen yet</span>}
                </div>
              </div>
              <Money cents={bill.amountCents} whole />
            </div>
          ))}
        </div>
      )}

      <div className="section-title">
        <h3>Repeating charges</h3>
        <Button small onClick={() => void detect()} disabled={detecting}>
          {detecting ? 'Looking…' : 'Find them'}
        </Button>
      </div>
      {suggested.length > 0 && (
        <div className="list">
          {suggested.map((bill) => (
            <div key={bill.id} className="row">
              <div className="row-main">
                <div className="row-title">{bill.name}</div>
                <div className="row-sub">
                  {money(Math.abs(bill.expectedAmountCents))} {bill.cadence}
                  {bill.nextDate && ` · next ${shortDate(bill.nextDate)}`}
                </div>
              </div>
              <div className="cluster">
                <Button small onClick={() => void setStatus(bill, 'confirmed')}>
                  Yes
                </Button>
                <Button small variant="ghost" onClick={() => void setStatus(bill, 'dismissed')}>
                  No
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {confirmed.length > 0 ? (
        <div className="list">
          {confirmed.map((bill) => (
            <div key={bill.id} className="row">
              <div className="row-main">
                <div className="row-title">{bill.name}</div>
                <div className="row-sub">
                  {bill.cadence}
                  {bill.nextDate && ` · next ${shortDate(bill.nextDate)}`}
                  {bill.categoryName && ` · ${bill.categoryName}`}
                </div>
              </div>
              <div className="cluster">
                <Money cents={Math.abs(bill.expectedAmountCents)} whole />
                <button type="button" className="icon-btn" aria-label={`Stop tracking ${bill.name}`} onClick={() => void setStatus(bill, 'dismissed')}>
                  <Icon name="close" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        !suggested.length && <p className="muted small">Tap “Find them” after a few months of transactions are in.</p>
      )}
    </>
  );
}
