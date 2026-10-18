import { useState } from 'react';
import type { MonthKey } from '../../shared/dates';
import { GROUP_ORDER, usualOf, type Change, type GroupKey } from '../../shared/trends';
import { api } from '../api';
import { Bars } from '../charts/Bars';
import { StackedBars, type Series } from '../charts/StackedBars';
import { monthLabel, monthShortLabel } from '../format';
import { Icon } from '../icons';
import { go } from '../router';
import { useApp, useLoad } from '../state';
import type { TrendsResponse } from '../types';
import { Button, Card, Empty, ErrorNote, Loading, Money, PageHeader } from '../ui';

/** Each group's chart color: dataviz categorical slots 1–5, in the groups' fixed order. */
const GROUP_COLOR: Record<GroupKey, string> = Object.fromEntries(GROUP_ORDER.map((g, i) => [g.key, `--series-${i + 1}`])) as Record<
  GroupKey,
  string
>;

const TILE_GROUPS: GroupKey[] = ['bills', 'everyday', 'habits'];

/** The months to show: from the household's first month with data (so a new household isn't a row of zeros). */
function visibleRange(t: TrendsResponse): number {
  if (t.historyStart === null) return t.months.length - 1;
  const first = t.months.indexOf(t.historyStart);
  return first < 0 ? 0 : first;
}

export function Trends() {
  const trends = useLoad(() => api<TrendsResponse>('/trends?months=12'), []);

  if (trends.error && !trends.data) return <ErrorNote message={trends.error} onRetry={() => void trends.reload()} />;
  const t = trends.data;
  if (!t) return <Loading />;

  const from = visibleRange(t);
  const months = t.months.slice(from);
  const slice = (values: number[]) => values.slice(from);
  const partialIndex = months.indexOf(t.partialMonth);
  const current = t.months.indexOf(t.partialMonth);
  const fullMonths = months.filter((m) => m < t.partialMonth).length;

  return (
    <div className="stack trends">
      <PageHeader title="Trends" subtitle="What the month costs, over time" />
      <h2 className="sr-only">This month so far</h2>
      {fullMonths < 2 && (
        <Empty title="Trends fill in as history builds up">
          {t.historyStart === null ? 'Nothing to show yet: connect a bank or add transactions.' : 'Here’s what there is so far.'}
        </Empty>
      )}

      <div className="stat-tiles">
        {TILE_GROUPS.map((key) => {
          const group = t.groups.find((g) => g.key === key)!;
          const usual = t.usual[key];
          return (
            <div key={key} className="stat-tile">
              <div className="stat-label">
                <span className="chart-swatch" style={{ background: `var(${GROUP_COLOR[key]})` }} aria-hidden="true" />
                {group.name}
              </div>
              <Money cents={group.byMonth[current] ?? 0} whole className="stat-value" />
              <div className="stat-note muted">so far this month</div>
              <div className="stat-note muted">{usual > 0 ? <>usually <Money cents={usual} whole /> a month</> : 'no usual yet'}</div>
              {key === 'habits' && usual > 0 && <div className="stat-note muted">about <Money cents={usual * 12} whole /> a year</div>}
            </div>
          );
        })}
      </div>

      <div className="trends-grid">
        <GroupsCard t={t} months={months} slice={slice} partialIndex={partialIndex} />
        <CategoryCard t={t} months={months} slice={slice} partialIndex={partialIndex} />
        <ChangesCard t={t} />
      </div>
    </div>
  );
}

interface ChartCardProps {
  t: TrendsResponse;
  months: MonthKey[];
  slice: (values: number[]) => number[];
  partialIndex: number;
}

/** A "Table" toggle for a chart card (the table is the accessible twin); pressed shows the table. */
function useTableToggle(title: string) {
  const [table, setTable] = useState(false);
  const toggle = (
    <Button small variant="ghost" pressed={table} className="table-toggle" onClick={() => setTable((v) => !v)}>
      <Icon name="table" />
      Table
      <span className="sr-only"> view of {title}</span>
    </Button>
  );
  return [table, toggle] as const;
}

function monthCell(month: MonthKey, partial: boolean) {
  return `${monthShortLabel(month)}${partial ? ' (so far)' : ''}`;
}

function GroupsCard({ t, months, slice, partialIndex }: ChartCardProps) {
  const title = 'Monthly spending by group';
  const [table, toggle] = useTableToggle(title);
  const series: Series[] = t.groups.map((g) => ({ key: g.key, name: g.name, colorVar: GROUP_COLOR[g.key], values: slice(g.byMonth) }));
  const uncategorized = slice(t.uncategorizedByMonth).reduce((a, b) => a + b, 0);
  const totals = months.map((_, i) => series.reduce((sum, s) => sum + s.values[i]!, 0));

  return (
    <Card className="trends-wide-card">
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
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m, i) => (
                <tr key={m}>
                  <th scope="row">{monthCell(m, i === partialIndex)}</th>
                  {series.map((s) => (
                    <td key={s.key}>
                      <Money cents={s.values[i]!} whole />
                    </td>
                  ))}
                  <td>
                    <strong><Money cents={totals[i]!} whole /></strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <StackedBars
          months={months}
          series={series}
          partialIndex={partialIndex >= 0 ? partialIndex : undefined}
          label={title}
          onSelect={(i, key) => go('activity', { month: months[i], group: key })}
        />
      )}
      {uncategorized > 0 && (
        <p className="muted small chart-foot spread">
          <span>Not counted above: <Money cents={uncategorized} whole /> with no category yet.</span>
          <Button small variant="ghost" onClick={() => go('activity', { needs: 1, month: 'all' })}>
            Sort them
          </Button>
        </p>
      )}
    </Card>
  );
}

