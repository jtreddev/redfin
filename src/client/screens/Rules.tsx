import { useEffect, useState } from 'react';
import { api, del, errorMessage, patch, post } from '../api';
import { ruleRangeLabel } from '../../shared/rules';
import { money, plural, shortDate } from '../format';
import { useApp, useLoad } from '../state';
import { Button, CategorySelect, Empty, ErrorNote, Field, KidSelect, Loading, Segmented, Sheet, Toggle } from '../ui';
import { SubHeader } from './More';

interface RuleItem {
  id: number;
  position: number;
  matchField: 'name' | 'merchant' | 'any';
  matchText: string;
  accountId: number | null;
  accountName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  kidId: number | null;
  kidName: string | null;
  isPrivate: boolean;
  ignore: boolean;
  /** Made by the app when someone fixed a charge's category. */
  learned: boolean;
  amountMinCents: number | null;
  amountMaxCents: number | null;
}

export function Rules() {
  const { toast } = useApp();
  const rules = useLoad(() => api<RuleItem[]>('/rules'), []);
  const [editing, setEditing] = useState<RuleItem | 'new' | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

  async function move(index: number, delta: number) {
    const list = [...(rules.data ?? [])];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const [item] = list.splice(index, 1);
    if (item) list.splice(target, 0, item);
    try {
      await post('/rules/reorder', { ids: list.map((r) => r.id) });
      await rules.reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function reapply() {
    setApplying('Working…');
    let afterId = 0;
    let updated = 0;
    try {
      for (let i = 0; i < 500; i++) {
        const res = await post<{ updated: number; afterId: number | null; done: boolean }>('/rules/apply', { afterId });
        updated += res.updated;
        setApplying(`Working… ${plural(updated, 'change')}`);
        if (res.done || res.afterId === null) break;
        afterId = res.afterId;
      }
      toast(`Rules re-applied: ${plural(updated, 'transaction')} changed`);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setApplying(null);
    }
  }

  return (
    <div className="stack">
      <SubHeader
        title="Rules"
        subtitle="Checked top to bottom; the first match wins. Anything you set by hand is never changed."
        action={<Button small onClick={() => setEditing('new')}>Add</Button>}
      />
      {rules.error && <ErrorNote message={rules.error} onRetry={() => void rules.reload()} />}
      {!rules.data ? (
        !rules.error && <Loading />
      ) : rules.data.length === 0 ? (
        <Empty title="No rules yet">When you fix a charge’s category, the app learns a rule for next time.</Empty>
      ) : (
        <div className="list">
          {rules.data.map((rule, i) => (
            <div key={rule.id} className="row">
              <button type="button" className="row-main row-button" style={{ border: 'none', background: 'none', padding: 0, textAlign: 'left', color: 'inherit', font: 'inherit' }} onClick={() => setEditing(rule)}>
                <div className="row-title">
                  “{rule.matchText}”
                  {[ruleRangeLabel(rule.amountMinCents, rule.amountMaxCents)].filter(Boolean).map((range) => ` · ${range}`)}
                </div>
                <div className="row-sub">
                  →{' '}
                  {[
                    rule.ignore && 'leave out',
                    rule.categoryName,
                    rule.kidName && `kid: ${rule.kidName}`,
                    rule.isPrivate && 'my fun money',
                    rule.accountName && `only ${rule.accountName}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <div className="row-sub muted small">{rule.learned ? 'Learned from your fix' : 'You made this'}</div>
              </button>
              <div className="cluster" style={{ flexWrap: 'nowrap' }}>
                <button type="button" className="icon-btn" aria-label="Move up" onClick={() => void move(i, -1)} disabled={i === 0}>
                  ↑
                </button>
                <button type="button" className="icon-btn" aria-label="Move down" onClick={() => void move(i, 1)} disabled={i === (rules.data?.length ?? 0) - 1}>
                  ↓
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Button onClick={() => void reapply()} disabled={Boolean(applying)}>
        {applying ?? 'Re-apply rules to past transactions'}
      </Button>
      {editing && (
        <RuleSheet
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await rules.reload();
          }}
        />
      )}
    </div>
  );
}

function RuleSheet({ rule, onClose, onSaved }: { rule: RuleItem | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { accounts, toast } = useApp();
  const [matchText, setMatchText] = useState(rule?.matchText ?? '');
  const [matchField, setMatchField] = useState<RuleItem['matchField']>(rule?.matchField ?? 'any');
  const [categoryId, setCategoryId] = useState<number | null>(rule?.categoryId ?? null);
  const [kidId, setKidId] = useState<number | null>(rule?.kidId ?? null);
  const [accountId, setAccountId] = useState<number | null>(rule?.accountId ?? null);
  const [ignore, setIgnore] = useState(rule?.ignore ?? false);
  const [isPrivate, setPrivate] = useState(rule?.isPrivate ?? false);
  const [preview, setPreview] = useState<{ count: number; examples: { id: number; date: string; name: string; amountCents: number }[] } | null>(null);

  useEffect(() => {
    if (matchText.trim().length < 2) {
      setPreview(null);
      return;
    }
    const timer = window.setTimeout(() => {
      post<typeof preview>('/rules/preview', { matchText, matchField, accountId })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [matchText, matchField, accountId]);

  async function save() {
    try {
      if (rule) {
        const res = await patch<{ updated: number }>(`/rules/${rule.id}`, { matchText, matchField, categoryId, kidId, accountId, ignore });
        toast(`Saved · ${plural(res.updated, 'transaction')} updated`);
      } else {
        const res = await post<{ updated: number }>('/rules', { matchText, matchField, categoryId, kidId, accountId, ignore, isPrivate });
        toast(`Rule added · ${plural(res.updated, 'transaction')} updated`);
      }
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function remove() {
    if (!rule) return;
    try {
      await del(`/rules/${rule.id}`);
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title={rule ? 'Edit rule' : 'New rule'}>
      <Field label="When the description contains">
        <input value={matchText} onChange={(e) => setMatchText(e.target.value)} placeholder="KROGER" autoFocus />
      </Field>
      <Segmented
        value={matchField}
        onChange={setMatchField}
        options={[
          { value: 'any', label: 'Anywhere' },
          { value: 'name', label: 'Bank text' },
          { value: 'merchant', label: 'Merchant' },
        ]}
      />
      {preview && (
        <div className="banner">
          <div className="stack-sm small">
            <strong>Matches {plural(preview.count, 'transaction')}</strong>
            {preview.examples.map((ex) => (
              <span key={ex.id} className="muted">
                {shortDate(ex.date)} · {ex.name} · {money(ex.amountCents)}
              </span>
            ))}
          </div>
        </div>
      )}
      <Toggle checked={ignore} onChange={setIgnore} label="Leave these out of the budget" hint="For things like Fidelity core-fund sweeps." />
      {!ignore && !isPrivate && (
        <Field label="File under">
          <CategorySelect value={categoryId} onChange={setCategoryId} noneLabel="Don’t change category" />
        </Field>
      )}
      <Field label="Tag a kid">
        <KidSelect value={kidId} onChange={setKidId} />
      </Field>
      <Field label="Only for account">
        <select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Any account</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      {!rule && <Toggle checked={isPrivate} onChange={setPrivate} label="My fun money (private rule)" hint="Only you see this rule and what it matches." />}
      <div className="cluster">
        <Button variant="primary" onClick={() => void save()} disabled={matchText.trim().length < 2}>
          Save
        </Button>
        {rule && (
          <Button variant="danger" onClick={() => void remove()}>
            Delete
          </Button>
        )}
      </div>
    </Sheet>
  );
}
