import { useState } from 'react';
import { monthEnd, monthOf, monthStart } from '../../shared/dates';
import { api, errorMessage, patch, post, put } from '../api';
import { money } from '../format';
import { go } from '../router';
import { useApp, useLoad } from '../state';
import type { Kid } from '../types';
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
  const { me, reload } = useApp();
  const [month, setMonth] = useState(monthOf(me.today));
  const report = useLoad(() => api<KidReport>(`/kids/report?from=${monthStart(month)}&to=${monthEnd(month)}`), [month]);
  const [editingKid, setEditingKid] = useState<Kid | 'new' | null>(null);
  const [budgetKid, setBudgetKid] = useState<KidReport['kids'][number] | null>(null);
  const year = Number(me.today.slice(0, 4));

  return (
    <div className="stack">
      <SubHeader title="Kids" action={<Button small onClick={() => setEditingKid('new')}>Add kid</Button>} />
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
              {report.data.kids.map((kid) => (
                <Card key={kid.id} boxed>
                  <div className="spread">
                    <div className="cluster">
                      <span className="avatar" style={{ background: kid.color }}>
                        {kid.name.slice(0, 1)}
                      </span>
                      <strong>{kid.name}</strong>
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
                  <div className="cluster" style={{ marginTop: 10 }}>
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
                </Card>
              ))}
            </>
          )}
        </>
      )}

      {editingKid && (
        <KidSheet
          kid={editingKid === 'new' ? null : editingKid}
          onClose={() => setEditingKid(null)}
          onSaved={async () => {
            setEditingKid(null);
            await Promise.all([reload(), report.reload()]);
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

const COLORS = ['#e08a2c', '#3b82c4', '#8a5cd6', '#2e9e6b', '#d0457b', '#c2a12b'];

function KidSheet({ kid, onClose, onSaved }: { kid: Kid | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { toast, me } = useApp();
  const [name, setName] = useState(kid?.name ?? '');
  const [color, setColor] = useState(kid?.color ?? COLORS[me.kids.length % COLORS.length] ?? '#e08a2c');
  const [birthDate, setBirthDate] = useState(kid?.birthDate ?? '');

  async function save(archive = false) {
    try {
      if (kid) await patch(`/kids/${kid.id}`, archive ? { archived: true } : { name, color, birthDate: birthDate || null });
      else await post('/kids', { name, color, birthDate: birthDate || null });
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title={kid ? kid.name : 'Add a kid'}>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Birthday (optional)">
        <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
      </Field>
      <Field label="Color">
        <div className="swatches">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              onClick={() => setColor(c)}
              aria-pressed={color === c}
              className={`swatch ${color === c ? 'selected' : ''}`}
              style={{ background: c }}
            />
          ))}
        </div>
      </Field>
      <div className="cluster">
        <Button variant="primary" onClick={() => void save()} disabled={!name.trim()}>
          Save
        </Button>
        {kid && (
          <Button variant="danger" onClick={() => void save(true)}>
            Archive
          </Button>
        )}
      </div>
    </Sheet>
  );
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
