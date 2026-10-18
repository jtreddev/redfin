import { useState } from 'react';
import { WithAmounts } from '../amounts';
import { api, del, errorMessage, patch, post } from '../api';
import {
  balanceText,
  changedFields,
  comingUpText,
  monthlyText,
  spentText,
  suggestionFor,
  totalLine,
  type PlannedCost,
  type PlannedCostsResponse,
} from '../plannedCosts';
import { useApp, useLoad } from '../state';
import { AmountInput, Button, Card, Empty, ErrorNote, Field, Loading, Sheet } from '../ui';

/** Plan › Goals, top section: planned costs (sinking funds). */
export function PlannedCostsSection() {
  const list = useLoad(() => api<PlannedCostsResponse>('/planned-costs'), []);
  const [editing, setEditing] = useState<PlannedCost | 'new' | null>(null);

  let body;
  if (list.error && !list.data) body = <ErrorNote message={list.error} onRetry={() => void list.reload()} />;
  else if (!list.data) body = <Loading />;
  else {
    const { costs, totalMonthlyCents } = list.data;
    body = (
      <>
        {costs.length === 0 ? (
          <Empty title="Nothing set aside yet">
            Add the costs that always come up, like car repairs or the dentist, and turn them into a steady monthly amount.
          </Empty>
        ) : (
          <>
            <p className="setaside-total"><WithAmounts text={totalLine(totalMonthlyCents, costs.length)} /></p>
            {costs.map((cost) => (
              <CostCard key={cost.id} cost={cost} onOpen={() => setEditing(cost)} />
            ))}
          </>
        )}
        <Button onClick={() => setEditing('new')}>Add a planned cost</Button>
        <p className="muted small">Tracking only: the money stays in your savings account, and nothing moves by itself.</p>
      </>
    );
  }

  return (
    <section id="set-aside" className="stack" aria-labelledby="setaside-title">
      <div className="section-title">
        <h3 id="setaside-title">Set aside each month</h3>
      </div>
      {body}
      {editing && list.data && (
        <CostSheet
          cost={editing === 'new' ? null : editing}
          data={list.data}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await list.reload();
          }}
        />
      )}
    </section>
  );
}

function ShortIcon() {
  return (
    <svg className="setaside-icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M10 2.5 18.5 17.5H1.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M10 8v4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="10" cy="14.8" r="1.1" fill="currentColor" />
    </svg>
  );
}

function CostCard({ cost, onOpen }: { cost: PlannedCost; onOpen: () => void }) {
  const balance = balanceText(cost.balanceCents);
  return (
    <Card className="setaside-card" onClick={onOpen}>
      <span className="setaside-top">
        <strong className="setaside-name">{cost.name}</strong>
        <span className="muted small"><WithAmounts text={monthlyText(cost.monthlyCents)} /></span>
      </span>
      <span className={`setaside-balance money ${balance.short ? 'tone-warn' : ''}`}>
        {balance.short && <ShortIcon />}
        <WithAmounts text={balance.text} />
      </span>
      <span className="setaside-line muted small">
        {cost.categoryIds.length ? <WithAmounts text={spentText(cost.spent12Cents)} /> : 'No categories yet: tap to pick what it pays for'}
      </span>
      {cost.comingUp.map((item) => (
        <span key={item.kind === 'bill' ? `${item.name}-${item.date}` : item.month} className="setaside-line small">
          <span className="muted">Coming up: </span>
          <WithAmounts text={comingUpText(item)} />
        </span>
      ))}
    </Card>
  );
}

