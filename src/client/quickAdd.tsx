import { useState } from 'react';
import { GROUPS, kindForGroup } from '../shared/categorySet';
import { errorMessage, patch, post } from './api';
import { useApp } from './state';
import type { Kid } from './types';
import { Button, Field, Sheet, Toggle } from './ui';

const GROUP_NAMES: string[] = Object.values(GROUPS);

/** The groups people file into, in order (old empty sections from before the groups stay out). */
export function useGroups() {
  const { sections } = useApp();
  return [...sections].filter((s) => GROUP_NAMES.includes(s.name)).sort((a, b) => a.sort - b.sort);
}

/** "＋ New category" from any picker: name, group, optionally under a parent. Picks it on save. */
export function NewCategorySheet({
  defaultSectionId,
  defaultParentId = null,
  onClose,
  onCreated,
}: {
  defaultSectionId?: number;
  defaultParentId?: number | null;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const { categories, toast, reload } = useApp();
  const groups = useGroups();
  const everyday = groups.find((g) => g.name === GROUPS.everyday)?.id;
  const [sectionId, setSectionId] = useState<number>(defaultSectionId ?? everyday ?? groups[0]?.id ?? 0);
  const [parentId, setParentId] = useState<number | null>(defaultParentId);
  const [name, setName] = useState('');
  const [kidScoped, setKidScoped] = useState(false);
  const [saving, setSaving] = useState(false);
  const group = groups.find((g) => g.id === sectionId);
  const parents = categories.filter((c) => c.sectionId === sectionId && c.parentId === null && !c.archived && c.funMemberId === null);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await post<{ id: number }>(
        '/categories',
        parentId ? { name: name.trim(), parentId } : { name: name.trim(), sectionId, kidScoped },
      );
      await reload();
      toast(`Added ${name.trim()}`);
      onCreated(res.id);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title="New category">
      <form
        className="stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus placeholder="e.g. Swim lessons" />
        </Field>
        <Field label="Group">
          <select
            value={sectionId}
            onChange={(e) => {
              setSectionId(Number(e.target.value));
              setParentId(null);
            }}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Inside another category (optional)" hint="A sub-category counts toward its parent in the budget and Trends.">
          <select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">No, on its own</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                Under {p.name}
              </option>
            ))}
          </select>
        </Field>
        {!parentId && group && kindForGroup(group.name) === 'expense' && (
          <Toggle checked={kidScoped} onChange={setKidScoped} label="Asks which kid" hint="For things like school or activities." />
        )}
        <div className="cluster">
          <Button type="submit" variant="primary" disabled={!name.trim() || saving}>
            Add category
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

export const KID_COLORS = ['#e08a2c', '#3b82c4', '#8a5cd6', '#2e9e6b', '#d0457b', '#c2a12b'];
const COLOR_NAMES: Record<string, string> = {
  '#e08a2c': 'Orange',
  '#3b82c4': 'Blue',
  '#8a5cd6': 'Purple',
  '#2e9e6b': 'Green',
  '#d0457b': 'Pink',
  '#c2a12b': 'Gold',
};

/** Add or edit a kid: name, optional birth date, color. `onSaved` gets the kid's id. */
export function KidFormSheet({
  kid,
  onClose,
  onSaved,
  onHide,
}: {
  kid: Kid | null;
  onClose: () => void;
  onSaved: (id: number | null) => void;
  /** Editing only: a "Hide" button (hidden kids keep their history). */
  onHide?: () => void;
}) {
  const { toast, me, reload } = useApp();
  const [name, setName] = useState(kid?.name ?? '');
  const [color, setColor] = useState(kid?.color ?? KID_COLORS[me.kids.length % KID_COLORS.length] ?? '#e08a2c');
  const [birthDate, setBirthDate] = useState(kid?.birthDate ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      let id = kid?.id ?? null;
      if (kid) await patch(`/kids/${kid.id}`, { name: name.trim(), color, birthDate: birthDate || null });
      else id = (await post<{ id: number }>('/kids', { name: name.trim(), color, birthDate: birthDate || null })).id;
      await reload();
      toast(kid ? 'Saved' : `Added ${name.trim()}`);
      onSaved(id);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={kid ? `Edit ${kid.name}` : 'Add a kid'}>
      <form
        className="stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus />
        </Field>
        <Field label="Birth date (optional)">
          <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
        </Field>
        <fieldset className="field plain-fieldset">
          <legend className="field-label">Color</legend>
          <div className="swatches">
            {KID_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={COLOR_NAMES[c] ?? c}
                onClick={() => setColor(c)}
                aria-pressed={color === c}
                className={`swatch ${color === c ? 'selected' : ''}`}
                style={{ background: c }}
              />
            ))}
          </div>
        </fieldset>
        <div className="cluster">
          <Button type="submit" variant="primary" disabled={!name.trim() || saving}>
            {kid ? 'Save' : 'Add kid'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {kid && onHide && (
            <Button variant="danger" onClick={onHide}>
              Hide {kid.name}
            </Button>
          )}
        </div>
      </form>
    </Sheet>
  );
}
