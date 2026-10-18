import { useState } from 'react';
import { api, errorMessage, patch, post } from '../api';
import { shortDate } from '../format';
import { useApp, useLoad } from '../state';
import type { FunBalance } from '../types';
import { AmountInput, Button, Card, ErrorNote, Field, Loading, Money, Sheet } from '../ui';
import { SubHeader } from './More';

interface FunResponse {
  startDate: string;
  balances: FunBalance[];
  recent: { id: number; date: string; name: string; amountCents: number }[];
}

export function Fun() {
  const { me, accounts, toast, reload } = useApp();
  const fun = useLoad(() => api<FunResponse>('/fun'), []);
  const [editing, setEditing] = useState<FunBalance | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const viewerMember = me.members.find((m) => m.id === me.viewer.memberId);

  async function setPersonalCard(accountId: number | null) {
    try {
      await patch(`/members/${me.viewer.memberId}`, { defaultPrivateAccountId: accountId });
      await reload();
      toast(accountId ? 'New purchases on that card will count as your fun money' : 'Personal card cleared');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <div className="stack">
      <SubHeader title="Fun money" subtitle="A set amount each of you spends however you like. No explaining, no judging." />
      {fun.error && <ErrorNote message={fun.error} onRetry={() => void fun.reload()} />}
      {!fun.data ? (
        !fun.error && <Loading />
      ) : (
        <>
          {fun.data.balances.map((b) => (
            <Card key={b.memberId}>
              <div className="spread">
                <div className="figure">
                  <Money cents={b.balanceCents} whole className="big" tone={b.balanceCents < 0 ? 'bad' : undefined} />
                  <div className="label">{b.isViewer ? 'yours' : `${b.name}’s`}</div>
                  <div className="muted small"><Money cents={b.allowancePerPaydayCents ?? me.members.find((m) => m.id === b.memberId)?.funAllowanceCents ?? 0} whole /> every payday</div>
                </div>
                <Button small onClick={() => setEditing(b)}>
                  Change
                </Button>
              </div>
              {b.isViewer && b.accruedCents !== undefined && (
                <p className="muted small">
                  Since {shortDate(fun.data!.startDate)}: <Money cents={b.accruedCents} whole /> added, <Money cents={b.spentCents ?? 0} whole /> spent.
                  {b.nextPayDate && ` Next top-up ${shortDate(b.nextPayDate)}.`}
                </p>
              )}
            </Card>
          ))}

          <Card>
            <h2>My personal card</h2>
            <p className="muted small">Pick an account only you use, and its purchases file as your fun money automatically.</p>
            <select value={viewerMember?.defaultPrivateAccountId ?? ''} onChange={(e) => void setPersonalCard(e.target.value ? Number(e.target.value) : null)}>
              <option value="">None</option>
              {accounts
                .filter((a) => !a.hidden)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.mask ? ` ••${a.mask}` : ''}
                  </option>
                ))}
            </select>
          </Card>

          <div className="section-title">
            <h3>My recent fun purchases</h3>
            <Button small variant="ghost" onClick={() => setAdjusting(true)}>
              Adjust balance
            </Button>
          </div>
          {fun.data.recent.length === 0 ? (
            <p className="muted small">
              Nothing yet. Open a purchase in Activity and turn on “My fun money”. Only you will ever see these.
            </p>
          ) : (
            <div className="list">
              {fun.data.recent.map((r) => (
                <div key={r.id} className="row">
                  <div className="row-main">
                    <div className="row-title">{r.name}</div>
                    <div className="row-sub">{shortDate(r.date)}</div>
                  </div>
                  <Money cents={r.amountCents} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {editing && (
        <AllowanceSheet
          balance={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await Promise.all([reload(), fun.reload()]);
          }}
        />
      )}
      {adjusting && (
        <AdjustSheet
          onClose={() => setAdjusting(false)}
          onSaved={async () => {
            setAdjusting(false);
            await fun.reload();
          }}
        />
      )}
    </div>
  );
}

function AllowanceSheet({ balance, onClose, onSaved }: { balance: FunBalance; onClose: () => void; onSaved: () => Promise<void> }) {
  const { me, toast } = useApp();
  const member = me.members.find((m) => m.id === balance.memberId);
  const [cents, setCents] = useState<number | null>(member?.funAllowanceCents ?? 0);

  async function save() {
    try {
      await patch(`/members/${balance.memberId}`, { funAllowanceCents: cents ?? 0 });
      toast('Allowance updated');
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title={`${balance.isViewer ? 'Your' : `${balance.name}’s`} allowance`}>
      <p className="muted">
        Decide this together, and make it the same for both of you whether or not you both earn. It’s added every payday and
        unspent money carries over.
      </p>
      <Field label="Per payday">
        <AmountInput cents={cents} onChange={setCents} autoFocus />
      </Field>
      <Button variant="primary" onClick={() => void save()}>
        Save
      </Button>
    </Sheet>
  );
}

function AdjustSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const { toast } = useApp();
  const [cents, setCents] = useState<number | null>(null);
  const [note, setNote] = useState('');

  async function save() {
    if (!cents) return;
    try {
      await post('/fun/adjustments', { amountCents: cents, note });
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title="Adjust my fun money">
      <p className="muted small">Birthday cash, a bonus you agreed to split, or a correction. Use a minus sign to take some away.</p>
      <Field label="Amount">
        <AmountInput cents={cents} onChange={setCents} allowNegative autoFocus />
      </Field>
      <Field label="Note">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Button variant="primary" onClick={() => void save()} disabled={!cents}>
        Save
      </Button>
    </Sheet>
  );
}