function CostSheet({
  cost,
  data,
  onClose,
  onSaved,
}: {
  cost: PlannedCost | null;
  data: PlannedCostsResponse;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { toast, categories: allCategories } = useApp();
  const [name, setName] = useState(cost?.name ?? '');
  const [monthly, setMonthly] = useState<number | null>(cost ? cost.monthlyCents : null);
  const [start, setStart] = useState<number | null>(cost ? cost.startBalanceCents : 0);
  const [categoryIds, setCategoryIds] = useState<number[]>(cost ? [...cost.categoryIds] : []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const suggestion = suggestionFor({ cost, categoryIds, categories: data.categories, months: data.suggestionMonths });
  const costNames = new Map(data.costs.map((c) => [c.id, c.name]));
  const sections = [...new Set(data.categories.map((c) => c.section))];
  // Linked categories the list no longer offers (archived since): kept, so saving doesn't drop them.
  const hidden = categoryIds.filter((id) => !data.categories.some((c) => c.id === id));

  const toggle = (id: number, on: boolean) => setCategoryIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    // The write is done: never re-enable Save here (a second tap on Add would add it twice).
    toast(done);
    try {
      await onSaved();
    } catch (e) {
      onClose();
      toast(`Saved, but the list didn’t refresh: ${errorMessage(e)}`, 'error');
    }
  }

  function save() {
    const draft = { name, monthlyCents: monthly, startBalanceCents: start, categoryIds };
    if (!cost) {
      void run(() => post('/planned-costs', { name: name.trim(), monthlyCents: monthly ?? 0, startBalanceCents: start ?? 0, categoryIds }), 'Added');
      return;
    }
    const changes = changedFields(cost, draft);
    if (!Object.keys(changes).length) {
      onClose();
      return;
    }
    void run(() => patch(`/planned-costs/${cost.id}`, changes), 'Saved');
  }

  function remove() {
    if (!cost || !window.confirm(`Delete “${cost.name}”? Its balance goes away; your transactions stay as they are.`)) return;
    void run(() => del(`/planned-costs/${cost.id}`), 'Deleted');
  }

  return (
    <Sheet open onClose={onClose} title={cost ? cost.name : 'Add a planned cost'}>
      <Field label="Name">
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Car" />
      </Field>

      <div className="stack-sm">
        <Field label="Set aside each month">
          <AmountInput cents={monthly} onChange={setMonthly} />
        </Field>
        {suggestion ? (
          <div className="setaside-suggest">
            <span className="small"><WithAmounts text={suggestion.text} /></span>
            {suggestion.cents === null ? null : suggestion.cents !== monthly ? (
              <Button variant="ghost" onClick={() => setMonthly(suggestion.cents)}>
                Use suggestion
              </Button>
            ) : (
              <span className="muted small">That’s the amount above.</span>
            )}
          </div>
        ) : (
          <span className="field-hint">
            {categoryIds.length ? 'A suggestion shows up after 3 months of history.' : 'Pick what it pays for to see a suggestion.'}
          </span>
        )}
      </div>

      <fieldset className="setaside-cats">
        <legend className="field-label">Pays for</legend>
        {sections.map((section) => (
          <div key={section} className="setaside-group" role="group" aria-label={section}>
            <div className="setaside-group-name small">{section}</div>
            {data.categories
              .filter((c) => c.section === section)
              .map((c) => {
                const owner = c.plannedCostId !== null && c.plannedCostId !== cost?.id ? costNames.get(c.plannedCostId) ?? 'another cost' : null;
                return (
                  <label key={c.id} className={`setaside-option ${owner ? 'is-taken' : ''}`}>
                    <input
                      type="checkbox"
                      checked={categoryIds.includes(c.id)}
                      disabled={owner !== null}
                      onChange={(e) => toggle(c.id, e.target.checked)}
                    />
                    <span className="setaside-option-name">{c.name}</span>
                    {owner && <span className="muted small">in {owner}</span>}
                  </label>
                );
              })}
          </div>
        ))}
        {hidden.length > 0 && (
          <div className="setaside-group" role="group" aria-label="No longer in use">
            <div className="setaside-group-name small">No longer in use</div>
            {hidden.map((id) => (
              <label key={id} className="setaside-option">
                <input type="checkbox" checked onChange={(e) => toggle(id, e.target.checked)} />
                <span className="setaside-option-name">{allCategories.find((c) => c.id === id)?.name ?? 'Archived category'}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <Field label="Starting balance" hint="What’s already set aside for this, before the app started tracking.">
        <AmountInput cents={start} onChange={setStart} />
      </Field>

      {error && (
        <div className="banner banner-bad" role="alert">
          <span>{error}</span>
        </div>
      )}

      <div className="cluster">
        <Button variant="primary" onClick={save} disabled={busy || !name.trim() || monthly === null}>
          {cost ? 'Save' : 'Add'}
        </Button>
        {cost && (
          <Button variant="danger" onClick={remove} disabled={busy}>
            Delete
          </Button>
        )}
      </div>
    </Sheet>
  );
}
