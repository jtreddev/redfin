import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { kindForGroup } from '../../shared/categorySet';
import { ApiError, errorMessage, patch, post } from '../api';
import { categoryRules, categoryTree, isSpecialCategory, mergeTargets, moveId, pickerOptions, possibleParents } from '../categoryTree';
import { plural } from '../format';
import { Icon } from '../icons';
import { go } from '../router';
import { useGroups } from '../quickAdd';
import { useApp } from '../state';
import type { Category } from '../types';
import { Button, Field, optionLabel, Sheet, Toggle } from '../ui';
import { SubHeader } from './More';

/** Where an "Edit category" link goes: this screen, scrolled to the category. */
export const editCategoryPath = (id: number) => ['more/categories', { id }] as const;

export function Categories({ params }: { params: URLSearchParams }) {
  const { categories, toast, reload } = useApp();
  const groups = useGroups();
  const target = Number(params.get('id')) || null;
  const targetCategory = categories.find((c) => c.id === target);
  const [showHidden, setShowHidden] = useState(Boolean(targetCategory?.archived));
  const [reordering, setReordering] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const [dragging, setDragging] = useState<{ id: number; list: string } | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<number | null>(target);
  const refocus = useRef<string | null>(null);

  const tree = categoryTree(groups, categories, (c) => showHidden || !c.archived);
  const hiddenCount = categories.filter((c) => c.archived && groups.some((g) => g.id === c.sectionId)).length;

  // Opened from an "Edit category" link: scroll to it and point it out for a moment.
  useEffect(() => {
    if (!target) return;
    const el = document.getElementById(`cat-${target}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.querySelector<HTMLElement>('.cat-open')?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setHighlight(null), 2400);
    return () => window.clearTimeout(timer);
  }, [target]);

  // After a reorder the list re-renders from the server's order; keep focus on what was moved.
  useEffect(() => {
    if (!refocus.current) return;
    document.getElementById(refocus.current)?.focus();
    refocus.current = null;
  });

  async function reorder(sectionId: number, parentId: number | null, ids: number[], moved: Category, focusId: string) {
    try {
      await post('/categories/reorder', { sectionId, parentId, ids });
      refocus.current = focusId;
      await reload();
      setAnnounce(`${moved.name} moved to ${ids.indexOf(moved.id) + 1} of ${ids.length}`);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function siblingsOf(c: Category): Category[] {
    const group = tree.find((g) => g.section.id === c.sectionId);
    if (!group) return [];
    if (c.parentId === null) return group.nodes.map((n) => n.category);
    return group.nodes.find((n) => n.category.id === c.parentId)?.children ?? [];
  }

  function moveBy(c: Category, delta: number, focusId: string) {
    const ids = siblingsOf(c).map((s) => s.id);
    const next = moveId(ids, c.id, delta);
    if (next) void reorder(c.sectionId, c.parentId, next, c, focusId);
  }

  const listKey = (c: Category) => `${c.sectionId}:${c.parentId ?? 'top'}`;

  function dropOn(c: Category) {
    if (!dragging || dragging.list !== listKey(c) || dragging.id === c.id) return;
    const ids = siblingsOf(c).map((s) => s.id);
    const from = ids.indexOf(dragging.id);
    const to = ids.indexOf(c.id);
    const moved = siblingsOf(c).find((s) => s.id === dragging.id);
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, dragging.id);
    if (moved) void reorder(c.sectionId, c.parentId, next, moved, `grip-${moved.id}`);
  }

  function row(c: Category, index: number, count: number) {
    const sameList = dragging?.list === listKey(c);
    const kids = categories.filter((k) => k.parentId === c.id);
    const notes = [
      c.archived && 'Hidden',
      c.funMemberId !== null && 'Fun money',
      isSpecialCategory(c) && 'The app uses this one',
      c.kidScoped && 'Asks which kid',
      kids.length > 0 && plural(kids.length, 'sub-category', 'sub-categories'),
    ].filter(Boolean) as string[];
    return (
      <div
        key={c.id}
        id={`cat-${c.id}`}
        className={`row cat-row ${c.parentId ? 'cat-child' : ''} ${highlight === c.id ? 'is-target' : ''} ${dragging?.id === c.id ? 'is-dragging' : ''} ${over === c.id && sameList ? 'is-over' : ''}`}
        onDragOver={(e: DragEvent) => {
          if (!sameList) return;
          e.preventDefault();
          setOver(c.id);
        }}
        onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          dropOn(c);
          setDragging(null);
          setOver(null);
        }}
      >
        {!reordering && (
          <button
            type="button"
            id={`grip-${c.id}`}
            className="icon-btn drag-handle"
            draggable
            aria-label={`Move ${c.name}, ${index + 1} of ${count}`}
            aria-describedby="reorder-help"
            onDragStart={(e: DragEvent) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', String(c.id));
              setDragging({ id: c.id, list: listKey(c) });
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                moveBy(c, e.key === 'ArrowUp' ? -1 : 1, `grip-${c.id}`);
              }
            }}
          >
            <Icon name="grip" />
          </button>
        )}
        <button type="button" className="row-main cat-open" onClick={() => setEditing(c.id)} disabled={reordering}>
          <span className="row-title">
            {c.parentId !== null && <span className="sr-only">Sub-category: </span>}
            {c.name}
          </span>
          {notes.length > 0 && <span className="row-sub">{notes.join(' · ')}</span>}
        </button>
        {reordering ? (
          <span className="reorder-btns">
            <button
              type="button"
              id={`up-${c.id}`}
              className="icon-btn"
              aria-label={`Move ${c.name} up`}
              disabled={index === 0}
              onClick={() => moveBy(c, -1, index - 1 === 0 ? `down-${c.id}` : `up-${c.id}`)}
            >
              <Icon name="up" />
            </button>
            <button
              type="button"
              id={`down-${c.id}`}
              className="icon-btn"
              aria-label={`Move ${c.name} down`}
              disabled={index === count - 1}
              onClick={() => moveBy(c, 1, index + 1 === count - 1 ? `up-${c.id}` : `down-${c.id}`)}
            >
              <Icon name="down" />
            </button>
          </span>
        ) : (
          <Icon name="forward" className="row-chevron" />
        )}
      </div>
    );
  }

  const editingCategory = categories.find((c) => c.id === editing) ?? null;
  return (
    <div className="stack">
      <SubHeader
        title="Categories"
        subtitle="Sub-categories count toward their parent in the budget and Trends."
        action={
          <Button small pressed={reordering} onClick={() => setReordering((v) => !v)} className="reorder-toggle">
            {reordering ? 'Done' : 'Reorder'}
          </Button>
        }
      />
      <p id="reorder-help" className="sr-only">
        Press the up or down arrow key to move it within its list.
      </p>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      {hiddenCount > 0 && (
        <Toggle checked={showHidden} onChange={setShowHidden} label={`Show hidden categories (${hiddenCount})`} hint="Hidden ones keep their history and can come back." />
      )}
      {tree.map((group) => (
        <section key={group.section.id} className="stack-sm" aria-labelledby={`group-${group.section.id}`}>
          <div className="section-title">
            <h2 id={`group-${group.section.id}`} className="h3">
              {group.section.name}
            </h2>
          </div>
          <div className="list">
            {group.nodes.map((node, i) => [
              row(node.category, i, group.nodes.length),
              ...node.children.map((child, j) => row(child, j, node.children.length)),
            ])}
          </div>
          {!reordering && <AddInline section={group.section} parents={group.nodes.map((n) => n.category)} />}
        </section>
      ))}
      {editingCategory && <CategorySheet category={editingCategory} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AddInline({ section, parents }: { section: { id: number; name: string }; parents: Category[] }) {
  const { toast, reload } = useApp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<number | null>(null);
  const [kidScoped, setKidScoped] = useState(false);
  const usable = parents.filter((p) => !p.archived && p.funMemberId === null);

  async function add() {
    if (!name.trim()) return;
    try {
      await post('/categories', parentId ? { name: name.trim(), parentId } : { name: name.trim(), sectionId: section.id, kidScoped });
      await reload();
      toast(`Added ${name.trim()}`);
      setName('');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  if (!open) {
    return (
      <Button variant="ghost" small className="add-inline" onClick={() => setOpen(true)}>
        <Icon name="plus" />
        Add to {section.name}
      </Button>
    );
  }
  return (
    <form
      className="add-form stack-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <Field label={`New category in ${section.name}`}>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus placeholder="Name" />
      </Field>
      {usable.length > 0 && (
        <Field label="Where">
          <select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">On its own</option>
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                Under {p.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!parentId && kindForGroup(section.name) === 'expense' && (
        <Toggle checked={kidScoped} onChange={setKidScoped} label="Asks which kid" />
      )}
      <div className="cluster">
        <Button type="submit" variant="primary" small disabled={!name.trim()}>
          Add
        </Button>
        <Button small variant="ghost" onClick={() => setOpen(false)}>
          Done
        </Button>
      </div>
    </form>
  );
}

const COUNT_WORDS: [keyof MergeCounts, string, string][] = [
  ['transactions', 'charge', 'charges'],
  ['splits', 'split part', 'split parts'],
  ['budgetLines', 'budget line', 'budget lines'],
  ['kidBudgets', 'kid budget', 'kid budgets'],
  ['rules', 'rule', 'rules'],
  ['bills', 'bill', 'bills'],
  ['goals', 'goal', 'goals'],
  ['plannedCosts', 'planned-cost link', 'planned-cost links'],
  ['subCategories', 'sub-category', 'sub-categories'],
];

interface MergeCounts {
  transactions: number;
  splits: number;
  budgetLines: number;
  kidBudgets: number;
  rules: number;
  bills: number;
  goals: number;
  plannedCosts: number;
  subCategories: number;
}

function Reason({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="muted small not-allowed">
      <Icon name="lock" />
      <span>{text}</span>
    </p>
  );
}

function CategorySheet({ category: c, onClose }: { category: Category; onClose: () => void }) {
  const { categories, sections, toast, reload } = useApp();
  const groups = useGroups();
  const rules = categoryRules(c, categories);
  const parent = categories.find((p) => p.id === c.parentId) ?? null;
  const parents = possibleParents(c, categories);
  const targets = pickerOptions(categoryTree(sections, mergeTargets(c, categories)));
  const [name, setName] = useState(c.name);
  const [sectionId, setSectionId] = useState(c.sectionId);
  const [parentId, setParentId] = useState<number | ''>('');
  const [intoId, setIntoId] = useState<number | ''>('');
  const [preview, setPreview] = useState<{ counts: MergeCounts; needsConfirm: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ body: Record<string, unknown>; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function change(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      await patch(`/categories/${c.id}`, body);
      await reload();
      setConfirm(null);
      toast(done);
    } catch (error) {
      // Moving between income and spending with charges asks first.
      const data = error instanceof ApiError && error.status === 409 ? error : null;
      if (data && /income and spending/.test(data.message)) setConfirm({ body: { ...body, confirm: true }, message: data.message });
      else toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  // Only the latest target's preview counts: an answer for an earlier pick is dropped.
  const previewFor = useRef(0);
  async function checkMerge(id: number) {
    previewFor.current = id;
    setPreview(null);
    if (!id) return;
    try {
      const res = await post<{ counts: MergeCounts; needsConfirm: boolean }>(`/categories/${c.id}/merge?preview=1`, { intoId: id });
      if (previewFor.current === id) setPreview(res);
    } catch (error) {
      if (previewFor.current === id) toast(errorMessage(error), 'error');
    }
  }

  async function merge() {
    if (!intoId || !preview) return;
    const into = categories.find((k) => k.id === intoId);
    setBusy(true);
    try {
      await post(`/categories/${c.id}/merge`, { intoId, confirm: preview.needsConfirm });
      await reload();
      toast(`${c.name} merged into ${into?.name ?? 'the other category'}`);
      onClose();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  const moving = preview ? COUNT_WORDS.filter(([key]) => preview.counts[key] > 0).map(([key, one, many]) => plural(preview.counts[key], one, many)) : [];
  return (
    <Sheet open onClose={onClose} title={c.name}>
      {confirm && (
        <div className="banner banner-warn" role="alert">
          <span>{confirm.message} Past months will add up differently.</span>
          <div className="cluster">
            <Button small variant="primary" disabled={busy} onClick={() => void change(confirm.body, 'Moved')}>
              Move anyway
            </Button>
            <Button small variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <section className="stack-sm">
        <h3>Name</h3>
        {rules.rename ? (
          <Reason text={rules.rename} />
        ) : (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== c.name) void change({ name: name.trim() }, 'Renamed');
            }}
          >
            <label className="sr-only" htmlFor="cat-name">
              Name
            </label>
            <input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            <Button type="submit" small disabled={busy || !name.trim() || name.trim() === c.name}>
              Rename
            </Button>
          </form>
        )}
      </section>

      <section className="stack-sm">
        <h3>Where it sits</h3>
        <p className="muted small">
          {parent ? `Inside ${parent.name}, in ${c.sectionName}.` : `In ${c.sectionName}, on its own.`}
        </p>
        {parent && (
          <Button small onClick={() => void change({ parentId: null }, `${c.name} is on its own now`)} disabled={busy}>
            Take it out of {parent.name}
          </Button>
        )}
        {rules.moveGroup && !parent ? (
          <Reason text={rules.moveGroup} />
        ) : (
          !parent && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (sectionId !== c.sectionId) void change({ sectionId }, 'Moved');
              }}
            >
              <label className="sr-only" htmlFor="cat-group">
                Move to group
              </label>
              <select id="cat-group" value={sectionId} onChange={(e) => setSectionId(Number(e.target.value))}>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.id === c.sectionId ? `${g.name} (now)` : `Move to ${g.name}`}
                  </option>
                ))}
              </select>
              <Button type="submit" small disabled={busy || sectionId === c.sectionId}>
                Move
              </Button>
            </form>
          )
        )}
        {rules.nest ? (
          <Reason text={rules.nest} />
        ) : (
          parents.filter((p) => p.id !== c.parentId).length > 0 && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (parentId) void change({ parentId }, 'Moved');
              }}
            >
              <label className="sr-only" htmlFor="cat-parent">
                Make it a sub-category of
              </label>
              <select id="cat-parent" value={parentId} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Make it a sub-category of…</option>
                {parents
                  .filter((p) => p.id !== c.parentId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <Button type="submit" small disabled={busy || !parentId}>
                Nest
              </Button>
            </form>
          )
        )}
        {c.funMemberId === null && c.kind === 'expense' && !c.parentId && (
          <Toggle checked={c.kidScoped} onChange={(v) => void change({ kidScoped: v }, v ? 'Asks which kid now' : 'Saved')} label="Asks which kid" />
        )}
      </section>

      <section className="stack-sm">
        <h3>{c.archived ? 'Hidden' : 'Hide'}</h3>
        {rules.hide ? (
          <Reason text={rules.hide} />
        ) : c.archived ? (
          <>
            <p className="muted small">Hidden from pickers and the budget. Its history is kept.</p>
            <Button small onClick={() => void change({ archived: false }, `${c.name} is back`)} disabled={busy || Boolean(parent?.archived)}>
              Show it again
            </Button>
            {parent?.archived && <Reason text={`Show ${parent.name} first.`} />}
          </>
        ) : (
          <>
            <p className="muted small">
              Hidden categories leave the pickers and the budget but keep their history.
              {categories.some((k) => k.parentId === c.id) && ' Its sub-categories are hidden too.'}
            </p>
            <Button small onClick={() => void change({ archived: true }, `${c.name} is hidden`)} disabled={busy}>
              Hide {c.name}
            </Button>
          </>
        )}
      </section>

      <section className="stack-sm">
        <h3>Merge into another</h3>
        {rules.merge ? (
          <Reason text={rules.merge} />
        ) : (
          <>
            <p className="muted small">Moves its charges, splits, budgets, rules, bills, goals and planned costs, then hides it. This can’t be undone.</p>
            <label className="sr-only" htmlFor="cat-merge">
              Merge into
            </label>
            <select
              id="cat-merge"
              value={intoId}
              onChange={(e) => {
                const id = e.target.value ? Number(e.target.value) : '';
                setIntoId(id);
                void checkMerge(Number(id));
              }}
            >
              <option value="">Pick a category…</option>
              {targets.map((g) => (
                <optgroup key={g.section} label={g.section}>
                  {g.options.map(({ category }) => (
                    <option key={category.id} value={category.id}>
                      {optionLabel(category, categories)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {preview && (
              <div className={`banner ${preview.needsConfirm ? 'banner-warn' : ''}`} aria-live="polite">
                <span>
                  {moving.length ? `Moves ${moving.join(', ')}.` : 'Nothing is filed here yet.'}
                  {preview.needsConfirm && ' It also moves charges between income and spending, which changes past months’ totals.'}
                </span>
              </div>
            )}
            {preview && (
              <Button variant="danger" onClick={() => void merge()} disabled={busy}>
                {preview.needsConfirm ? 'I understand, merge' : 'Merge'} into {categories.find((k) => k.id === intoId)?.name}
              </Button>
            )}
          </>
        )}
      </section>

      {c.funMemberId === null && (
        <Button variant="ghost" onClick={() => go('activity', { categoryId: c.id, month: 'all' })}>
          See its charges
        </Button>
      )}
    </Sheet>
  );
}
