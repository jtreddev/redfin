import { useId, useMemo, useState } from 'react';
import { addMonths, monthOf } from '../../shared/dates';
import {
  HORIZONS,
  monthsToWatch,
  projectMonths,
  type Horizon,
  type MonthAhead,
  type MonthsAhead as Result,
  type MonthsAheadInput,
  type MonthsWhatIf,
} from '../../shared/monthsAhead';
import { GROUP_ORDER } from '../../shared/trends';
import { api } from '../api';
import { Bars, type BarDetails } from '../charts/Bars';
import { GROUP_COLOR, useTableToggle } from '../charts/cards';
import { StackedBars, type Series } from '../charts/StackedBars';
import { monthLabel, monthShortLabel } from '../format';
import { Icon } from '../icons';
import { useApp, useLoad } from '../state';
import { AmountInput, Button, Card, ErrorNote, Loading, Money, Segmented } from '../ui';

/** GET /api/forecast/months. */
export interface MonthsAheadResponse {
  today: string;
  input: MonthsAheadInput;
  projection: Result;
  hasBalance: boolean;
  hasIncome: boolean;
}

const HORIZON_KEY = 'monthsAhead.horizon';
const HORIZON_LABEL: Record<Horizon, string> = { 3: '3 months', 6: '6 months', 12: '1 year' };

/** The 3/6/12 choice, remembered in this browser (private windows may refuse: then it's 6). */
function savedHorizon(): Horizon {
  try {
    const saved = Number(localStorage.getItem(HORIZON_KEY));
    return (HORIZONS as readonly number[]).includes(saved) ? (saved as Horizon) : 6;
  } catch {
    return 6;
  }
}

