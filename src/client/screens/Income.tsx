import { useState } from 'react';
import type { PaycheckSuggestion } from '../../shared/paycheckFinder';
import type { PayFrequency } from '../../shared/paySchedule';
import { api, del, errorMessage, patch, post } from '../api';
import { money, shortDate } from '../format';
import { useApp, useLoad } from '../state';
import { AmountInput, Button, Card, Empty, ErrorNote, Field, Loading, Sheet, Toggle } from '../ui';
import { SubHeader } from './More';

interface IncomeSource {
  id: number;
  memberId: number | null;
  name: string;
  netPayCents: number;
  frequency: PayFrequency;
  anchorDate: string;
  semimonthlyDays: [number, number] | null;
  matchText: string | null;
  accountId: number | null;
  drivesAllowance: boolean;
  active: boolean;
  nextPayDates: string[];
}

const FREQUENCIES: { value: PayFrequency; label: string }[] = [
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'semimonthly', label: 'Twice a month' },
  { value: 'monthly', label: 'Once a month' },
];

type Draft = Omit<IncomeSource, 'id' | 'nextPayDates'>;

const titleCase = (text: string) => text.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());

export function Income() {
  const { me, accounts, toast } = useApp();
  const sources = useLoad(() => api<IncomeSource[]>('/income-sources'), []);
  const [editing, setEditing] = useState<IncomeSource | Draft | 'new' | null>(null);
  const [found, setFound] = useState<PaycheckSuggestion[] | null>(null);
  const [finding, setFinding] = useState(false);

  async function findPaychecks() {
    setFinding(true);
    try {
      const suggestions = await api<PaycheckSuggestion[]>('/income-sources/suggestions');
      setFound(suggestions);
      if (!suggestions.length) toast('No regular paychecks found in the last 9 months of deposits.');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setFinding(false);
    }
  }

  function pickSuggestion(s: PaycheckSuggestion) {
    setEditing({
      memberId: me.viewer.memberId,
      name: titleCase(s.merchant),
      netPayCents: s.netPayCents,
      frequency: s.frequency,
      anchorDate: s.anchorDate,
      semimonthlyDays: s.semimonthlyDays,
      matchText: s.matchText,
      accountId: s.accountId,
      drivesAllowance: true,
      active: true,
    });
  }

  return (
    <div className="stack">
      <SubHeader title="Income & paydays" subtitle="Take-home pay that lands in your accounts. The weekly plan is built around these." />
      {sources.error && <ErrorNote message={sources.error} onRetry={() => void sources.reload()} />}
      {!sources.data ? (
        !sources.error && <Loading />
      ) : sources.data.length === 0 ? (
        <Empty title="Add your paycheck">Starting a new job later? Add it here and the whole plan adjusts.</Empty>
      ) : (
        <div className="list">
          {sources.data.map((s) => (
            <button key={s.id} type="button" className="row row-button" onClick={() => setEditing(s)}>
              <div className="row-main">
                <div className="row-title">
                  {s.name}
                  {!s.active && ' (paused)'}
                </div>
                <div className="row-sub">
                  {me.members.find((m) => m.id === s.memberId)?.name ?? 'Household'} · {FREQUENCIES.find((f) => f.value === s.frequency)?.label.toLowerCase()}
                  {s.nextPayDates.length > 0 && ` · next ${s.nextPayDates.map(shortDate).join(', ')}`}
                </div>
              </div>
              <strong>{money(s.netPayCents, { whole: true })}</strong>
            </button>
          ))}
        </div>
      )}
      {found && found.length > 0 && (
        <Card>
          <h2>Found in your deposits</h2>
          <p className="muted small">Check the details, choose whose paycheck it is, then save. Saved income is visible to both of you.</p>
          <div className="list">
            {found.map((s) => (
              <div key={`${s.merchant}-${s.netPayCents}`} className="row">
                <div className="row-main">
                  <div className="row-title">
                    {titleCase(s.merchant)} · {money(s.netPayCents)}
                  </div>
                  <div className="row-sub">
                    {FREQUENCIES.find((f) => f.value === s.frequency)?.label.toLowerCase()}
                    {s.nextDate && ` · next ${shortDate(s.nextDate)}`} · {s.deposits} deposits since {shortDate(s.firstDate)}
                    {s.accountId && ` · into ${accounts.find((a) => a.id === s.accountId)?.name ?? 'one account'}`}
                  </div>
                </div>
                <Button small onClick={() => pickSuggestion(s)}>
                  Add
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}
      <div className="cluster">
        <Button variant="primary" onClick={() => setEditing('new')}>
          Add income
        </Button>
        <Button onClick={() => void findPaychecks()} disabled={finding}>
          {finding ? 'Looking…' : 'Find my paychecks'}
        </Button>
      </div>
      {editing && (
        <SourceSheet
          source={editing === 'new' || !('id' in editing) ? null : editing}
          draft={editing !== 'new' && !('id' in editing) ? editing : undefined}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            const added = editing !== 'new' && !('id' in editing) ? editing : null;
            setEditing(null);
            if (added) setFound((list) => list?.filter((s) => s.matchText !== added.matchText || s.netPayCents !== added.netPayCents) ?? null);
            await sources.reload();
          }}
        />
      )}
    </div>
  );
}

function SourceSheet({
  source,
  draft,
  onClose,
  onSaved,
}: {
  source: IncomeSource | null;
  /** Prefilled from "Find my paychecks". */
  draft?: Draft;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { me, accounts, toast, reload } = useApp();
  const start = source ?? draft;
  const [name, setName] = useState(start?.name ?? 'Paycheck');
  const [memberId, setMemberId] = useState<number | null>(start ? start.memberId : me.viewer.memberId);
  const [netPay, setNetPay] = useState<number | null>(start?.netPayCents ?? null);
  const [frequency, setFrequency] = useState<PayFrequency>(start?.frequency ?? 'weekly');
  const [anchorDate, setAnchorDate] = useState(start?.anchorDate ?? me.today);
  const [days, setDays] = useState<[number, number]>(start?.semimonthlyDays ?? [15, 31]);
  const [matchText, setMatchText] = useState(start?.matchText ?? '');
  const [accountId, setAccountId] = useState<number | null>(start?.accountId ?? null);
  const [drivesAllowance, setDrivesAllowance] = useState(start?.drivesAllowance ?? true);
  const [active, setActive] = useState(source?.active ?? true);

  async function save() {
    try {
      const body = {
        name,
        memberId,
        netPayCents: netPay ?? 0,
        frequency,
        anchorDate,
        semimonthlyDays: frequency === 'semimonthly' ? days : undefined,
        matchText: matchText || null,
        accountId,
        drivesAllowance,
        active,
      };
      if (source) await patch(`/income-sources/${source.id}`, body);
      else await post('/income-sources', body);
      await reload();
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function remove() {
    if (!source || !window.confirm(`Delete ${source.name}?`)) return;
    try {
      await del(`/income-sources/${source.id}`);
      await reload();
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title={source ? source.name : 'Add income'}>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid-2">
        <Field label="Whose">
          <select value={memberId ?? ''} onChange={(e) => setMemberId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Household</option>
            {me.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Take-home per paycheck">
          <AmountInput cents={netPay} onChange={setNetPay} />
        </Field>
      </div>
      <Field label="How often">
        <select value={frequency} onChange={(e) => setFrequency(e.target.value as PayFrequency)}>
          {FREQUENCIES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </Field>
      {frequency === 'semimonthly' ? (
        <div className="grid-2">
          <Field label="First payday">
            <input type="number" min={1} max={31} value={days[0]} onChange={(e) => setDays([Number(e.target.value) || 1, days[1]])} />
          </Field>
          <Field label="Second payday" hint="31 means the last day">
            <input type="number" min={1} max={31} value={days[1]} onChange={(e) => setDays([days[0], Number(e.target.value) || 31])} />
          </Field>
        </div>
      ) : (
        <Field label="A recent payday" hint="Any real payday. The rest are worked out from it; weekends move to Friday.">
          <input type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} />
        </Field>
      )}
      <Field label="Words in the deposit description" hint="e.g. ACME PAYROLL. Lets the app recognize the paycheck, even when Chime pays early.">
        <input value={matchText} onChange={(e) => setMatchText(e.target.value)} />
      </Field>
      <Field label="Lands in">
        <select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Any account</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Toggle checked={drivesAllowance} onChange={setDrivesAllowance} label="Fun money tops up on these paydays" />
      {source && <Toggle checked={active} onChange={setActive} label="Active" hint="Pause it without deleting history." />}
      <div className="cluster">
        <Button variant="primary" onClick={() => void save()} disabled={!name || netPay === null}>
          Save
        </Button>
        {source && (
          <Button variant="danger" onClick={() => void remove()}>
            Delete
          </Button>
        )}
      </div>
    </Sheet>
  );
}
