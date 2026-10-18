import { useState } from 'react';
import { formatCents } from '../../shared/money';
import { errorMessage, patch } from '../api';
import { go } from '../router';
import { recategorizeAll } from '../sync';
import { useApp } from '../state';
import type { Member } from '../types';
import { AmountInput, Button, Card, Field, Sheet, Toggle } from '../ui';
import { AccountCard, SubHeader } from './More';

const US_TIME_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
];

export function Settings() {
  const { me, toast, reload } = useApp();
  const [name, setName] = useState(me.household.name);
  const [timezone, setTimezone] = useState(me.household.timezone);
  const [low, setLow] = useState<number | null>(me.household.lowBalanceCents);
  const [cutoff, setCutoff] = useState<number | null>(me.household.habitCutoffCents);
  const [recategorizing, setRecategorizing] = useState<number | null>(null);
  const [funStart, setFunStart] = useState(me.household.funMoneyStartDate ?? '');
  const [editingMember, setEditingMember] = useState<Member | null>(null);

  async function save() {
    if (cutoff === null) {
      // An empty cutoff would file every gas-station charge as Gas: keep the saved one instead.
      setCutoff(me.household.habitCutoffCents);
      toast('Enter a gas-station cutoff amount', 'error');
      return;
    }
    try {
      await patch('/household', { name, timezone, lowBalanceCents: low ?? 0, habitCutoffCents: cutoff, funMoneyStartDate: funStart || null });
      await reload();
      toast('Saved');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function savePrefs(body: { hideSetup?: boolean; powerTools?: boolean }, done: string) {
    try {
      await patch('/me/prefs', body);
      await reload();
      toast(done);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function recategorize() {
    setRecategorizing(0);
    try {
      const changed = await recategorizeAll(setRecategorizing);
      await reload();
      toast(changed === 1 ? '1 charge recategorized' : `${changed} charges recategorized`);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setRecategorizing(null);
    }
  }

  const cutoffShown = cutoff ?? me.household.habitCutoffCents;
  const zones = US_TIME_ZONES.includes(timezone) ? US_TIME_ZONES : [timezone, ...US_TIME_ZONES];
  return (
    <div className="stack">
      <SubHeader title="Settings" />
      <Card>
        <h2>Household</h2>
        <div className="stack-sm">
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Time zone">
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Low-balance cushion" hint="Weeks projected to end below this turn amber.">
            <AmountInput cents={low} onChange={setLow} />
          </Field>
          <Field label="Fun money counts from" hint="Allowances build up from this date.">
            <input type="date" value={funStart} onChange={(e) => setFunStart(e.target.value)} />
          </Field>
          <Field
            label={`Small gas-station charges count as Habits under ${formatCents(cutoffShown, { whole: cutoffShown % 100 === 0 })}`}
            hint="Bigger fill-ups are Gas. Save, then recategorize to apply it to past charges.">
            <AmountInput cents={cutoff} onChange={setCutoff} />
          </Field>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
          <Button disabled={recategorizing !== null} onClick={() => void recategorize()}>
            {recategorizing === null ? 'Recategorize everything' : `Recategorizing… ${recategorizing} changed`}
          </Button>
        </div>
      </Card>

      <Card>
        <h2>People</h2>
        <div className="stack-sm">
          {me.members.map((m) => (
            <div key={m.id} className="spread">
              <div className="cluster">
                <span className="avatar" style={{ background: m.color }}>
                  {m.name.slice(0, 1)}
                </span>
                <div>
                  <div>
                    {m.name}
                    {m.id === me.viewer.memberId && ' (you)'}
                  </div>
                  <div className="muted small">{m.email}</div>
                </div>
              </div>
              <Button small variant="ghost" onClick={() => setEditingMember(m)}>
                Edit
              </Button>
            </div>
          ))}
        </div>
        {me.members.length < 2 && (
          <p className="muted small">
            To add your partner: add their email to the Cloudflare Access policy (see SETUP.md). They show up here the first time they
            open the app.
          </p>
        )}
      </Card>

      <Card>
        <h2>Just for you</h2>
        <p className="muted small">Each of you decides these for yourself.</p>
        <div className="stack-sm">
          <Toggle
            checked={!me.viewer.hideSetup}
            onChange={(v) => void savePrefs({ hideSetup: !v }, v ? 'The setup checklist is back on Home' : 'Setup checklist hidden')}
            label="Show the setup checklist"
            hint="The “Getting set up” steps on Home. It also goes away once every step is done."
          />
          <Toggle
            checked={me.viewer.powerTools}
            onChange={(v) => void savePrefs({ powerTools: v }, v ? 'More tools are on' : 'More tools are off')}
            label="Show more tools"
            hint="Keyboard shortcuts, saved searches and Download CSV in Activity, and rule previews. Off keeps things simple."
          />
        </div>
      </Card>

      <Card>
        <h2>Organize</h2>
        <div className="cluster">
          <Button onClick={() => go('more/categories')}>Categories</Button>
          <Button onClick={() => go('more/kids')}>Kids</Button>
          <Button onClick={() => go('more/rules')}>Rules</Button>
        </div>
      </Card>

      <AccountCard />

      {editingMember && <MemberSheet member={editingMember} onClose={() => setEditingMember(null)} />}
    </div>
  );
}

const COLORS = ['#3b6fd8', '#c2467a', '#2e9e6b', '#8a5cd6', '#d27a1f', '#4a5560'];

function MemberSheet({ member, onClose }: { member: Member; onClose: () => void }) {
  const { toast, reload } = useApp();
  const [name, setName] = useState(member.name);
  const [color, setColor] = useState(member.color);

  async function save() {
    try {
      await patch(`/members/${member.id}`, { name, color });
      await reload();
      onClose();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title={member.name}>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
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
      <Button variant="primary" onClick={() => void save()} disabled={!name.trim()}>
        Save
      </Button>
    </Sheet>
  );
}
