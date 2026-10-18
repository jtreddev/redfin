import { SPECIAL } from '../shared/categorySet';
import type { Category } from './types';

/** Moves the item at `from` to `to` (both clamped), returning a new list. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const target = Math.min(next.length - 1, Math.max(0, to));
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** The ids of `list` with `id` moved by `delta` places (↑ is -1), or null when it can't move. */
export function moveId(ids: readonly number[], id: number, delta: number): number[] | null {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  return moveItem(ids, from, to);
}

export interface CategoryNode {
  category: Category;
  children: Category[];
}

export interface CategoryGroup {
  section: { id: number; name: string; sort: number };
  nodes: CategoryNode[];
}

const bySort = (a: Category, b: Category) => a.sort - b.sort || a.name.localeCompare(b.name);

/**
 * Groups in order, each with its top-level categories and their sub-categories, by sort then name.
 * `include` decides which categories are listed (hidden ones, partner's fun money…); a child whose
 * parent isn't listed is shown at the top level so it never disappears.
 */
export function categoryTree(
  sections: readonly { id: number; name: string; sort: number }[],
  categories: readonly Category[],
  include: (c: Category) => boolean = () => true,
): CategoryGroup[] {
  const listed = categories.filter(include);
  const listedIds = new Set(listed.map((c) => c.id));
  return [...sections]
    .sort((a, b) => a.sort - b.sort)
    .map((section) => {
      const inSection = listed.filter((c) => c.sectionId === section.id);
      const tops = inSection.filter((c) => c.parentId === null || !listedIds.has(c.parentId)).sort(bySort);
      return {
        section,
        nodes: tops.map((category) => ({
          category,
          children: inSection.filter((c) => c.parentId === category.id).sort(bySort),
        })),
      };
    })
    .filter((g) => g.nodes.length > 0);
}

/** Picker options in tree order; sub-categories carry their depth for indenting. */
export function pickerOptions(groups: readonly CategoryGroup[]): { section: string; options: { category: Category; depth: 0 | 1 }[] }[] {
  return groups.map((g) => ({
    section: g.section.name,
    options: g.nodes.flatMap((n) => [
      { category: n.category, depth: 0 as const },
      ...n.children.map((category) => ({ category, depth: 1 as const })),
    ]),
  }));
}

export function isSpecialCategory(c: Pick<Category, 'sectionName' | 'name'>): boolean {
  return Object.values(SPECIAL).some(([section, name]) => section === c.sectionName && name === c.name);
}

export interface CategoryRules {
  rename: string | null;
  moveGroup: string | null;
  nest: string | null;
  merge: string | null;
  hide: string | null;
}

/**
 * What can't be done to a category, and why (null = allowed). Mirrors the server's refusals in
 * PATCH/merge /categories so the screen can say so up front instead of failing.
 */
export function categoryRules(c: Category, all: readonly Category[]): CategoryRules {
  const hasChildren = all.some((k) => k.parentId === c.id);
  if (c.funMemberId !== null) {
    const why = 'Fun money follows its person, so it stays as it is.';
    return { rename: why, moveGroup: why, nest: why, merge: why, hide: why };
  }
  const special = isSpecialCategory(c);
  const relies = `The app looks for ${c.name} by name, so it keeps its name and group.`;
  return {
    rename: special ? relies : null,
    moveGroup: special ? relies : c.parentId !== null ? 'Take it out of its parent first.' : null,
    nest: special
      ? `The app relies on ${c.name}, so it stays a top-level category.`
      : hasChildren
        ? `${c.name} has sub-categories, so it can’t become one.`
        : null,
    merge: special ? `The app relies on ${c.name}, so it can’t be merged away.` : null,
    hide: null,
  };
}

/** Top-level categories `c` could be nested under: same group, visible, not fun money, not itself. */
export function possibleParents(c: Category, all: readonly Category[]): Category[] {
  return all
    .filter((p) => p.id !== c.id && p.sectionId === c.sectionId && p.parentId === null && !p.archived && p.funMemberId === null)
    .sort(bySort);
}

/** Categories `c` could merge into: visible, not fun money, not itself or its own child; two levels never result. */
export function mergeTargets(c: Category, all: readonly Category[]): Category[] {
  const hasChildren = all.some((k) => k.parentId === c.id);
  return all.filter(
    (t) => t.id !== c.id && !t.archived && t.funMemberId === null && t.parentId !== c.id && !(hasChildren && t.parentId !== null),
  );
}
