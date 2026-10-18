import { useId, useMemo, useState } from 'react';
import { dailyTotal, projectToPayday, yearlyChangeCents, type Projection, type ProjectionInput, type WhatIf } from '../../shared/projection';
import { api } from '../api';
import { BalanceLine, dayTitle } from '../charts/BalanceLine';
import { shortDate, weekdayDate } from '../format';
import { Icon } from '../icons';
import { useApp, useLoad } from '../state';
import { AmountInput, Button, Card, Money, Segmented } from '../ui';

/** GET /api/forecast. */
export interface ForecastResponse {
  today: string;
  input: ProjectionInput;
  projection: Projection;
  hasSetAsides: boolean;
  hasBalance: boolean;
}

/** How many bills show before "and N more". */
const LISTED = 6;

/**
 * Home's "Until payday": cash day by day to the day before the next payday, what comes out before then and,
 * with more tools on, a what-if. Loads on its own; `refresh` (Home's data) reloads it after a sync or an edit.
 * Nothing shows if it can't load: the rest of Home doesn't depend on it.
 */
export function UntilPayday({ refresh }: { refresh: unknown }) {
  const { me } = useApp();
  const forecast = useLoad(() => api<ForecastResponse>('/forecast'), [refresh]);
  const [table, setTable] = useState(false);
  const f = forecast.data;
  if (!f) return null;
  if (!f.hasBalance) {
    return (
      <Card className="until-payday">
        <h2>Until payday</h2>
        <p className="muted small">Connect a bank, or add a balance to a checking account, to see your cash day by day until payday.</p>
      </Card>
    );
  }
  const { projection: p, input } = f;
  const cushion = input.lowBalanceCents;
  const title = p.payday ? `Payday ${weekdayDate(p.payday.date)}` : `Until ${weekdayDate(p.lastDate)}`;
  const before = p.payday ? 'the day before' : `on ${shortDate(p.lastDate)}`;
  const more = p.events.length - LISTED;

  return (
    <Card className="until-payday">
      <div className="spread chart-head">
        <h2>{title}</h2>
        <Button small variant="ghost" pressed={table} className="table-toggle" onClick={() => setTable((v) => !v)}>
          <Icon name="table" />
          Table
          <span className="sr-only"> view of cash until payday</span>
        </Button>
      </div>
      {p.note && <p className="muted small">{p.note}.</p>}
      <p className="until-summary">
        About <Money cents={p.dayBeforeCents} whole tone={p.dayBeforeCents < 0 ? 'bad' : undefined} /> {before}
        {p.lowest.date !== p.lastDate && (
          <>
            {' '}
            · lowest <Money cents={p.lowest.balanceCents} whole tone={p.lowest.balanceCents < 0 ? 'bad' : undefined} /> on {shortDate(p.lowest.date)}
          </>
        )}
        {f.hasSetAsides && <span className="muted">, before set-asides</span>}
      </p>
      {cushion > 0 && (
        <p className="until-free">
          {p.freeCents > 0 ? (
            <>
              <Money cents={p.freeCents} whole /> free to spend until then
            </>
          ) : (
            <span className="tone-warn">
              Nothing free to spend until then: it dips under your <Money cents={cushion} whole /> cushion.
            </span>
          )}
        </p>
      )}

      {table ? (
        <div className="table-scroll">
          <table className="compare">
            <caption className="sr-only">Cash day by day until payday</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Cash</th>
                <th scope="col">Coming out</th>
              </tr>
            </thead>
            <tbody>
              {p.points.map((point) => {
                const out = p.events.filter((e) => e.date === point.date);
                return (
                  <tr key={point.date}>
                    <th scope="row">{dayTitle(point.date, f.today)}</th>
                    <td>
                      <Money cents={point.balanceCents} whole />
                    </td>
                    <td>
                      {out.map((e, i) => (
                        <span key={e.id}>
                          {i > 0 && ', '}
                          {e.name} <Money cents={e.amountCents} whole />
                        </span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <BalanceLine points={p.points} events={p.events} cushionCents={cushion} today={f.today} label="Cash until payday" />
      )}
      <p className="muted small chart-foot">
        Today’s cash in your everyday accounts, less bills and your usual spending (
        <Money cents={dailyTotal(input.dailySpend)} whole /> a day).
      </p>

      {p.events.length > 0 && (
        <>
          <h3 className="until-subhead">Coming out before {p.payday ? 'payday' : shortDate(p.lastDate)}</h3>
          <ul className="until-events">
            {p.events.slice(0, LISTED).map((e) => (
              <li key={e.id} className="spread">
                <span>
                  {e.name}
                  <span className="muted small"> · {shortDate(e.date)}</span>
                </span>
                <Money cents={e.amountCents} whole />
              </li>
            ))}
          </ul>
          {more > 0 && <p className="muted small">and {more} more</p>}
        </>
      )}

      {me.viewer.powerTools && <WhatIfPanel input={input} base={p} />}
    </Card>
  );
}

type HabitsChoice = 'usual' | 'less25' | 'less50' | 'none';
type EverydayChoice = 'usual' | 'less10' | 'less20';
const HABITS: Record<HabitsChoice, number> = { usual: 1, less25: 0.75, less50: 0.5, none: 0 };
const EVERYDAY: Record<EverydayChoice, number> = { usual: 1, less10: 0.9, less20: 0.8 };

/** "What if…": re-runs the projection on the client. Nothing is saved. */
function WhatIfPanel({ input, base }: { input: ProjectionInput; base: Projection }) {
  const [habits, setHabits] = useState<HabitsChoice>('usual');
  const [everyday, setEveryday] = useState<EverydayChoice>('usual');
  const [addCents, setAddCents] = useState<number | null>(null);
  const [repeat, setRepeat] = useState<'once' | 'monthly'>('once');
  const [skip, setSkip] = useState<string[]>([]);
  const ids = { habits: useId(), everyday: useId() };

  const whatIf: WhatIf = useMemo(
    () => ({ habitsFactor: HABITS[habits], everydayFactor: EVERYDAY[everyday], addCents: addCents ?? 0, addRepeat: repeat, skip }),
    [habits, everyday, addCents, repeat, skip],
  );
  const result = useMemo(() => projectToPayday({ ...input, whatIf }), [input, whatIf]);
  const diff = result.dayBeforeCents - base.dayBeforeCents;
  const yearly = yearlyChangeCents(input.dailySpend, whatIf);
  const changed = habits !== 'usual' || everyday !== 'usual' || Boolean(addCents) || skip.length > 0;
  const bills = base.events;

  function reset() {
    setHabits('usual');
    setEveryday('usual');
    setAddCents(null);
    setRepeat('once');
    setSkip([]);
  }

  return (
    <details className="what-if">
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
        <div className="what-if-add">
          <label className="what-if-control">
            <span className="field-label">Add a cost</span>
            <AmountInput cents={addCents} onChange={setAddCents} />
          </label>
          <div role="group" aria-label="How often">
            <Segmented
              value={repeat}
              onChange={setRepeat}
              options={[
                { value: 'once', label: 'Tomorrow' },
                { value: 'monthly', label: 'Every month' },
              ]}
            />
          </div>
        </div>
        {bills.length > 0 && (
          <fieldset className="plain-fieldset check-group">
            <legend className="field-label">Skip a bill</legend>
            {bills.map((b) => (
              <label key={b.id} className="check-row">
                <input
                  type="checkbox"
                  checked={skip.includes(b.id)}
                  onChange={(e) => setSkip((s) => (e.target.checked ? [...s, b.id] : s.filter((id) => id !== b.id)))}
                />
                <span className="spread what-if-bill">
                  <span>
                    {b.name}
                    <span className="muted small"> · {shortDate(b.date)}</span>
                  </span>
                  <Money cents={b.amountCents} whole />
                </span>
              </label>
            ))}
          </fieldset>
        )}

        <div className="what-if-result" aria-live="polite">
          {changed ? (
            <>
              <p>
                About <Money cents={result.dayBeforeCents} whole tone={result.dayBeforeCents < 0 ? 'bad' : undefined} /> {base.payday ? 'the day before payday' : `on ${shortDate(base.lastDate)}`}{' '}
                <Money cents={diff} whole signed tone={diff > 0 ? 'good' : diff < 0 ? 'bad' : 'muted'} />
              </p>
              {yearly !== 0 && (
                <p className="muted small">
                  Kept up, that’s about <Money cents={Math.abs(yearly)} whole /> a year {yearly > 0 ? 'more' : 'less'}.
                </p>
              )}
            </>
          ) : (
            <p className="muted small">Change something above to see how payday looks.</p>
          )}
        </div>
        <Button small variant="ghost" className="btn-flush" onClick={reset} disabled={!changed}>
          Reset
        </Button>
      </div>
    </details>
  );
}
