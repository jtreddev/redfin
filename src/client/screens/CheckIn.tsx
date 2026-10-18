import { useEffect, useRef, useState } from 'react';
import type { MonthSummary, OverspendDecision } from '../../shared/checkin';
import { addMonths, monthOf } from '../../shared/dates';
import type { GoalProgress } from '../../shared/goals';
import { api, errorMessage, patch, post } from '../api';
import { monthLabel, shortDate } from '../format';
import { useApp, useLoad } from '../state';
import { AmountInput, Button, Card, ErrorNote, Field, Loading, Money, MonthPicker, Progress, Segmented } from '../ui';
import { SubHeader } from './More';

interface CheckinItems {
  wins?: string;
  upcomingNotes?: string;
  decisions?: Record<string, OverspendDecision>;
  actionItems?: { text: string; ownerId: number | null; done: boolean }[];
}

interface CheckinResponse {
  checkin: { id: number; month: string; status: 'draft' | 'agreed' | 'complete'; step: number; notes: string | null; items: CheckinItems; agreedBy: number[] };
  members: { id: number; name: string; color: string }[];
  frozen: boolean;
  summary: MonthSummary;
  goals: { id: number; name: string; savedCents: number; targetCents: number; progress: GoalProgress }[];
  upcoming: { name: string; amountCents: number; when: string; kind: string }[];
  nextMonth: string;
}

const STEPS = ['Start', 'Numbers', 'Wins', 'Over budget', 'Goals', 'Coming up', 'To-dos', 'Agree'];

