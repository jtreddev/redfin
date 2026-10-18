/**
 * A closed native <select> fires `change` on every arrow-key step. Pickers that save straight away
 * (a charge's category) hold keyboard steps and commit on Enter or when focus leaves; a mouse or
 * touch choice commits at once. "＋ New" (value `__new`) opens only on a real choice, never by
 * arrowing past it.
 */
export interface SelectState {
  /** A value reached by arrow keys, not yet committed. */
  pending: string | null;
  /** The last key was a navigation key, so the next change is a step, not a choice. */
  keyNav: boolean;
}

export type SelectEvent = { type: 'key'; key: string } | { type: 'change'; value: string } | { type: 'blur' } | { type: 'pointer' };

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
export const NEW_VALUE = '__new';
const idle: SelectState = { pending: null, keyNav: false };

export function selectStep(state: SelectState, event: SelectEvent): { state: SelectState; commit: string | null } {
  switch (event.type) {
    case 'pointer':
      return { state: { ...state, keyNav: false }, commit: null };
    case 'key':
      if (NAV_KEYS.has(event.key)) return { state: { ...state, keyNav: true }, commit: null };
      if (event.key === 'Enter' && state.pending !== null) return { state: idle, commit: state.pending };
      return { state, commit: null };
    case 'change':
      if (state.keyNav) return { state: { pending: event.value, keyNav: false }, commit: null };
      return { state: idle, commit: event.value };
    case 'blur':
      // Leaving the field keeps a value arrowed to, but never opens "＋ New".
      return { state: idle, commit: state.pending === NEW_VALUE ? null : state.pending };
  }
}