function saveHorizon(horizon: Horizon) {
  try {
    localStorage.setItem(HORIZON_KEY, String(horizon));
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

/** "April" for a month this year, "April 2027" otherwise. */
function monthName(month: string, today: string): string {
  return month.slice(0, 4) === today.slice(0, 4) ? monthLabel(month).replace(/ \d{4}$/, '') : monthLabel(month);
}

/**
 * Trends › Ahead: the rest of this month and the next 3, 6 or 12, month by month. The server sends a year of
 * inputs; the 3/6/12 switch and the what-if re-run projectMonths here.
 */
export function MonthsAhead() {
  const { me } = useApp();
  const load = useLoad(() => api<MonthsAheadResponse>('/forecast/months'), []);
  const [horizon, setHorizon] = useState<Horizon>(savedHorizon);
  const data = load.data;
  const result = useMemo(() => (data ? projectMonths(data.input, horizon) : null), [data, horizon]);

  if (load.error && !data) return <ErrorNote message={load.error} onRetry={() => void load.reload()} />;
  if (!data || !result) return <Loading />;
  const { input, today } = data;
  const cushion = input.lowBalanceCents;
  const current = monthOf(today);
  const fullMonths = input.historyStart === null ? 0 : Math.max(0, monthsBetween(input.historyStart, current));

  return (
    <>
      <div className="ahead-horizon" role="group" aria-label="How far ahead">
        <Segmented
          value={String(horizon)}
          onChange={(v) => {
            const next = Number(v) as Horizon;
            setHorizon(next);
            saveHorizon(next);
          }}
          options={HORIZONS.map((h) => ({ value: String(h), label: HORIZON_LABEL[h] }))}
        />
      </div>

      {!data.hasIncome && (
        <div className="banner banner-warn">
          <span>Add your paydays to forecast money in.</span>
          <a className="btn btn-secondary btn-small" href="#/more/income">
            Income
          </a>
        </div>
      )}
      {!data.hasBalance && <p className="muted small">No cash balance yet, so this starts from $0. Connect a bank or add a balance to a checking account.</p>}
      {fullMonths < 2 && <p className="muted small">There’s little history so far, so everyday spending is estimated from what there is.</p>}

      <div className="trends-grid">
        <SummaryCard result={result} today={today} start={input.startBalanceCents} />
        <CashCard result={result} cushion={cushion} />
        <WhereCard result={result} />
        <WatchCard result={result} cushion={cushion} today={today} />
        {result.plannedCosts.length > 0 && <SetAsidesCard result={result} today={today} />}
        {(result.goals.length > 0 || result.habitsTotalCents > 0) && <GoalsCard result={result} today={today} />}
        {me.viewer.powerTools && <WhatIfCard input={input} horizon={horizon} base={result} today={today} />}
      </div>
      <p className="muted small">Based on your bills, budget and the last 3 months of spending. The further out, the rougher.</p>
    </>
  );
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}

function SummaryCard({ result, today, start }: { result: Result; today: string; start: number }) {
  const { totals } = result;
  const last = result.months.at(-1)!;
  const left = totals.leftOverCents;
  return (
    <Card className="trends-wide-card ahead-summary">
      <h2 className="sr-only">Summary</h2>
      <p className="ahead-lead">
        Next {result.horizon === 12 ? '12 months' : `${result.horizon} months`}: about <Money cents={totals.inCents} whole /> in,{' '}
        <Money cents={totals.outCents} whole /> out,{' '}
        <strong>
          <Money cents={Math.abs(left)} whole /> {left < 0 ? 'short' : 'left over'}
        </strong>
        .
      </p>
      <p className="muted">
        Cash goes from <Money cents={start} whole /> today to about <Money cents={result.endCents} whole /> by the end of {monthName(last.month, today)}.
      </p>
    </Card>
  );
}

/** One month's readout: cash at its end, then what came in and went out. Amounts out are negative. */
function monthDetails(m: MonthAhead, cushion: number): BarDetails {
  return {
    rows: [
      { key: 'end', name: 'Cash at month end', colorVar: '--accent', value: m.endCents },
      { key: 'in', name: m.extraPay ? `Money in (${m.payDays} paydays)` : 'Money in', value: m.inCents },
      ...GROUP_ORDER.filter((g) => m.byGroup[g.key] !== 0).map((g) => ({ key: g.key, name: g.name, colorVar: GROUP_COLOR[g.key], value: -m.byGroup[g.key] })),
      ...(m.addedCents ? [{ key: 'added', name: 'Added costs', value: -m.addedCents }] : []),
      { key: 'left', name: 'Left over', value: m.leftOverCents },
      ...m.bigItems.map((b, i) => ({ key: `big-${i}`, name: `Includes ${b.name}${b.note ? `, ${b.note}` : ''}`, value: -b.amountCents })),
    ],
    note: m.endCents < 0 ? 'Below zero' : cushion > 0 && m.endCents < cushion ? 'Under your cushion' : undefined,
  };
}

function CashCard({ result, cushion }: { result: Result; cushion: number }) {
  const title = 'Cash at the end of each month';
  const [table, toggle] = useTableToggle(title);
  const { months } = result;
  return (
    <Card>
      <div className="spread chart-head">
        <h2>{title}</h2>
        {toggle}
      </div>
      {table ? (
        <div className="table-scroll">
          <table className="compare">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">In</th>
                <th scope="col">Out</th>
                <th scope="col">Left over</th>
                <th scope="col">Cash at end</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.label}</th>
                  <td><Money cents={m.inCents} whole /></td>
                  <td><Money cents={m.outCents} whole /></td>
                  <td><Money cents={m.leftOverCents} whole /></td>
                  <td>
                    <Money cents={m.endCents} whole />
                    {m.endCents < 0 ? <span className="muted"> below zero</span> : cushion > 0 && m.endCents < cushion ? <span className="muted"> under cushion</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Bars
          months={months.map((m) => m.month)}
          values={months.map((m) => m.endCents)}
          reference={cushion > 0 ? cushion : undefined}
          referenceKind="cushion"
          colorVar="--accent"
          label={title}
          partialIndex={0}
          partialLabel="rest"
          signed
          titleOf={(i) => months[i]!.label}
          details={(i) => monthDetails(months[i]!, cushion)}
        />
      )}
    </Card>
  );
}

function WhereCard({ result }: { result: Result }) {
  const title = 'Where it goes';
  const [table, toggle] = useTableToggle(title);
  const { months } = result;
  const series: Series[] = GROUP_ORDER.map((g) => ({ key: g.key, name: g.name, colorVar: GROUP_COLOR[g.key], values: months.map((m) => m.byGroup[g.key]) }));
  return (
    <Card>
      <div className="spread chart-head">
        <h2>{title}</h2>
        {toggle}
      </div>
      {table ? (
        <div className="table-scroll">
          <table className="compare">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                {series.map((s) => (
                  <th key={s.key} scope="col">
                    {s.name}
                  </th>
                ))}
                <th scope="col">Money in</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m, i) => (
                <tr key={m.month}>
                  <th scope="row">{m.label}</th>
                  {series.map((s) => (
                    <td key={s.key}>
                      <Money cents={s.values[i]!} whole />
                    </td>
                  ))}
                  <td>
                    <Money cents={m.inCents} whole />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <StackedBars
          months={months.map((m) => m.month)}
          series={series}
          partialIndex={0}
          partialLabel="rest"
          label="Money out by group each month"
          marker={{ name: 'Money in', values: months.map((m) => m.inCents) }}
          titleOf={(i) => months[i]!.label}
        />
      )}
    </Card>
  );
}

function WatchCard({ result, cushion, today }: { result: Result; cushion: number; today: string }) {
  const watch = monthsToWatch(result, cushion);
  const { tightest } = result;
  return (
    <Card>
      <h2>Months to watch</h2>
      <p>
        Tightest: the end of {tightest.partial ? 'this month' : monthName(tightest.month, today)}, at about{' '}
        <Money cents={tightest.endCents} whole tone={tightest.endCents < 0 ? 'bad' : undefined} />.
      </p>
      {watch.length === 0 ? (
        <p className="muted">No tight months ahead.</p>
      ) : (
        <ul className="ahead-list">
          {watch.map((m) => (
            <li key={m.month}>
              <strong>{m.partial ? 'Rest of this month' : monthName(m.month, today)}</strong>:{' '}
              {m.leftOverCents < 0 ? (
                <>
                  <Money cents={-m.leftOverCents} whole /> more out than in
                </>
              ) : (
                <>
                  <Money cents={m.leftOverCents} whole /> left over
                </>
              )}
              , ending at <Money cents={m.endCents} whole />
              {m.endCents < 0 ? ', below zero' : cushion > 0 && m.endCents < cushion ? ', under your cushion' : ''}.
              {m.bigItems.length > 0 && (
                <span className="muted">
                  {' '}
                  {m.bigItems.map((b, i) => (
                    <span key={i}>
                      {i > 0 && ', '}
                      {b.name}
                      {b.note ? ` (${b.note})` : ''} <Money cents={b.amountCents} whole />
                    </span>
                  ))}
                  .
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SetAsidesCard({ result, today }: { result: Result; today: string }) {
  const last = result.months.at(-1)!;
  return (
    <Card>
      <h2>Set-asides</h2>
      <ul className="ahead-list">
        {result.plannedCosts.map((c) => (
          <li key={c.name}>
            <strong>{c.name}</strong>: <Money cents={c.balanceNowCents} whole /> now,{' '}
            {c.lowestCents < 0 ? (
              <>
                about <Money cents={c.lowestCents} whole /> after {monthShortLabel(c.lowestMonth).replace(/ \d{4}$/, '')}
                <span className="ahead-flag tone-warn">
                  <Icon name="alert" /> Runs short
                </span>
                <span className="muted small ahead-fix">
                  Set aside <Money cents={c.fixMonthlyCents} whole /> more a month to cover it.
                </span>
              </>
            ) : (
              <>
                about <Money cents={c.endCents} whole /> by the end of {monthName(last.month, today)}
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function GoalsCard({ result, today }: { result: Result; today: string }) {
  return (
    <Card>
      <h2>Goals and habits</h2>
      {result.goals.length > 0 && (
        <ul className="ahead-list">
          {result.goals.map((g) => (
            <li key={g.name}>
              <strong>{g.name}</strong>:{' '}
              {g.done ? 'reached' : g.projectedMonth ? `about ${monthName(g.projectedMonth, today)} at your recent pace` : 'not on pace: nothing saved toward it lately'}
            </li>
          ))}
        </ul>
      )}
      {result.habitsTotalCents > 0 && (
        <p>
          About <Money cents={result.habitsTotalCents} whole /> on habits over the next year at your usual pace.
        </p>
      )}
    </Card>
  );
}

type HabitsChoice = 'usual' | 'less25' | 'less50' | 'none';
type EverydayChoice = 'usual' | 'less10' | 'less20';
const HABITS: Record<HabitsChoice, number> = { usual: 1, less25: 0.75, less50: 0.5, none: 0 };
const EVERYDAY: Record<EverydayChoice, number> = { usual: 1, less10: 0.9, less20: 0.8 };

/** "What if…": re-runs the months on the client. Nothing is saved. */
function WhatIfCard({ input, horizon, base, today }: { input: MonthsAheadInput; horizon: Horizon; base: Result; today: string }) {
  const [habits, setHabits] = useState<HabitsChoice>('usual');
  const [everyday, setEveryday] = useState<EverydayChoice>('usual');
  const [monthlyCents, setMonthlyCents] = useState<number | null>(null);
  const [oneOffCents, setOneOffCents] = useState<number | null>(null);
  const [oneOffMonth, setOneOffMonth] = useState(addMonths(monthOf(today), 1));
  const [payChangeCents, setPayChangeCents] = useState<number | null>(null);
  const ids = { habits: useId(), everyday: useId(), month: useId() };

  const whatIf: MonthsWhatIf = useMemo(
    () => ({
      habitsFactor: HABITS[habits],
      everydayFactor: EVERYDAY[everyday],
      monthlyCents: monthlyCents ?? 0,
      oneOffCents: oneOffCents ?? 0,
      oneOffMonth,
      payChangeCents: payChangeCents ?? 0,
    }),
    [habits, everyday, monthlyCents, oneOffCents, oneOffMonth, payChangeCents],
  );
  const result = useMemo(() => projectMonths(input, horizon, whatIf), [input, horizon, whatIf]);
  const diff = result.endCents - base.endCents;
  const changed = habits !== 'usual' || everyday !== 'usual' || Boolean(monthlyCents) || Boolean(oneOffCents) || Boolean(payChangeCents);
  const last = base.months.at(-1)!;

  function reset() {
    setHabits('usual');
    setEveryday('usual');
    setMonthlyCents(null);
    setOneOffCents(null);
    setPayChangeCents(null);
  }

  return (
    <Card className="trends-wide-card">
      <details className="what-if what-if-ahead">
        <summary>What if…</summary>
        <div className="stack-sm">
          <div className="what-if-control" role="group" aria-labelledby={ids.habits}>
            <span id={ids.habits} className="field-label">
              Habits
            </span>
            <Segmented
              value={habits}
              onChange={setHabits}
              options={[
                { value: 'usual', label: 'Usual' },
                { value: 'less25', label: '−25%' },
                { value: 'less50', label: '−50%' },
                { value: 'none', label: 'None' },
              ]}
            />
          </div>
          <div className="what-if-control" role="group" aria-labelledby={ids.everyday}>
            <span id={ids.everyday} className="field-label">
              Everyday
            </span>
            <Segmented
              value={everyday}
              onChange={setEveryday}
              options={[
                { value: 'usual', label: 'Usual' },
                { value: 'less10', label: '−10%' },
                { value: 'less20', label: '−20%' },
              ]}
            />
          </div>
          <div className="what-if-fields">
            <label className="what-if-control">
              <span className="field-label">Add a monthly cost</span>
              <AmountInput cents={monthlyCents} onChange={setMonthlyCents} />
            </label>
            <label className="what-if-control">
              <span className="field-label">Pay change per paycheck</span>
              <AmountInput cents={payChangeCents} onChange={setPayChangeCents} allowNegative placeholder="+ or −" />
            </label>
          </div>
          <div className="what-if-add">
            <label className="what-if-control">
              <span className="field-label">One-off cost</span>
              <AmountInput cents={oneOffCents} onChange={setOneOffCents} />
            </label>
            <label className="what-if-control" htmlFor={ids.month}>
              <span className="field-label">In</span>
              <select id={ids.month} value={oneOffMonth} onChange={(e) => setOneOffMonth(e.target.value)}>
                {base.months.map((m) => (
                  <option key={m.month} value={m.month}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="what-if-result" aria-live="polite">
            {changed ? (
              <p>
                About <Money cents={result.endCents} whole tone={result.endCents < 0 ? 'bad' : undefined} /> at the end of {monthName(last.month, today)}{' '}
                <Money cents={diff} whole signed tone={diff > 0 ? 'good' : diff < 0 ? 'bad' : 'muted'} />
              </p>
            ) : (
              <p className="muted small">Change something above to see how the months look.</p>
            )}
          </div>
          <Button small variant="ghost" className="btn-flush" onClick={reset} disabled={!changed}>
            Reset
          </Button>
        </div>
      </details>
    </Card>
  );
}
