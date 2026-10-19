import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { monthEnd, type MonthKey } from '../../shared/dates';
import type { Horizon } from '../../shared/monthsAhead';
import { autoFill, DEBT_STRATEGIES, planAhead, type AheadItem, type AheadRepeat, type DebtStrategy, type PlanAheadResult } from '../../shared/planAhead';
import {
  activeDebts,
  allocationText,
  costReadout,
  debtFreeText,
  debtReadout,
  fillPlan,
  goalReadout,
  headlineText,
  itemRepeatText,
  lineDate,
  monthChoices,
  monthSheet,
  orderedDebts,
  planChanges,
  rebase,
  saveBody,
  sliderMax,
  startWorking,
  STEP_CENTS,
  STRATEGY_LABEL,
  touchesBudget,
  type AheadResponse,
  type DebtRow,
  type Working,
} from '../aheadPlan';
import { useMoneyText, WithAmounts } from '../amounts';
import { api, del, errorMessage, patch, post } from '../api';
import { moveId } from '../categoryTree';
import { BalanceLine } from '../charts/BalanceLine';
import { useTableToggle } from '../charts/cards';
import { monthLabel } from '../format';
import { Icon } from '../icons';
import { useApp, useLoad } from '../state';
import { AmountInput, Button, Card, ErrorNote, Field, Loading, Money, Segmented, Sheet } from '../ui';
import { DebtFlagChips, DebtSheet } from './DebtSheet';
import { GoalSheet } from './Goals';
import { AheadNotes, CashCard, GoalsCard, HorizonSwitch, savedHorizon, SummaryCard, WatchCard, WhatIfCard, WhereCard } from './MonthsAhead';

/** The surprises stepper moves $25 at a time, as the suggestion is rounded. */
const SURPRISE_STEP = 2_500;

/**
 * Plan › Ahead (#/plan?view=ahead): the months ahead (Project 6b's cards), known items, the surprises cushion,
 * and where the extra goes. GET /ahead loads once; every slider move re-runs planAhead here, and nothing is saved
 * until "Save as my plan".
 */
