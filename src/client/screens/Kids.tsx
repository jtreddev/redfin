import { useState } from 'react';
import { monthEnd, monthOf, monthStart } from '../../shared/dates';
import { api, errorMessage, patch, post, put } from '../api';
import { money } from '../format';
import { go } from '../router';
import { useApp, useLoad } from '../state';
import type { Kid } from '../types';
import { moveId } from '../categoryTree';
import { Icon } from '../icons';
import { KidFormSheet } from '../quickAdd';
import { AmountInput, Button, Card, Empty, ErrorNote, Field, Loading, Money, MonthPicker, Progress, Sheet } from '../ui';
import { SubHeader } from './More';

interface KidReport {
  from: string;
  to: string;
  kids: (Kid & { totalCents: number; budgetCents: number; byCategory: { categoryId: number | null; name: string; cents: number; budgetCents: number }[] })[];
  untaggedCents: number;
  untaggedCount: number;
}

export function Kids() {
  const { me, reload, toast } = useApp();
  const [month, setMonth] = useState(monthOf(me.today));
  const report = useLoad(() => api<KidReport>(`/kids/report?from=${monthStart(month)}&to=${monthEnd(month)}`), [month]);
  const all = useLoad(() => api<Kid[]>('/kids'), [me.kids.length]);
  const [editingKid, setEditingKid] = useState<Kid | 'new' | null>(null);
  const [budgetKid, setBudgetKid] = useState<KidReport['kids'][number] | null>(null);
  const year = Number(me.today.slice(0, 4));
  const hidden = (all.data ?? []).filter((k) => k.archived);
  // The report follows the kids' order; me.kids is the source of truth for it.
  const ordered = report.data ? me.kids.map((k) => report.data!.kids.find((r) => r.id === k.id)).filter((k) => k !== undefined) : [];

  async function refresh() {
    await Promise.all([reload(), report.reload(), all.reload()]);
  }

  async function move(id: number, delta: number) {
    const next = moveId(
      me.kids.map((k) => k.id),
      id,
      delta,
    );
    if (!next) return;
    try {
      await post('/kids/reorder', { ids: next });
      await refresh();
      document.getElementById(`kid-${delta < 0 ? 'up' : 'down'}-${id}`)?.focus();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function setHidden(kid: Kid, archived: boolean) {
    try {
      await patch(`/kids/${kid.id}`, { archived });
      await refresh();
      toast(archived ? `${kid.name} is hidden` : `${kid.name} is back`);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <div className="stack">
      <SubHeader title="Kids" />
      <Button variant="primary" className="add-kid" onClick={() => setEditingKid('new')}>
        <Icon name="plus" />
        Add a kid
      </Button>
      {me.kids.length === 0 ? (
        <Empty title="Add your kids">Then tag purchases to a kid to see what each one really costs.</Empty>
      ) : (
        <>
          <MonthPicker month={month} onChange={setMonth} />
          {report.error && <ErrorNote message={report.error} onRetry={() => void report.reload()} />}
          {!report.data ? (
            <Loading />
          ) : (
            <>
              {report.data.untaggedCount > 0 && (
                <div className="banner banner-warn">
                  <span>
                    {money(report.data.untaggedCents, { whole: true })} of kids spending isn’t tagged to a kid yet.
                  </span>
                  <Button small onClick={() => go('activity', { month })}>
                    Tag
                  </Button>
                </div>
              )}
              {ordered.map((kid, index) => (
                <Card key={kid.id} boxed>
                  <div className="spread">
                    <div className="cluster">
                      <span className="avatar" style={{ background: kid.color }}>
                        {kid.name.slice(0, 1)}
                      </span>
                      <h2 className="h3">{kid.name}</h2>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <Money cents={kid.totalCents} whole className="big" />
                      {kid.budgetCents > 0 && <div className="muted small">of {money(kid.budgetCents, { whole: true })}</div>}
                    </div>
                  </div>
                  {kid.budgetCents > 0 && <Progress value={kid.totalCents} max={kid.budgetCents} />}
                  <div className="stack-sm" style={{ marginTop: 10 }}>
                    {kid.byCategory.length === 0 ? (
                      <p className="muted small">Nothing tagged this month.</p>
                    ) : (
                      kid.byCategory.map((c) => (
                        <div key={String(c.categoryId)} className="spread small">
                          <span>{c.name}</span>
                          <span>
                            {money(c.cents, { whole: true })}
                            {c.budgetCents > 0 && <span className="muted"> / {money(c.budgetCents, { whole: true })}</span>}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="spread kid-actions">
                    <div className="cluster">
                      <Button small onClick={() => setBudgetKid(kid)}>
                        Budgets
                      </Button>
                      <Button small variant="ghost" onClick={() => go('activity', { kid: kid.id, month })}>
                        Purchases
                      </Button>
                      <a className="btn btn-small btn-ghost" href={`/api/kids/${kid.id}/tax-summary.csv?year=${year}`} download>
                        {year} tax summary
                      </a>
                      <Button small variant="ghost" onClick={() => setEditingKid(kid)}>
                        Edit
                      </Button>
                    </div>
                    {ordered.length > 1 && (
                      <span className="reorder-btns">
                        <button type="button" id={`kid-up-${kid.id}`} className="icon-btn" aria-label={`Move ${kid.name} up`} disabled={index === 0} onClick={() => void move(kid.id, -1)}>
                          <Icon name="up" />
                        </button>
                        <button
                          type="button"
                          id={`kid-down-${kid.id}`}
                          className="icon-btn"
                          aria-label={`Move ${kid.name} down`}
                          disabled={index === ordered.length - 1}
                          onClick={() => void move(kid.id, 1)}
                        >
                          <Icon name="down" />
                        </button>
                      </span>
                    )}
                  </div>
                </Card>
              ))}
            </>
          )}
        </>
      )}

      {hidden.length > 0 && (
        <section className="stack-sm" aria-labelledby="hidden-kids">
          <div className="section-title">
            <h2 id="hidden-kids" className="h3">
              Hidden
            </h2>
          </div>
          <div className="list">
            {hidden.map((kid) => (
              <div key={kid.id} className="row">
                <span className="cluster">
                  <span className="avatar" style={{ background: kid.color }}>
                    {kid.name.slice(0, 1)}
                  </span>
                  <span>{kid.name}</span>
                </span>
                <Button small onClick={() => void setHidden(kid, false)}>
                  Show again
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {editingKid === 'new' && (
        <KidFormSheet
          kid={null}
          onClose={() => setEditingKid(null)}
          onSaved={() => {
            setEditingKid(null);
            void refresh();
          }}
        />
      )}
      {editingKid && editingKid !== 'new' && (
        <KidEditSheet
          kid={editingKid}
          onClose={() => setEditingKid(null)}
          onHide={() => {
            const kid = editingKid;
            setEditingKid(null);
            void setHidden(kid, true);
          }}
          onSaved={() => {
            setEditingKid(null);
            void refresh();
          }}
        />
      )}
      {budgetKid && (
        <KidBudgetSheet
          kid={budgetKid}
          month={month}
          onClose={() => setBudgetKid(null)}
          onSaved={async () => {
            setBudgetKid(null);
            await report.reload();
          }}
        />
      )}
    </div>
  );
}

/** Editing a kid is the add form plus "Hide": hidden kids keep their history and can come back. */
function KidEditSheet({ kid, onClose, onSaved, onHide }: { kid: Kid; onClose: () => void; onSaved: () => void; onHide: () => void }) {
  const [hiding, setHiding] = useState(false);
  if (hiding) {
    return (
      <Sheet open onClose={onClose} title={`Hide ${kid.name}?`}>
        <p className="muted">{kid.name} leaves the kid pickers and this screen. Purchases stay tagged, and you can show them again here.</p>
        <div className="cluster">
          <Button variant="danger" onClick={onHide}>
            Hide {kid.name}
          </Button>
          <Button variant="ghost" onClick={() => setHiding(false)}>
            Cancel
          </Button>
        </div>
      </Sheet>
    );
  }
  return <KidFormSheet kid={kid} onClose={onClose} onSaved={onSaved} onHide={() => setHiding(true)} />;
}

function KidBudgetSheet({ kid, month, onClose, onSaved }: { kid: KidReport['kids'][number]; month: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const { categories, toast } = useApp();
  const kidCategories = categories.filter((c) => c.kidScoped && !c.archived);
  const [values, setValues] = useState<Record<number, number | null>>(
    Object.fromEntries(kidCategories.map((c) => [c.id, kid.byCategory.find((b) => b.categoryId === c.id)?.budgetCents ?? null])),
  );

  async function save() {
    try {
      await Promise.all(
        kidCategories.map((c) => put('/kids/budgets', { kidId: kid.id, categoryId: c.id, month, budgetCents: values[c.id] ?? 0 })),
      );
      toast('Saved');
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title={`${kid.name}’s budgets`}>
      <p className="muted small">Optional. Helps you see if one kid’s activities or clothes are running hot.</p>
      {kidCategories.map((c) => (
        <Field key={c.id} label={c.name}>
          <AmountInput cents={values[c.id] ?? null} onChange={(cents) => setValues((v) => ({ ...v, [c.id]: cents }))} />
        </Field>
      ))}
      <Button variant="primary" onClick={() => void save()}>
        Save
      </Button>
    </Sheet>
  );
}
