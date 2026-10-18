import { useMemo, useState } from 'react';
import { GROUP_ORDER } from '../../shared/trends';
import { api, ApiError, errorMessage } from '../api';
import { money, monthLabel, plural, shortDate, timeAgo, weekdayDate } from '../format';
import { Icon } from '../icons';
import { ribbonLayout, usableCachedRibbon } from '../ribbon';
import { go } from '../router';
import { useApp, useLoad } from '../state';
import { syncAllBanks } from '../sync';
import type { HomeResponse, Transaction, TrendsResponse } from '../types';
import { Button, Card, ErrorNote, Loading, Money, PageHeader } from '../ui';
import { TransactionSheet } from './TransactionSheet';

const CACHE_KEY = 'fin.home';
/** This month's trends, cached beside Home (its own key, so an older 'fin.home' cache still reads). */
const TRENDS_CACHE_KEY = 'fin.home.trends';

function cached<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable
  }
}

export function Home() {
  const { me, toast, reload } = useApp();
  const [offline, setOffline] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [open, setOpen] = useState<Transaction | null>(null);

  const home = useLoad(async () => {
    try {
      const data = await api<HomeResponse>('/home');
      store(CACHE_KEY, data);
      setOffline(false);
      return data;
    } catch (error) {
      const offlineHome = error instanceof ApiError && error.status === 0 ? cached<HomeResponse>(CACHE_KEY) : null;
      if (!offlineHome) throw error;
      setOffline(true);
      return offlineHome;
    }
  }, []);

  // The ribbon loads on its own and can never hold Home up or put it offline: any failure falls back to this
  // month's cached ribbon, or none. The cached one also shows while it loads, so it doesn't pop in.
  const cachedRibbon = useMemo(() => usableCachedRibbon(cached<TrendsResponse>(TRENDS_CACHE_KEY), me.today), [me.today]);
  const ribbon = useLoad(async (): Promise<TrendsResponse | null> => {
    try {
      const data = await api<TrendsResponse>('/trends?months=3');
      store(TRENDS_CACHE_KEY, data);
      return data;
    } catch {
      return cachedRibbon;
    }
  }, [cachedRibbon]);

  async function syncNow() {
    setSyncing('Syncing…');
    try {
      const result = await syncAllBanks((step) => {
        if (step.institutionName) setSyncing(`${step.institutionName}…`);
      });
      if (result.errors.length) toast(result.errors[0] ?? 'A bank had a problem syncing', 'error');
      else toast(result.added ? `${plural(result.added, 'new transaction')}` : 'Everything is up to date');
      await Promise.all([home.reload(), ribbon.reload(), reload()]);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setSyncing(null);
    }
  }

  const h = home.data;
  const trends = ribbon.data !== undefined ? ribbon.data : cachedRibbon;
  return (
    <div className="stack home">
      <PageHeader
        title={`Hi, ${me.viewer.name}`}
        subtitle={weekdayDate(me.today)}
        action={
          h?.banks.length ? (
            <Button small onClick={() => void syncNow()} disabled={Boolean(syncing) || offline}>
              {syncing ?? 'Sync now'}
            </Button>
          ) : undefined
        }
      />
      {offline && <div className="offline">Offline: showing the last numbers loaded.</div>}
      {home.error && !h && <ErrorNote message={home.error} onRetry={() => void home.reload()} />}
      {!h ? (
        !home.error && <Loading />
      ) : (
        <>
          {h.banks
            .filter((b) => b.status !== 'ok')
            .map((b) => (
              <div key={b.id} className="banner banner-warn">
                <span>
                  {b.status === 'login_required'
                    ? `${b.institutionName ?? 'A bank'} needs you to sign in again.`
                    : `${b.institutionName ?? 'A bank'} stopped syncing.`}
                </span>
                <Button small onClick={() => go('more/accounts')}>
                  Fix
                </Button>
              </div>
            ))}

          <SetupChecklist />
          <div className="home-top">
            <SafeToSpend h={h} />
            {trends && <MonthRibbon t={trends} />}
          </div>

          <NeedsLookCard h={h} onOpen={setOpen} />
          <WeeksCard h={h} />
          <BillsCard h={h} />
          <FunMoneyCard h={h} />

          {h.checkin && (
            <Card onClick={() => go('more/checkin', { month: h.checkin?.month })}>
              <span className="spread">
                <span>
                  <strong className="h2">Time for your {monthLabel(h.checkin.month)} check-in</strong>
                  <span className="muted small block">15 minutes together: what went well, what to change, agree on next month.</span>
                </span>
                <span className="chip chip-brand">{h.checkin.status === 'not_started' ? 'Start' : 'Continue'}</span>
              </span>
            </Card>
          )}

          {h.banks.length > 0 && <p className="muted small">Banks last synced {timeAgo(h.lastSyncedAt)}</p>}
        </>
      )}
      {open && (
        <TransactionSheet
          txn={open}
          onClose={() => setOpen(null)}
          // Undo can arrive after the sheet has closed: just refresh Home.
          onChanged={() => void Promise.all([home.reload(), ribbon.reload()])}
        />
      )}
    </div>
  );
}