export function CheckIn({ params }: { params: URLSearchParams }) {
  const { me, toast } = useApp();
  const [month, setMonth] = useState(params.get('month') ?? addMonths(monthOf(me.today), -1));
  const data = useLoad(() => api<CheckinResponse>(`/checkins/${month}`), [month]);
  const [step, setStep] = useState(0);
  const [items, setItems] = useState<CheckinItems>({});
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!data.data) return;
    setItems(data.data.checkin.items ?? {});
    setStep(data.data.frozen ? STEPS.length - 1 : data.data.checkin.step);
  }, [data.data]);

  function updateItems(next: CheckinItems) {
    setItems(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      patch(`/checkins/${month}`, { items: next })
        .then(() => data.reload())
        .catch((e) => toast(errorMessage(e), 'error'));
    }, 700);
  }

  function goStep(next: number) {
    setStep(next);
    window.scrollTo(0, 0);
    if (!data.data?.frozen) patch(`/checkins/${month}`, { step: next }).catch(() => undefined);
  }

  async function agree(value: boolean) {
    try {
      await post(`/checkins/${month}/agree`, { agree: value });
      await data.reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function complete() {
    try {
      const res = await post<{ budgetChanges: number }>(`/checkins/${month}/complete`);
      toast(`Check-in done${res.budgetChanges ? ` and ${res.budgetChanges} budget changes applied` : ''}. Nice work, team.`);
      await data.reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  const d = data.data;
  return (
    <div className="stack">
      <SubHeader title="Monthly check-in" />
      <MonthPicker month={month} onChange={setMonth} />
      {data.error && <ErrorNote message={data.error} onRetry={() => void data.reload()} />}
      {!d ? (
        !data.error && <Loading />
      ) : (
        <>
          <div className="steps" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
            {STEPS.map((s, i) => (
              <span key={s} className={i <= step ? 'done' : ''} />
            ))}
          </div>
          <div className="muted small">
            {STEPS[step]} · {monthLabel(month)}
            {d.frozen && ' · finished'}
          </div>

          {step === 0 && (
            <Card>
              <h2>Before you start</h2>
              <ol className="stack-sm" style={{ paddingLeft: 20, margin: 0 }}>
                <li>We’re on the same team. The problem is the problem, not either of us.</li>
                <li>Last month is done. No blame, just what we do next.</li>
                <li>Fun money isn’t up for discussion. That’s the point of it.</li>
                <li>Keep it short: 15 minutes, then do something fun together.</li>
              </ol>
            </Card>
          )}

          {step === 1 && (
            <Card>
              <h2>How {monthLabel(month)} went</h2>
              <div className="stack-sm">
                <div className="spread">
                  <span>Money in</span>
                  <span>
                    <Money cents={d.summary.incomeActualCents} whole tone="good" />{' '}
                    <span className="muted small">of <Money cents={d.summary.incomeBudgetCents} whole /></span>
                  </span>
                </div>
                <div className="spread">
                  <span>Spent & saved</span>
                  <span>
                    <Money cents={d.summary.spendActualCents} whole />{' '}
                    <span className="muted small">of <Money cents={d.summary.spendBudgetCents} whole /></span>
                  </span>
                </div>
                <div className="spread">
                  <strong>{d.summary.netActualCents >= 0 ? 'Left over' : 'Short'}</strong>
                  <Money cents={Math.abs(d.summary.netActualCents)} whole className="big" tone={d.summary.netActualCents >= 0 ? 'good' : 'bad'} />
                </div>
              </div>
              {d.summary.unbudgeted.length > 0 && (
                <p className="muted small">
                  Not in the plan:{' '}
                  {d.summary.unbudgeted.map((l, i) => (
                    <span key={l.name}>
                      {i > 0 && ', '}
                      {l.name} (<Money cents={l.actualCents} whole />)
                    </span>
                  ))}
                  .
                </p>
              )}
            </Card>
          )}

          {step === 2 && (
            <Card>
              <h2>Wins 🎉</h2>
              {d.summary.wins.length === 0 ? (
                <p className="muted">No categories came in well under budget. That’s okay.</p>
              ) : (
                <div className="stack-sm">
                  {d.summary.wins.map((w) => (
                    <div key={w.categoryId} className="spread">
                      <span>{w.name}</span>
                      <span className="tone-good"><Money cents={w.underCents} whole /> under</span>
                    </div>
                  ))}
                </div>
              )}
              <Field label="What went well? (each of you say one thing)">
                <textarea value={items.wins ?? ''} disabled={d.frozen} onChange={(e) => updateItems({ ...items, wins: e.target.value })} />
              </Field>
            </Card>
          )}

          {step === 3 && (
            <Card>
              <h2>Over budget</h2>
              {d.summary.overspent.length === 0 ? (
                <p className="muted">Nothing went over. 🙌</p>
              ) : (
                <div className="stack">
                  <p className="muted small">For each one, decide together: was the budget unrealistic, or was it a one-off?</p>
                  {d.summary.overspent.map((line) => {
                    const decision = items.decisions?.[String(line.categoryId)] ?? { kind: 'keep' as const };
                    const setDecision = (next: OverspendDecision) =>
                      updateItems({ ...items, decisions: { ...(items.decisions ?? {}), [String(line.categoryId)]: next } });
                    return (
                      <div key={line.categoryId} className="stack-sm">
                        <div className="spread">
                          <strong>{line.name}</strong>
                          <span className="tone-bad"><Money cents={line.overCents} whole /> over</span>
                        </div>
                        <div className="muted small">
                          Spent <Money cents={line.actualCents} whole /> of <Money cents={line.budgetCents} whole />
                        </div>
                        {line.categoryId > 0 && !d.frozen && (
                          <>
                            <Segmented
                              value={decision.kind}
                              onChange={(kind) =>
                                setDecision(kind === 'set' ? { kind, newBudgetCents: line.budgetCents } : kind === 'raise' ? { kind } : { kind: 'keep' })
                              }
                              options={[
                                { value: 'keep', label: 'One-off' },
                                { value: 'raise', label: <>Raise to <Money cents={line.actualCents} whole /></> },
                                { value: 'set', label: 'New amount' },
                              ]}
                            />
                            {decision.kind === 'set' && (
                              <AmountInput cents={decision.newBudgetCents} onChange={(cents) => setDecision({ kind: 'set', newBudgetCents: cents ?? 0 })} />
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          )}

          {step === 4 && (
            <Card>
              <h2>Goals</h2>
              {d.goals.length === 0 ? (
                <p className="muted">No goals yet. Pick one together on the Goals tab.</p>
              ) : (
                <div className="stack">
                  {d.goals.map((g) => (
                    <div key={g.id} className="stack-sm">
                      <div className="spread">
                        <strong>{g.name}</strong>
                        <span className="small">
                          <Money cents={g.savedCents} whole /> / <Money cents={g.targetCents} whole />
                        </span>
                      </div>
                      <Progress value={g.savedCents} max={g.targetCents} tone="good" />
                      {g.progress.monthlyNeededCents !== null && g.progress.status !== 'done' && (
                        <div className="muted small">
                          Needs <Money cents={g.progress.monthlyNeededCents} whole />/month · {g.progress.status === 'behind' ? 'behind' : 'on track'}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {step === 5 && (
            <Card>
              <h2>Coming up in {monthLabel(d.nextMonth)}</h2>
              {d.upcoming.length === 0 ? (
                <p className="muted">No big bills on the radar.</p>
              ) : (
                <div className="stack-sm">
                  {d.upcoming.map((u) => (
                    <div key={`${u.name}-${u.when}`} className="spread">
                      <span>
                        {u.name} <span className="muted small">{u.when.length === 10 ? shortDate(u.when) : ''}</span>
                      </span>
                      <Money cents={u.amountCents} whole />
                    </div>
                  ))}
                </div>
              )}
              <Field label="Anything else coming? Birthdays, school fees, car stuff…">
                <textarea value={items.upcomingNotes ?? ''} disabled={d.frozen} onChange={(e) => updateItems({ ...items, upcomingNotes: e.target.value })} />
              </Field>
            </Card>
          )}

          {step === 6 && (
            <Card>
              <h2>To-dos</h2>
              <div className="stack-sm">
                {(items.actionItems ?? []).map((item, i) => (
                  <div key={i} className="cluster">
                    <input
                      type="checkbox"
                      checked={item.done}
                      disabled={d.frozen}
                      onChange={(e) =>
                        updateItems({ ...items, actionItems: (items.actionItems ?? []).map((a, j) => (j === i ? { ...a, done: e.target.checked } : a)) })
                      }
                    />
                    <input
                      style={{ flex: 1 }}
                      value={item.text}
                      disabled={d.frozen}
                      onChange={(e) =>
                        updateItems({ ...items, actionItems: (items.actionItems ?? []).map((a, j) => (j === i ? { ...a, text: e.target.value } : a)) })
                      }
                    />
                    <select
                      style={{ width: 'auto' }}
                      value={item.ownerId ?? ''}
                      disabled={d.frozen}
                      onChange={(e) =>
                        updateItems({
                          ...items,
                          actionItems: (items.actionItems ?? []).map((a, j) => (j === i ? { ...a, ownerId: e.target.value ? Number(e.target.value) : null } : a)),
                        })
                      }
                    >
                      <option value="">Both</option>
                      {d.members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                {!d.frozen && (
                  <Button small onClick={() => updateItems({ ...items, actionItems: [...(items.actionItems ?? []), { text: '', ownerId: null, done: false }] })}>
                    Add a to-do
                  </Button>
                )}
              </div>
            </Card>
          )}

          {step === 7 && (
            <Card>
              <h2>Agree on the plan</h2>
              {d.frozen ? (
                <p>Finished. Next month’s budget was updated with what you decided.</p>
              ) : (
                <>
                  <p className="muted">
                    When you’re both happy, each tap Agree on your own phone. Finishing copies this month’s budget to{' '}
                    {monthLabel(d.nextMonth)} (if it isn’t set yet) and applies your changes.
                  </p>
                  <div className="stack-sm">
                    {d.members.map((m) => (
                      <div key={m.id} className="spread">
                        <span>{m.name}</span>
                        <span className={d.checkin.agreedBy.includes(m.id) ? 'tone-good' : 'muted'}>
                          {d.checkin.agreedBy.includes(m.id) ? '✓ Agreed' : 'Not yet'}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="cluster">
                    {d.checkin.agreedBy.includes(me.viewer.memberId) ? (
                      <Button onClick={() => void agree(false)}>Undo my agree</Button>
                    ) : (
                      <Button variant="primary" onClick={() => void agree(true)}>
                        I agree
                      </Button>
                    )}
                    <Button variant="primary" disabled={d.checkin.status !== 'agreed'} onClick={() => void complete()}>
                      Finish check-in
                    </Button>
                  </div>
                </>
              )}
            </Card>
          )}

          <div className="spread">
            <Button onClick={() => goStep(Math.max(0, step - 1))} disabled={step === 0}>
              Back
            </Button>
            {step < STEPS.length - 1 && (
              <Button variant="primary" onClick={() => goStep(step + 1)}>
                Next
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
