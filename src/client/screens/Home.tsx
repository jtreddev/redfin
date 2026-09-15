import { useState } from 'react';
import { api, ApiError, errorMessage } from '../api';
import { money, monthLabel, plural, shortDate, timeAgo, weekdayDate } from '../format';
import { go } from '../router';
import { useApp, useLoad } from '../state';
import { syncAllBanks } from '../sync';
import type { HomeResponse } from '../types';
import { Button, Card, ErrorNote, Loading, Money, PageHeader } from '../ui';

const CACHE_KEY = 'fin.home';

function cachedHome(): HomeResponse | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as HomeResponse) : null;
  } catch {
    return null;
  }
}

export function Home() {
  const { me, toast, reload } = useApp();
  const [offline, setOffline] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);

  const home = useLoad(async () => {
    try {
      const data = await api<HomeResponse>('/home');
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      } catch {
        // storage unavailable
      }
      setOffline(false);
      return data;
    } catch (error) {
      const cached = error instanceof ApiError && error.status === 0 ? cachedHome() : null;
      if (!cached) throw error;
      setOffline(true);
      return cached;
    }
  }, []);

  async function syncNow() {
    setSyncing('Syncing…');
    try {
      const result = await syncAllBanks((step) => {
        if (step.institutionName) setSyncing(`${step.institutionName}…`);
      });
      if (result.errors.length) toast(result.errors[0] ?? 'A bank had a problem syncing', 'error');
      else toast(result.added ? `${plural(result.added, 'new transaction')}` : 'Everything is up to date');
      await Promise.all([home.reload(), reload()]);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setSyncing(null);
    }
  }

  const h = home.data;
  return (
    <div className="stack">
      <PageHeader
        title={`Hi, ${me.viewer.name}`}
        subtitle={weekdayDate(me.today)}
        action={
          h?.banks.length ? (
            <Button small onClick={() => void syncNow()} disabled={Boolean(syncing) || offline}>
              {syncing ?? 'Sync'}
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
          <SafeToSpendCard h={h} />

          {h.uncategorizedCount > 0 && (
            <Card onClick={() => go('activity', { filter: 'uncategorized' })}>
              <div className="spread">
                <div>
                  <strong>
                    {plural(h.uncategorizedCount, 'transaction')} {h.uncategorizedCount === 1 ? 'needs' : 'need'} a category
                  </strong>
                  <p className="muted small">Sorting them teaches the app for next time.</p>
                </div>
                <span className="chip chip-warn">Sort</span>
              </div>
            </Card>
          )}

          <FunMoneyCard h={h} />
          <BillsCard h={h} />

          {h.checkin && (
            <Card onClick={() => go('more/checkin', { month: h.checkin?.month })}>
              <div className="spread">
                <div>
                  <strong>Time for your {monthLabel(h.checkin.month)} check-in</strong>
                  <p className="muted small">15 minutes together: what went well, what to change, agree on next month.</p>
                </div>
                <span className="chip chip-brand">{h.checkin.status === 'not_started' ? 'Start' : 'Continue'}</span>
              </div>
            </Card>
          )}

          {h.banks.length > 0 && <p className="muted small center">Banks last synced {timeAgo(h.lastSyncedAt)}</p>}
        </>
      )}
    </div>
  );
}

function SafeToSpendCard({ h }: { h: HomeResponse }) {
  const { safe, week } = h;
  const noPlan = h.startingBalance.source === 'none' && safe.flexibleLeftCents === 0;
  return (
    <>
      <Card className="hero">
        <div className="label">Safe to spend this week</div>
        <div className="hero-amount">{money(safe.safeCents, { whole: true })}</div>
        {week ? (
          <p className="muted">
            Week {week.index} · {shortDate(week.start)}–{shortDate(week.end)} · flexible budget left{' '}
            {money(safe.flexibleLeftCents, { whole: true })}
          </p>
        ) : (
          <p className="muted">Add your paycheck and a budget to see this.</p>
        )}
        {safe.cushionCents < 0 ? (
          <p>
            Heads up: the plan dips below your {money(h.lowBalanceCents, { whole: true })} cushion later this month, so
            this week’s number is held back.
          </p>
        ) : safe.extraRoomCents > 0 && !noPlan ? (
          <p className="muted">Beyond the plan, the month has {money(safe.extraRoomCents, { whole: true })} of extra room.</p>
        ) : null}
      </Card>

      {h.weeks.length > 0 && (
        <Card onClick={() => go('plan', { tab: 'weeks' })}>
          <div className="spread">
            <h2>This month, week by week</h2>
            {h.extraPaychecks > 0 && <span className="chip chip-brand">Extra paycheck</span>}
          </div>
          <div className="weeks">
            {h.weeks.map((w) => (
              <div key={w.index} className={`week-pill ${w.status} ${w.isCurrent ? 'current' : ''}`}>
                <div className="muted">Wk {w.index}</div>
                <Money cents={w.endBalance} whole />
              </div>
            ))}
          </div>
          <p className="muted small">
            {h.startingBalance.source === 'none'
              ? 'Set a starting balance (or connect your bank) so these are real.'
              : 'End-of-week cash if you stick to the plan.'}
          </p>
        </Card>
      )}
    </>
  );
}

function FunMoneyCard({ h }: { h: HomeResponse }) {
  const mine = h.fun.find((f) => f.isViewer);
  const others = h.fun.filter((f) => !f.isViewer);
  const anyAllowance = h.fun.some((f) => (f.allowancePerPaydayCents ?? 0) > 0 || f.balanceCents !== 0);
  if (!anyAllowance) return null;
  return (
    <Card onClick={() => go('more/fun')}>
      <div className="label">Fun money</div>
      <div className="spread">
        {mine && (
          <div>
            <div className="muted small">You</div>
            <Money cents={mine.balanceCents} whole className="big" tone={mine.balanceCents < 0 ? 'bad' : undefined} />
          </div>
        )}
        {others.map((o) => (
          <div key={o.memberId} style={{ textAlign: 'right' }}>
            <div className="muted small">{o.name}</div>
            <Money cents={o.balanceCents} whole className="big" />
          </div>
        ))}
      </div>
      <p className="muted small">Yours to spend, no questions asked. Only totals are shared.</p>
    </Card>
  );
}

function BillsCard({ h }: { h: HomeResponse }) {
  if (!h.bills.length) return null;
  return (
    <Card onClick={() => go('plan', { tab: 'bills' })}>
      <h2>Coming up</h2>
      <div className="stack-sm">
        {h.bills.map((bill) => (
          <div key={`${bill.name}-${bill.date}`} className="spread">
            <div>
              <div>{bill.name}</div>
              <div className="muted small">
                {shortDate(bill.date)}
                {bill.overdue && <span className="chip chip-bad" style={{ marginLeft: 6 }}>not paid yet</span>}
              </div>
            </div>
            <Money cents={bill.amountCents} whole />
          </div>
        ))}
      </div>
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
      <div className="stack-sm">
        {steps.map((s) => (
          <button key={s.label} type="button" className="row row-button" onClick={() => go(s.path)} disabled={s.done}>
            <span>
              {s.done ? '✓ ' : '○ '}
              {s.label}
            </span>
            {!s.done && <span className="muted">›</span>}
          </button>
        ))}
      </div>
    </Card>
  );
}