/** Each group's color, as on Trends: dataviz categorical slots 1–5 in the groups' fixed order. */
const GROUP_COLOR: Record<string, string> = Object.fromEntries(GROUP_ORDER.map((g, i) => [g.key, `--series-${i + 1}`]));

/**
 * The month ribbon: this month's spending so far as one bar split by group, with an upright mark where a
 * usual month ends. The whole ribbon is one button into Trends.
 */
function MonthRibbon({ t }: { t: TrendsResponse }) {
  const current = t.months.indexOf(t.partialMonth);
  const groups = t.groups.map((g) => ({ key: g.key, name: g.name, value: g.byMonth[current] ?? 0 }));
  const usual = GROUP_ORDER.reduce((sum, g) => sum + t.usual[g.key], 0);
  const layout = ribbonLayout(
    groups.map((g) => g.value),
    usual,
  );
  const shown = groups.filter((g) => g.value > 0);
  const filled = layout.widths.reduce((a, b) => a + b, 0);
  const summary =
    `${money(layout.total, { whole: true })} spent so far this month` +
    (usual > 0 ? `; a usual month is ${money(usual, { whole: true })}. ` : '. ') +
    shown.map((g) => `${g.name} ${money(g.value, { whole: true })}`).join(', ') +
    '. Opens Trends.';
  return (
    <button type="button" className="ribbon" onClick={() => go('trends')} aria-label={summary}>
      <span className="ribbon-head">
        <strong>
          <Money cents={layout.total} whole /> spent so far this month
        </strong>
        <span className="ribbon-go">
          Trends
          <Icon name="forward" />
        </span>
      </span>
      <span className="ribbon-track">
        <span className="ribbon-bar" style={{ width: `${filled}%` }}>
          {groups.map((g, i) =>
            (layout.widths[i] ?? 0) > 0 ? (
              <span key={g.key} className="ribbon-seg" style={{ flexGrow: layout.widths[i], background: `var(${GROUP_COLOR[g.key]})` }} />
            ) : null,
          )}
        </span>
        {layout.usualAt !== null && <span className="ribbon-usual" style={{ left: `${layout.usualAt}%` }} />}
      </span>
      <span className="ribbon-legend">
        {shown.map((g) => (
          <span key={g.key} className="chart-legend-item">
            <span className="chart-swatch" style={{ background: `var(${GROUP_COLOR[g.key]})` }} />
            {g.name}
            <Money cents={g.value} whole className="muted" />
          </span>
        ))}
      </span>
      <span className="ribbon-caption muted">
        {usual > 0 ? (
          <>
            The upright line marks a usual month, <Money cents={usual} whole /> (the last 3 full months).
          </>
        ) : (
          'A usual month shows up here once there’s a full month of history.'
        )}
      </span>
    </button>
  );
}

function SafeToSpend({ h }: { h: HomeResponse }) {
  const { safe, week } = h;
  const noPlan = h.startingBalance.source === 'none' && safe.flexibleLeftCents === 0;
  return (
    <section className="hero" aria-labelledby="safe-label">
      <h2 id="safe-label" className="sr-only">
        Safe to spend this week
      </h2>
      <div className={`hero-amount ${safe.safeCents < 0 ? 'tone-bad' : ''}`}>{money(safe.safeCents, { whole: true })}</div>
      <div className="hero-label" aria-hidden="true">
        safe to spend this week
      </div>
      {week ? (
        <p className="hero-note muted">
          Week {week.index}, {shortDate(week.start)}–{shortDate(week.end)}. Flexible budget left this month:{' '}
          <Money cents={safe.flexibleLeftCents} whole />.
        </p>
      ) : (
        <p className="hero-note muted">Add your paycheck and a budget to see this.</p>
      )}
      {safe.cushionCents < 0 ? (
        <p className="hero-note tone-warn">
          Heads up: the plan dips below your {money(h.lowBalanceCents, { whole: true })} cushion later this month, so this
          week’s number is held back.
        </p>
      ) : safe.extraRoomCents > 0 && !noPlan ? (
        <p className="hero-note muted">Beyond the plan, the month has {money(safe.extraRoomCents, { whole: true })} of extra room.</p>
      ) : null}
    </section>
  );
}

/** Weeks that need attention say so in words, not only in color. */
const WEEK_WORD = { ok: null, low: 'low', negative: 'short' } as const;

function WeeksCard({ h }: { h: HomeResponse }) {
  if (!h.weeks.length) return null;
  return (
    <Card onClick={() => go('plan', { tab: 'weeks' })}>
      <span className="spread">
        <strong className="h2">Week by week</strong>
        {h.extraPaychecks > 0 && <span className="chip chip-brand">Extra paycheck</span>}
      </span>
      <span className="weeks">
        {h.weeks.map((w) => {
          const word = WEEK_WORD[w.status];
          return (
            <span key={w.index} className={`week-pill ${w.status} ${w.isCurrent ? 'current' : ''}`}>
              <span className="muted">
                Wk {w.index}
                {w.isCurrent && <span className="sr-only"> (this week)</span>}
              </span>
              <Money cents={w.endBalance} whole />
              {word && <span className={`week-state ${w.status === 'low' ? 'tone-warn' : 'tone-bad'}`}>{word}</span>}
            </span>
          );
        })}
      </span>
      <span className="muted small">
        {h.startingBalance.source === 'none'
          ? 'Set a starting balance (or connect your bank) so these are real.'
          : 'Cash at the end of each week if you stick to the plan.'}
      </span>
    </Card>
  );
}

