import { createContext, useCallback, useContext, useEffect, useRef, useState, type DependencyList } from 'react';
import type { Account, Category, Me } from './types';

export interface AppData {
  me: Me;
  categories: Category[];
  sections: { id: number; name: string; sort: number }[];
  accounts: Account[];
  reload: () => Promise<void>;
  toast: (text: string, tone?: 'ok' | 'error') => void;
}

export const AppContext = createContext<AppData | null>(null);

export function useApp(): AppData {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside the app');
  return value;
}

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Loads data when deps change; ignores stale responses. */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const latest = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    const id = ++latest.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await loadRef.current();
      if (id === latest.current) setState({ data, loading: false });
    } catch (error) {
      if (id === latest.current) {
        setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error), loading: false }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data: state.data, error: state.error, loading: state.loading, reload };
}

/** Category helpers shared by pickers and lists. */
export function categoryName(categories: readonly Category[], id: number | null | undefined): string {
  if (id == null) return 'Uncategorized';
  return categories.find((c) => c.id === id)?.name ?? 'Unknown';
}
