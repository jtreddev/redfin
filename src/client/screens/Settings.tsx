import { useState } from 'react';
import { errorMessage, patch, post } from '../api';
import { go } from '../router';
import { useApp } from '../state';
import type { Member } from '../types';
import { AmountInput, Button, Card, Field, Sheet, Toggle } from '../ui';
import { SubHeader } from './More';

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
  const [funStart, setFunStart] = useState(me.household.funMoneyStartDate ?? '');
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  async function save() {
    try {
      await patch('/household', { name, timezone, lowBalanceCents: low ?? 0, funMoneyStartDate: funStart || null });
      await reload();
      toast('Saved');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

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
          <Button variant="primary" onClick={() => void save()}>
            Save
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
        <h2>Organize</h2>
        <div className="cluster">
          <Button onClick={() => setCategoriesOpen(true)}>Categories</Button>
          <Button onClick={() => go('more/kids')}>Kids</Button>
          <Button onClick={() => go('more/rules')}>Rules</Button>
        </div>
      </Card>

      {editingMember && <MemberSheet member={editingMember} onClose={() => setEditingMember(null)} />}
      {categoriesOpen && <CategoriesSheet onClose={() => setCategoriesOpen(false)} />}
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
        <div className="cluster">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              className="avatar"
              onClick={() => setColor(c)}
              style={{ background: c, border: color === c ? '3px solid var(--text)' : 'none', cursor: 'pointer' }}
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

function CategoriesSheet({ onClose }: { onClose: () => void }) {
  const { categories, sections, toast, reload } = useApp();
  const [newName, setNewName] = useState<Record<number, string>>({});
  const [kidScoped, setKidScoped] = useState<Record<number, boolean>>({});

  async function add(sectionId: number) {
    const name = newName[sectionId]?.trim();
    if (!name) return;
    const section = sections.find((s) => s.id === sectionId);
    const kind = section?.name === 'Income' ? 'income' : section?.name === 'Savings & Goals' ? 'savings' : section?.name === 'Debt Payments' ? 'debt' : section?.name === 'Transfers' ? 'transfer' : 'expense';
    try {
      await post('/categories', { sectionId, name, kind, kidScoped: Boolean(kidScoped[sectionId]) || section?.name === 'Kids' });
      setNewName((v) => ({ ...v, [sectionId]: '' }));
      await reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function toggleArchived(id: number, archived: boolean) {
    try {
      await patch(`/categories/${id}`, { archived });
      await reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title="Categories">
      {sections
        .filter((s) => s.name !== 'Fun Money')
        .map((section) => (
          <div key={section.id} className="stack-sm">
            <h3>{section.name}</h3>
            {categories
              .filter((c) => c.sectionId === section.id)
              .map((c) => (
                <Toggle key={c.id} checked={!c.archived} onChange={(on) => void toggleArchived(c.id, !on)} label={c.name} />
              ))}
            <div className="cluster" style={{ flexWrap: 'nowrap' }}>
              <input
                placeholder={`New ${section.name.toLowerCase()} category`}
                value={newName[section.id] ?? ''}
                onChange={(e) => setNewName((v) => ({ ...v, [section.id]: e.target.value }))}
              />
              <Button small onClick={() => void add(section.id)}>
                Add
              </Button>
            </div>
            {section.name !== 'Kids' && section.name !== 'Income' && (
              <Toggle
                checked={Boolean(kidScoped[section.id])}
                onChange={(v) => setKidScoped((s) => ({ ...s, [section.id]: v }))}
                label="New category is per kid"
              />
            )}
          </div>
        ))}
    </Sheet>
  );
}