/** Recent spending the app couldn't file. Hidden when there's none. */
function NeedsLookCard({ h, onOpen }: { h: HomeResponse; onOpen: (t: Transaction) => void }) {
  const needsLook = h.needsLook;
  if (!needsLook?.count) return null;
  const more = needsLook.count - needsLook.items.length;
  return (
    <Card>
      <div className="spread">
        <h2>Needs a look</h2>
        <span className="chip chip-warn">{plural(needsLook.count, 'charge')}</span>
      </div>
      <p className="muted small">Recent charges the app couldn’t file. Picking a category teaches it for next time.</p>
      <div className="list">
        {needsLook.items.map((t) => (
          <button key={t.id} type="button" className="row row-button" onClick={() => onOpen(t)}>
            <div className="row-main">
              <div className="row-title">
                {t.isPrivate && (
                  <span className="private-mark" title="My fun money: only you see this">
                    <Icon name="lock" />
                    <span className="sr-only">Private: </span>
                  </span>
                )}
                {t.merchantName ?? t.name}
              </div>
              <div className="row-sub">
                {shortDate(t.date)}, {t.accountName}
              </div>
            </div>
            <Money cents={t.amountCents} />
          </button>
        ))}
      </div>
      {more > 0 && (
        <Button small variant="ghost" className="btn-flush" onClick={() => go('activity', { filter: 'uncategorized' })}>
          See all {needsLook.count}
        </Button>
      )}
    </Card>
  );
}

function FunMoneyCard({ h }: { h: HomeResponse }) {
  const mine = h.fun.find((f) => f.isViewer);
  const others = h.fun.filter((f) => !f.isViewer);
  const anyAllowance = h.fun.some((f) => (f.allowancePerPaydayCents ?? 0) > 0 || f.balanceCents !== 0);
  if (!anyAllowance) return null;
  return (
    <Card onClick={() => go('more/fun')}>
      <strong className="h2">Fun money</strong>
      <span className="figures">
        {mine && (
          <span className="figure">
            <Money cents={mine.balanceCents} whole className="big" tone={mine.balanceCents < 0 ? 'bad' : undefined} />
            <span className="label">yours</span>
          </span>
        )}
        {others.map((o) => (
          <span key={o.memberId} className="figure">
            <Money cents={o.balanceCents} whole className="big" />
            <span className="label">{o.name}’s</span>
          </span>
        ))}
      </span>
      <span className="muted small">Yours to spend, no questions asked. Only totals are shared.</span>
    </Card>
  );
}

function BillsCard({ h }: { h: HomeResponse }) {
  if (!h.bills.length) return null;
  return (
    <Card onClick={() => go('plan', { tab: 'bills' })}>
      <strong className="h2">Coming up</strong>
      <span className="stack-sm">
        {h.bills.map((bill) => (
          <span key={`${bill.name}-${bill.date}`} className="spread">
            <span>
              <span className="block">{bill.name}</span>
              <span className="muted small">
                {shortDate(bill.date)}
                {bill.overdue && <span className="chip chip-bad">not paid yet</span>}
              </span>
            </span>
            <Money cents={bill.amountCents} whole />
          </span>
        ))}
      </span>
    </Card>
  );
}

function SetupChecklist() {
  const { me } = useApp();
  const steps = [
    { done: me.setup.incomeSources > 0, label: 'Add your paycheck', path: 'more/income' },
    { done: me.setup.accounts > 0, label: 'Connect a bank or import a file', path: 'more/accounts' },
    { done: me.setup.budgetLines > 0, label: 'Set this month’s budget', path: 'plan' },
    { done: me.members.some((m) => m.funAllowanceCents > 0), label: 'Agree on fun money', path: 'more/fun' },
    { done: me.members.length > 1, label: 'Get your partner signed in', path: 'more/settings' },
  ];
  if (steps.every((s) => s.done)) return null;
  return (
    <Card>
      <h2>Getting set up</h2>
      <div className="list">
        {steps.map((s) => (
          <button key={s.label} type="button" className="row row-button" onClick={() => go(s.path)} disabled={s.done}>
            <span className="cluster">
              <span className={`check ${s.done ? 'done' : ''}`}>{s.done && <Icon name="check" />}</span>
              <span className={s.done ? 'muted' : ''}>{s.label}</span>
              {s.done && <span className="sr-only">(done)</span>}
            </span>
            {!s.done && <Icon name="forward" className="row-chevron" />}
          </button>
        ))}
      </div>
    </Card>
  );
}
