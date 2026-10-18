/** Keyboard shortcuts for Activity (power tools, on a computer). Pure, so it can be tested without a browser. */
export type ShortcutAction = 'search' | 'next' | 'previous' | 'category' | 'select' | 'undo' | 'help';

export const SHORTCUTS: { keys: string; action: ShortcutAction; text: string }[] = [
  { keys: '/', action: 'search', text: 'Search' },
  { keys: 'j', action: 'next', text: 'Next charge' },
  { keys: 'k', action: 'previous', text: 'Previous charge' },
  { keys: 'c', action: 'category', text: 'Change the category' },
  { keys: 'x', action: 'select', text: 'Select or unselect the charge' },
  { keys: 'u', action: 'undo', text: 'Undo the last change' },
  { keys: '?', action: 'help', text: 'Show these shortcuts' },
];

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** The element the key went to (event.target). */
  target?: { tagName?: string; isContentEditable?: boolean; type?: string } | null;
}

/** Typing into a field never fires a shortcut. Buttons, links and checkboxes don't count as typing. */
export function isTyping(target: KeyLike['target']): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target.type ?? 'text').toLowerCase();
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type);
}

export function shortcutFor(event: KeyLike): ShortcutAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isTyping(event.target)) return null;
  const found = SHORTCUTS.find((s) => s.keys === event.key);
  return found?.action ?? null;
}

/** The index j/k moves to from `current` (-1 = nothing focused yet), staying inside the list. */
export function step(current: number, length: number, action: 'next' | 'previous'): number {
  if (length === 0) return -1;
  if (current < 0) return action === 'next' ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + (action === 'next' ? 1 : -1)));
}