function CategoryCard({ t, months, slice, partialIndex }: ChartCardProps) {
  const { categories } = useApp();
  const defaultId = (t.categories.find((c) => c.group === 'habits' && c.name === 'Habits') ?? t.categories.find((c) => c.group === 'habits') ?? t.categories[0])?.id;
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const row = t.categories.find((c) => c.id === (picked ?? defaultId));
  const title = row ? `${row.name} each month` : 'One category over time';
  const [table, toggle] = useTableToggle(title);

  if (!row) {
    return (
      <Card>
        <h2>One category over time</h2>
        <p className="muted">Once money goes out in a category, you can follow it here.</p>
      </Card>
    );
  }

  const values = slice(row.byMonth);
  const usual = usualOf(t, row.byMonth);
  const isFunMoney = categories.find((c) => c.id === row.id)?.funMemberId != null;
  const groupName = (key: GroupKey) => GROUP_ORDER.find((g) => g.key === key)!.name;

  return (
    <Card>
      <div className="spread chart-head">
        <h2>One category over time</h2>
        {toggle}
      </div>
      <label className="field">
        <span className="sr-only">Category</span>
        <select value={row.id} onChange={(e) => setPicked(Number(e.target.value))}>
          {GROUP_ORDER.map((g) => {
            const options = t.categories.filter((c) => c.group === g.key);
            if (!options.length) return null;
            return (
              <optgroup key={g.key} label={g.name}>
                {options.map((c) => (
                  <option key={c.id} value={c.id}>
                    {/* Sub-categories follow their parent (their money is in its total too). */}
                    {c.parentId ? `${t.categories.find((p) => p.id === c.parentId)?.name ?? ''} › ${c.name}` : c.name}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </label>
      {table ? (
        <div className="table-scroll">
          <table className="compare">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">{row.name}</th>
                <th scope="col">vs usual</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m, i) => (
                <tr key={m}>
                  <th scope="row">{monthCell(m, i === partialIndex)}</th>
                  <td><Money cents={values[i]!} whole /></td>
                  <td className="muted">{i === partialIndex || usual === 0 ? '' : <Money cents={values[i]! - usual} whole signed />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Usually <Money cents={usual} whole /> a month (last 3 full months).</p>
        </div>
      ) : (
        <Bars
          months={months}
          values={values}
          reference={usual > 0 ? usual : undefined}
          colorVar={GROUP_COLOR[row.group]}
          label={title}
          partialIndex={partialIndex >= 0 ? partialIndex : undefined}
        />
      )}
      <div className="spread chart-foot">
        <span className="muted small">In {groupName(row.group)}</span>
        {!isFunMoney && (
          <span className="cluster">
            <a className="edit-link small" href={`#/more/categories?id=${row.id}`}>
              Edit category
            </a>
            <Button small variant="ghost" onClick={() => go('activity', { categoryId: row.id, month: 'all' })}>
              See transactions
            </Button>
          </span>
        )}
      </div>
    </Card>
  );
}

function ChangesCard({ t }: { t: TrendsResponse }) {
  const { categories } = useApp();
  const { basis, up, down } = t.changed;
  const compared = basis === 'this-month' ? t.partialMonth : t.months[t.months.indexOf(t.partialMonth) - 1];
  const hasUsual = t.historyStart !== null && t.historyStart < (compared ?? t.partialMonth);

  const isFunMoney = (id: number) => categories.find((c) => c.id === id)?.funMemberId != null;
  const rowFor = (c: Change, direction: 'up' | 'down') => {
    const content = (
      <>
        <div className="row-main">
          <div className="row-title">{c.name}</div>
          <div className="row-sub">
            <Money cents={c.soFar} whole /> {basis === 'this-month' ? 'so far' : 'spent'} · usually{' '}
            <Money cents={c.usual} whole />
            {basis === 'this-month' && <> · on pace for <Money cents={c.projected} whole /></>}
          </div>
        </div>
        <span className={`change ${direction === 'up' ? 'tone-bad' : 'tone-good'}`}>
          <span aria-hidden="true">{direction === 'up' ? '↑' : '↓'}</span>
          <span className="sr-only">{direction === 'up' ? 'up' : 'down'}</span> <Money cents={Math.abs(c.diff)} whole />
        </span>
      </>
    );
    // Fun Money rows never lead to transactions (a partner's are private).
    return isFunMoney(c.categoryId) || !compared ? (
      <div key={c.categoryId} className="row">
        {content}
      </div>
    ) : (
      <button key={c.categoryId} type="button" className="row row-button" onClick={() => go('activity', { categoryId: c.categoryId, month: compared })}>
        {content}
      </button>
    );
  };

  return (
    <Card className="trends-wide-card">
      <h2>{basis === 'this-month' ? 'What changed this month' : `What changed in ${compared ? monthLabel(compared) : 'last month'}`}</h2>
      <p className="muted small">
        {basis === 'this-month'
          ? 'Everyday, Habits and Fun & Wants: this month so far, scaled up to a full month, compared with usual (the last 3 full months). Changes under $20 are left out.'
          : 'Everyday, Habits and Fun & Wants: it’s early in the month, so this compares last month with the 3 months before it. Changes under $20 are left out.'}
      </p>
      {!hasUsual ? (
        <p className="muted">Needs a full month of history to compare with.</p>
      ) : up.length === 0 && down.length === 0 ? (
        <p className="muted">Nothing out of the ordinary.</p>
      ) : (
        <div className="changes">
          {up.length > 0 && (
            <div>
              <h3 className="changes-title">Up</h3>
              <div className="list">{up.map((c) => rowFor(c, 'up'))}</div>
            </div>
          )}
          {down.length > 0 && (
            <div>
              <h3 className="changes-title">Down</h3>
              <div className="list">{down.map((c) => rowFor(c, 'down'))}</div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