export function PlanAhead() {
  const { me, toast } = useApp();
  const power = me.viewer.powerTools;
  const load = useLoad(() => api<AheadResponse>('/ahead'), []);
  const [horizon, setHorizon] = useState<Horizon>(savedHorizon);
  const [working, setWorking] = useState<Working | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [debtSheet, setDebtSheet] = useState<DebtRow | 'new' | null>(null);
  const [addingGoal, setAddingGoal] = useState(false);
  const [announce, setAnnounce] = useState('');
  // A reload after Save starts from the saved plan; any other reload keeps unsaved moves. Worked out while
  // rendering (not in an effect), so a reload never flashes "Loading…" and the screen keeps its place.
  const [fresh, setFresh] = useState(true);
  const [seen, setSeen] = useState<AheadResponse | null>(null);
  const data = load.data;
  if (data && data !== seen) {
    setSeen(data);
    setWorking(working === null || fresh ? startWorking(data) : rebase(working, data));
    setFresh(false);
  }

  const ready = data && working && seen === data ? { data, working } : null;
  const plan = ready?.working.plan;
  const result = useMemo(() => (ready && plan ? planAhead(ready.data.input, plan, horizon) : null), [ready?.data, plan, horizon]);
  const savedResult = useMemo(() => (data ? planAhead(data.input, fillPlan(data.saved, data.input), horizon) : null), [data, horizon]);

  if (load.error && !data) return <ErrorNote message={load.error} onRetry={() => void load.reload()} />;
  if (!ready || !result || !savedResult) return <Loading />;
  const { input, today } = ready.data;
  const w = ready.working;
  const changes = planChanges(input, ready.data, w);

  const update = (change: Partial<Working['plan']>, ownSurprise = w.ownSurprise) => setWorking({ plan: { ...w.plan, ...change }, ownSurprise });
  const reload = () => load.reload();

  function fill() {
    const filled = autoFill({ ...input, surpriseCents: w.plan.surpriseCents, strategy: w.plan.strategy }, horizon);
    update({ debtExtra: filled.debtExtra, costMonthly: filled.costMonthly, goalMonthly: filled.goalMonthly });
    setAnnounce('Filled automatically. Nothing is saved yet.');
  }

  async function save() {
    setSaving(true);
    try {
      await post('/ahead/plan', saveBody(input, ready!.data, w));
      setFresh(true);
      setConfirming(false);
      await load.reload();
      toast('Plan saved');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack plan-ahead">
      <HorizonSwitch horizon={horizon} onChange={setHorizon} />
      <AheadNotes input={input} today={today} hasIncome={ready.data.hasIncome} hasBalance={ready.data.hasBalance} />

      <div className="trends-grid">
        <SummaryCard result={result.projection} today={today} start={input.startBalanceCents} />
        <MonthsCard data={ready.data} result={result} power={power} />
        <WhereCard result={result.projection} />
        <ItemsCard items={ready.data.items} today={today} onChanged={reload} />
        <WatchCard result={result.projection} cushion={input.lowBalanceCents} today={today} />
        <SurprisesCard data={ready.data} working={w} power={power} onChange={(cents, own) => update({ surpriseCents: cents }, own)} />
      </div>

      <Card className="ahead-plan">
        <h2>Where the extra goes</h2>
        <p className="ahead-lead">
          <WithAmounts text={headlineText(result.leftOverCents)} />
        </p>
        <AllocationBar result={result} />
        <div className="cluster">
          <Button variant="primary" onClick={fill}>
            Fill automatically
          </Button>
          <span className="muted small">Set-asides first, then goals with a date, then the highest interest rate.</span>
        </div>
        <p className="sr-only" aria-live="polite">
          {announce}
        </p>

        <div className="ahead-groups">
          {result.costs.length > 0 && (
            <SliderGroup title="Set-asides">
              {result.costs.map((c) => {
                const readout = costReadout(c, result.projection.months.at(-1)!.month);
                return (
                  <SliderRow
                    key={c.id}
                    name={c.name}
                    value={w.plan.costMonthly[c.id] ?? c.currentMonthlyCents}
                    max={sliderMax(result.leftOverCents, c.currentMonthlyCents)}
                    onChange={(cents) => update({ costMonthly: { ...w.plan.costMonthly, [c.id]: cents } })}
                    sub={c.monthlyCents !== c.currentMonthlyCents ? <>Now <Money cents={c.currentMonthlyCents} whole /> a month, changing from next month</> : 'A month, from next month'}
                    readout={<WithAmounts text={readout.text} />}
                    warn={readout.short}
                  />
                );
              })}
            </SliderGroup>
          )}

          <DebtsGroup
            data={ready.data}
            result={result}
            working={w}
            power={power}
            onExtra={(id, cents) => update({ debtExtra: { ...w.plan.debtExtra, [id]: cents } })}
            onStrategy={(strategy, order) => update({ strategy, order })}
            onEdit={setDebtSheet}
          />

          <SliderGroup title="Goals">
            {input.aheadGoals.length === 0 ? (
              <div className="ahead-empty">
                <p className="muted small">No savings goals yet.</p>
                <Button onClick={() => setAddingGoal(true)}>Add a goal</Button>
              </div>
            ) : (
              result.goals.map((g) => (
                <SliderRow
                  key={g.id}
                  name={g.name}
                  value={w.plan.goalMonthly[g.id] ?? 0}
                  max={sliderMax(result.leftOverCents, savedResult.goals.find((s) => s.id === g.id)?.monthlyCents ?? 0)}
                  onChange={(cents) => update({ goalMonthly: { ...w.plan.goalMonthly, [g.id]: cents } })}
                  sub={<>A month, from next month · <Money cents={input.aheadGoals.find((a) => a.id === g.id)?.remainingCents ?? 0} whole /> to go</>}
                  readout={goalReadout(g, today)}
                />
              ))
            )}
          </SliderGroup>
        </div>
      </Card>

      <div className="trends-grid">
        <DebtFreeCard result={result} savedResult={savedResult} today={today} power={power} onAdd={() => setDebtSheet('new')} />
        <CashCard result={result.projection} cushion={input.lowBalanceCents} />
        {result.projection.habitsTotalCents > 0 && <GoalsCard result={result.projection} today={today} goals={false} />}
        {power && (
          <WhatIfCard
            input={{ ...input, ahead: Object.fromEntries(result.projection.months.map((m) => [m.month, m.ahead])) }}
            horizon={horizon}
            base={result.projection}
            today={today}
          />
        )}
      </div>
      <p className="muted small">Based on your bills, budget and the last 3 months of spending. The further out, the rougher.</p>

      <div className={`ahead-save ${changes.length ? 'is-changed' : ''}`}>
        <span className="small">
          {changes.length ? `${changes.length} ${changes.length === 1 ? 'change' : 'changes'} not saved yet` : 'This is your saved plan.'}
          {changes.length > 0 && result.hasDebts && <span className="muted"> · {debtFreeText(result, savedResult, today).title}</span>}
        </span>
        <div className="cluster">
          <Button onClick={() => setWorking(startWorking(ready.data))} disabled={!changes.length}>
            Reset
          </Button>
          <Button variant="primary" onClick={() => setConfirming(true)} disabled={!changes.length}>
            Save as my plan
          </Button>
        </div>
      </div>

      {confirming && (
        <Sheet open onClose={() => setConfirming(false)} title="Save as my plan?">
          <p>This changes:</p>
          <ul className="ahead-changes">
            {changes.map((c) => (
              <li key={c.key}>
                <WithAmounts text={c.text} />
              </li>
            ))}
          </ul>
          {touchesBudget(input, ready.data, w) && <p className="muted small">The budget’s goal and debt lines from next month on change to match.</p>}
          <p className="muted small">This month stays as it is. There’s no undo, but you can change the plan again any time.</p>
          <div className="cluster">
            <Button variant="primary" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button onClick={() => setConfirming(false)}>Keep changing</Button>
          </div>
        </Sheet>
      )}
      {debtSheet && (
        <DebtSheet
          debt={debtSheet === 'new' ? null : debtSheet}
          onClose={() => setDebtSheet(null)}
          onSaved={async () => {
            setDebtSheet(null);
            await reload();
          }}
        />
      )}
      {addingGoal && (
        <GoalSheet
          goal={null}
          onClose={() => setAddingGoal(false)}
          onSaved={async () => {
            setAddingGoal(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────── The months ─────────────────────────

/** The month table: one row per month; a tap opens what's in it. */
function MonthsCard({ data, result, power }: { data: AheadResponse; result: PlanAheadResult; power: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const months = result.projection.months;
  const m = open === null ? null : months[open]!;
  return (
    <Card>
      <h2>Month by month</h2>
      <div className="list">
        {months.map((month, i) => (
          <button key={month.month} type="button" className="row row-button" onClick={() => setOpen(i)}>
            <div className="row-main">
              <div className="row-title">{month.label}</div>
              <div className="row-sub">
                In <Money cents={month.inCents} whole /> · out <Money cents={month.outCents} whole />
              </div>
            </div>
            <span className="ahead-month-end">
              <Money cents={month.endCents} whole tone={month.endCents < 0 ? 'bad' : undefined} />
              <span className="muted small">at the end</span>
            </span>
          </button>
        ))}
      </div>
      {m && open !== null && (
        <Sheet open onClose={() => setOpen(null)} title={m.partial ? 'The rest of this month' : monthLabel(m.month)}>
          <p>
            In <Money cents={m.inCents} whole />, out <Money cents={m.outCents} whole />, about <Money cents={m.endCents} whole tone={m.endCents < 0 ? 'bad' : undefined} /> at the
            end.
          </p>
          {monthSheet(data.input, result.projection, open).map((s) => (
            <section key={s.key} className="ahead-sheet-section">
              <div className="spread">
                <h3>{s.title}</h3>
                <Money cents={s.totalCents} whole className={s.isIn ? 'tone-good' : ''} />
              </div>
              {power && (
                <ul className="ahead-sheet-lines">
                  {s.lines.map((l) => (
                    <li key={l.key}>
                      <span>
                        {l.name}
                        <span className="muted small">
                          {' '}
                          {lineDate(l) ? `${lineDate(l)} · ` : ''}
                          {l.source}
                        </span>
                      </span>
                      <Money cents={l.amountCents} whole />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
          {!power && <p className="muted small">Each line, and where it comes from, shows with Settings › Show more tools.</p>}
        </Sheet>
      )}
    </Card>
  );
}

/** ＋ Add known items: money in or out you know is coming (a tax refund, car registration, a birthday party). */
function ItemsCard({ items, today, onChanged }: { items: AheadItem[]; today: string; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<AheadItem | 'new' | null>(null);
  return (
    <Card>
      <div className="spread chart-head">
        <h2>Known items</h2>
        <Button small onClick={() => setEditing('new')}>
          ＋ Add
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="muted small">Add money in or out you know is coming: a tax refund, car registration, a birthday party.</p>
      ) : (
        <div className="list">
          {items.map((item) => (
            <button key={item.id} type="button" className="row row-button" onClick={() => setEditing(item)}>
              <div className="row-main">
                <div className="row-title">{item.name}</div>
                <div className="row-sub">{itemRepeatText(item)}</div>
              </div>
              <Money cents={item.amountCents} whole signed tone={item.amountCents > 0 ? 'good' : undefined} />
            </button>
          ))}
        </div>
      )}
      {editing && (
        <ItemSheet
          item={editing === 'new' ? null : editing}
          today={today}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
          }}
        />
      )}
    </Card>
  );
}

function ItemSheet({ item, today, onClose, onSaved }: { item: AheadItem | null; today: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const { toast } = useApp();
  const months = monthChoices(today, 24);
  const [name, setName] = useState(item?.name ?? '');
  const [cents, setCents] = useState<number | null>(item ? Math.abs(item.amountCents) : null);
  const [direction, setDirection] = useState<'in' | 'out'>(item && item.amountCents > 0 ? 'in' : 'out');
  const [month, setMonth] = useState<MonthKey>(item?.month ?? months[1]!.value);
  const [repeat, setRepeat] = useState<AheadRepeat>(item?.repeat ?? 'once');
  const [endMonth, setEndMonth] = useState(item?.endMonth ?? '');
  const [busy, setBusy] = useState(false);
  const ids = { direction: useId(), repeat: useId() };
  if (!months.some((m) => m.value === month)) months.unshift({ value: month, label: month });
  const ends = months.filter((m) => m.value > month);

  async function save() {
    if (!cents) return;
    setBusy(true);
    try {
      const body = { name: name.trim(), amountCents: direction === 'in' ? cents : -cents, month, repeat, endMonth: repeat === 'once' || !endMonth || endMonth <= month ? null : endMonth };
      if (item) await patch(`/ahead/items/${item.id}`, body);
      else await post('/ahead/items', body);
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!item) return;
    setBusy(true);
    try {
      await del(`/ahead/items/${item.id}`);
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={item ? item.name : 'Add a known item'}>
      <form
        className="stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Car registration" maxLength={60} autoFocus={!item} />
        </Field>
        <div role="group" aria-labelledby={ids.direction} className="stack-sm">
          <span id={ids.direction} className="field-label">
            Money in or out
          </span>
          <Segmented
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'out', label: 'Money out' },
              { value: 'in', label: 'Money in' },
            ]}
          />
        </div>
        <div className="grid-2">
          <Field label="Amount">
            <AmountInput cents={cents} onChange={setCents} />
          </Field>
          <Field label="Month">
            <select value={month} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div role="group" aria-labelledby={ids.repeat} className="stack-sm">
          <span id={ids.repeat} className="field-label">
            How often
          </span>
          <Segmented
            value={repeat}
            onChange={setRepeat}
            options={[
              { value: 'once', label: 'Once' },
              { value: 'monthly', label: 'Every month' },
              { value: 'yearly', label: 'Every year' },
            ]}
          />
        </div>
        {repeat !== 'once' && (
          <Field label="Until (optional)">
            <select value={endMonth} onChange={(e) => setEndMonth(e.target.value)}>
              <option value="">No end</option>
              {ends.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="cluster">
          <Button type="submit" variant="primary" disabled={!name.trim() || !cents || busy}>
            {item ? 'Save' : 'Add'}
          </Button>
          {item && (
            <Button variant="danger" onClick={() => void remove()} disabled={busy}>
              Delete
            </Button>
          )}
        </div>
      </form>
    </Sheet>
  );
}

/** The cushion for the unexpected: the suggestion read-only, or (power tools, or after "Change") a $25 stepper. */
function SurprisesCard({
  data,
  working,
  power,
  onChange,
}: {
  data: AheadResponse;
  working: Working;
  power: boolean;
  onChange: (cents: number, own: boolean) => void;
}) {
  const [changing, setChanging] = useState(false);
  const moneyText = useMoneyText();
  const cents = working.plan.surpriseCents;
  const id = useId();
  const stepper = power || changing || working.ownSurprise;
  return (
    <Card>
      <h2>Surprises</h2>
      <p>
        Surprises: <Money cents={cents} whole /> a month <span className="muted">({working.ownSurprise ? 'your amount' : 'suggested'})</span>
      </p>
      <p className="muted small">
        Counted as money out every month, for what nobody planned. The suggestion is the usual month of one-off spending of <Money cents={10_000} whole /> and up over the last
        half year.
      </p>
      {stepper ? (
        <div className="cluster">
          <div className="stepper">
            <button
              type="button"
              className="icon-btn"
              aria-label={`${moneyText(SURPRISE_STEP, { whole: true })} less`}
              onClick={() => onChange(Math.max(0, cents - SURPRISE_STEP), true)}
              disabled={cents <= 0}
            >
              −
            </button>
            <AmountInput id={id} cents={cents} onChange={(c) => onChange(Math.max(0, c ?? 0), true)} ariaLabel="Surprises, a month" />
            <button type="button" className="icon-btn" aria-label={`${moneyText(SURPRISE_STEP, { whole: true })} more`} onClick={() => onChange(cents + SURPRISE_STEP, true)}>
              ＋
            </button>
          </div>
          {working.ownSurprise && (
            <Button small variant="ghost" onClick={() => onChange(data.surprise.suggestedCents, false)}>
              Use suggestion (<Money cents={data.surprise.suggestedCents} whole />)
            </Button>
          )}
        </div>
      ) : (
        <Button small variant="ghost" className="btn-flush" onClick={() => setChanging(true)}>
          Change
        </Button>
      )}
    </Card>
  );
}

// ───────────────────────── The sliders ─────────────────────────

function AllocationBar({ result }: { result: PlanAheadResult }) {
  const { text, over } = allocationText(result);
  const room = Math.max(result.leftOverCents, 0);
  const pct = room > 0 ? Math.min(100, (result.allocatedCents / room) * 100) : result.allocatedCents > 0 ? 100 : 0;
  return (
    <div className="alloc">
      <div className="alloc-bar" aria-hidden="true">
        <div className={`alloc-fill ${over ? 'is-over' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <p className={`small ${over ? 'tone-warn' : 'muted'}`} aria-live="polite">
        {over && <Icon name="alert" />} <WithAmounts text={text} />
      </p>
    </div>
  );
}

function SliderGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="ahead-group" aria-labelledby={id}>
      <div className="section-title">
        <h3 id={id}>{title}</h3>
        {action}
      </div>
      <div className="ahead-rows">{children}</div>
    </section>
  );
}

/**
 * One item's monthly amount: a slider in $5 steps and a number field for an exact amount, the value read out in
 * dollars (or "hidden amount"), and what the amount does.
 */
function SliderRow({
  name,
  value,
  max,
  onChange,
  sub,
  readout,
  change,
  warn,
  head,
}: {
  name: string;
  value: number;
  max: number;
  onChange: (cents: number) => void;
  sub?: ReactNode;
  readout: ReactNode;
  change?: ReactNode;
  warn?: boolean;
  head?: ReactNode;
}) {
  const moneyText = useMoneyText();
  const id = useId();
  return (
    <div className="slider-row">
      <div className="slider-head">
        <label htmlFor={id} className="slider-name">
          {name}
        </label>
        {head}
        <span className="slider-value">
          <Money cents={value} whole={value % 100 === 0} />
          <span className="muted small"> a month</span>
        </span>
      </div>
      {sub && <div className="muted small">{sub}</div>}
      <div className="slider-controls">
        <input
          id={id}
          type="range"
          min={0}
          max={Math.max(max, value)}
          step={STEP_CENTS}
          value={value}
          aria-valuetext={`${moneyText(value, { whole: value % 100 === 0 })} a month`}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <div className="slider-number">
          <AmountInput cents={value} onChange={(c) => onChange(Math.max(0, c ?? 0))} ariaLabel={`${name}, exact amount a month`} />
        </div>
      </div>
      <p className={`slider-readout small ${warn ? 'tone-warn' : ''}`}>
        {warn && <Icon name="alert" />} {readout}
        {change && <span className="slider-change"> {change}</span>}
      </p>
    </div>
  );
}

function DebtsGroup({
  data,
  result,
  working,
  power,
  onExtra,
  onStrategy,
  onEdit,
}: {
  data: AheadResponse;
  result: PlanAheadResult;
  working: Working;
  power: boolean;
  onExtra: (id: number, cents: number) => void;
  onStrategy: (strategy: DebtStrategy, order: number[]) => void;
  onEdit: (debt: DebtRow | 'new') => void;
}) {
  const [ordering, setOrdering] = useState(false);
  const [announce, setAnnounce] = useState('');
  const focusAfter = useRef<string | null>(null);
  const { input } = data;
  const { plan } = working;
  const rows = new Map(data.debts.map((d) => [d.id, d]));
  const active = activeDebts(input);
  const paidInFull = data.debts.filter((d) => d.paidInFull);
  const ordered = orderedDebts(input, plan);

  useEffect(() => {
    if (!focusAfter.current) return;
    document.getElementById(focusAfter.current)?.focus();
    focusAfter.current = null;
  });

  function move(id: number, delta: number, focusId: string) {
    const ids = ordered.map((d) => d.id);
    const next = moveId(ids, id, delta);
    if (!next) return;
    // Paid-in-full and paid-off debts keep their places after the active ones.
    onStrategy('custom', [...next, ...plan.order.filter((x) => !next.includes(x))]);
    focusAfter.current = focusId;
    setAnnounce(`${rows.get(id)?.name ?? 'Debt'} moved to ${next.indexOf(id) + 1} of ${next.length}`);
  }

  return (
    <SliderGroup
      title="Debts"
      action={
        <Button small onClick={() => onEdit('new')}>
          ＋ Add a debt
        </Button>
      }
    >
      {active.length === 0 && <p className="muted small">No debts to pay down. Linked credit cards and loans show up here on their own.</p>}
      {active.length > 0 && (
        <div className="debt-order small">
          <span>
            Extra goes to {plan.strategy === 'avalanche' ? 'the highest interest rate' : plan.strategy === 'snowball' ? 'the smallest balance' : 'your order'} first; a paid-off debt’s
            money rolls on to the next.
          </span>
          {power && (
            <Button small variant="ghost" pressed={ordering} onClick={() => setOrdering((v) => !v)}>
              Change order
            </Button>
          )}
        </div>
      )}
      {power && ordering && active.length > 0 && (
        <div className="debt-order-panel stack-sm">
          <Segmented<DebtStrategy>
            value={plan.strategy}
            onChange={(s) => onStrategy(s, plan.order)}
            options={DEBT_STRATEGIES.map((s) => ({ value: s, label: STRATEGY_LABEL[s] }))}
          />
          {plan.strategy === 'custom' && (
            <ol className="list debt-order-list">
              {ordered.map((d, i) => (
                <li key={d.id} className="row">
                  <span className="row-main">
                    <span className="row-title">
                      {i + 1}. {d.name}
                    </span>
                  </span>
                  <span className="reorder-btns">
                    <button
                      type="button"
                      id={`debt-up-${d.id}`}
                      className="icon-btn"
                      aria-label={`Move ${d.name} up`}
                      disabled={i === 0}
                      onClick={() => move(d.id, -1, i - 1 === 0 ? `debt-down-${d.id}` : `debt-up-${d.id}`)}
                    >
                      <Icon name="up" />
                    </button>
                    <button
                      type="button"
                      id={`debt-down-${d.id}`}
                      className="icon-btn"
                      aria-label={`Move ${d.name} down`}
                      disabled={i === ordered.length - 1}
                      onClick={() => move(d.id, 1, i + 1 === ordered.length - 1 ? `debt-up-${d.id}` : `debt-down-${d.id}`)}
                    >
                      <Icon name="down" />
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="sr-only" aria-live="polite">
            {announce}
          </p>
        </div>
      )}
      {active.map((d) => {
        const row = rows.get(d.id);
        const r = result.debts.find((x) => x.id === d.id);
        const readout = r ? debtReadout(r) : null;
        return (
          <SliderRow
            key={d.id}
            name={d.name}
            value={plan.debtExtra[d.id] ?? 0}
            max={sliderMax(result.leftOverCents, data.saved.debtExtra[d.id] ?? 0)}
            onChange={(cents) => onExtra(d.id, cents)}
            head={
              row && (
                <Button small variant="ghost" className="slider-edit" onClick={() => onEdit(row)}>
                  Edit<span className="sr-only"> {d.name}</span>
                </Button>
              )
            }
            sub={
              <>
                Extra on top of the <Money cents={d.minPaymentCents} whole={d.minPaymentCents % 100 === 0} /> minimum · <Money cents={d.balanceCents} whole /> owed
                {d.aprPercent > 0 ? ` · ${d.aprPercent}% APR` : ''}
                {row && <DebtFlagChips debt={row} />}
              </>
            }
            readout={readout ? <WithAmounts text={readout.text} /> : null}
            change={readout?.change ? <WithAmounts text={readout.change} /> : null}
          />
        );
      })}
      {paidInFull.length > 0 && (
        <div className="ahead-paid">
          <h4>Paid in full each month</h4>
          <p className="muted small">Cleared every month, so they’re left out of payoff and the debt total. Tap one to change that.</p>
          <div className="list">
            {paidInFull.map((d) => (
              <button key={d.id} type="button" className="row row-button" onClick={() => onEdit(d)}>
                <span className="row-main">
                  <span className="row-title">{d.name}</span>
                </span>
                <Money cents={d.balanceCents} whole />
              </button>
            ))}
          </div>
        </div>
      )}
    </SliderGroup>
  );
}

// ───────────────────────── Results ─────────────────────────

/** Debt-free date, interest from now, and total debt by month (a line toward zero; the table with power tools). */
function DebtFreeCard({
  result,
  savedResult,
  today,
  power,
  onAdd,
}: {
  result: PlanAheadResult;
  savedResult: PlanAheadResult;
  today: string;
  power: boolean;
  onAdd: () => void;
}) {
  const title = 'Total debt at the end of each month';
  const [table, toggle] = useTableToggle(title);
  const moneyText = useMoneyText();
  const text = debtFreeText(result, savedResult, today);
  const months = result.projection.months;
  const lastMonth = months.at(-1)!.month;
  const beyond = result.debtFreeMonth !== null && result.debtFreeMonth > lastMonth;
  const summary =
    `${title}: ${moneyText(result.debtTotals[0] ?? 0, { whole: true })} now, ${moneyText(result.debtTotals.at(-1) ?? 0, { whole: true })} at the end of ${months.at(-1)!.label}.` +
    (beyond ? ` It reaches zero in ${text.title.replace('Debt-free by ', '')}, after the months shown.` : '');
  return (
    <Card>
      <h2>Paying off debt</h2>
      <p className="ahead-lead">
        <strong>{text.title}</strong>
      </p>
      {text.interest && (
        <p className="muted">
          <WithAmounts text={text.interest} />
        </p>
      )}
      {text.change && (
        <p className="small">
          <WithAmounts text={text.change} />
        </p>
      )}
      {result.hasDebts ? (
        <>
          <div className="spread chart-head">
            <h3>{title}</h3>
            {power && toggle}
          </div>
          {table && power ? (
            <div className="table-scroll">
              <table className="compare">
                <caption className="sr-only">{title}</caption>
                <thead>
                  <tr>
                    <th scope="col">Month</th>
                    <th scope="col">Total</th>
                    {result.debts.map((d) => (
                      <th key={d.id} scope="col">
                        {d.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {months.map((m, i) => (
                    <tr key={m.month}>
                      <th scope="row">{m.label}</th>
                      <td>
                        <Money cents={result.debtTotals[i]!} whole />
                      </td>
                      {result.debts.map((d) => (
                        <td key={d.id}>
                          <Money cents={d.balances[i] ?? 0} whole />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <BalanceLine
              points={result.debtTotals.map((cents, i) => ({ date: monthEnd(months[i]!.month), balanceCents: cents }))}
              events={[]}
              cushionCents={0}
              today={today}
              label={title}
              steps={{
                title: (i) => `End of ${months[i]!.partial ? 'this month' : months[i]!.label}`,
                tick: (i) => (i === 0 ? 'Now' : months[i]!.label),
                valueName: 'Total debt',
                unit: 'months',
                summary,
              }}
            />
          )}
          <p className="muted small chart-foot">
            {beyond ? `It reaches zero after the months shown. ` : ''}Assumes new card spending is paid off each month.
          </p>
        </>
      ) : (
        <Button className="btn-flush" variant="ghost" onClick={onAdd}>
          ＋ Add a debt
        </Button>
      )}
    </Card>
  );
}
