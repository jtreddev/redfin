import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage } from './api';
import { go, useRoute, type Route } from './router';
import { Activity } from './screens/Activity';
import { Goals } from './screens/Goals';
import { Home } from './screens/Home';
import { More } from './screens/More';
import { Plan } from './screens/Plan';
import { AppContext, type AppData, type ToastOptions } from './state';
import { recategorizeAll } from './sync';
import type { Account, Category, Me } from './types';
import { ErrorNote, Loading } from './ui';

const TABS = [
  { path: 'home', label: 'Home', icon: '⌂' },
  { path: 'activity', label: 'Activity', icon: '☰' },
  { path: 'plan', label: 'Plan', icon: '▦' },
  { path: 'goals', label: 'Goals', icon: '◎' },
  { path: 'more', label: 'More', icon: '⋯' },
];

type BaseData = Omit<AppData, 'reload' | 'toast'>;

/** Keeps a crash in one screen from blanking the whole app. */
class ScreenErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="banner banner-bad">
        <span>Something went wrong on this screen: {this.state.error.message}</span>
        <button type="button" className="btn btn-small" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

function Screen({ route }: { route: Route }) {
  const [top, sub] = route.path.split('/');
  switch (top) {
    case 'activity':
      return <Activity params={route.params} />;
    case 'plan':
      return <Plan params={route.params} />;
    case 'goals':
      return <Goals params={route.params} />;
    case 'more':
      return <More sub={sub} params={route.params} />;
    default:
      return <Home />;
  }
}

export function App() {
  const route = useRoute();
  const [base, setBase] = useState<BaseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'error'; action?: ToastOptions['action'] } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      const [me, categories, accounts] = await Promise.all([
        api<Me>('/me'),
        api<{ sections: BaseData['sections']; categories: Category[] }>('/categories'),
        api<Account[]>('/accounts'),
      ]);
      setBase({ me, categories: categories.categories, sections: categories.sections, accounts });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // History from before automatic categories gets sorted once, quietly, without holding up the screen.
  const needsCategorizing = base !== null && base.me.household.categorizedAllAt === null;
  const categorizing = useRef(false);
  useEffect(() => {
    if (!needsCategorizing || categorizing.current) return;
    categorizing.current = true;
    recategorizeAll()
      .then(() => reload())
      .catch((e) => console.error('Background categorizing failed', e));
  }, [needsCategorizing, reload]);

  const showToast = useCallback((text: string, tone: 'ok' | 'error' = 'ok', options: ToastOptions = {}) => {
    setToast({ text, tone, action: options.action });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), options.durationMs ?? (options.action ? 6000 : 3500));
  }, []);

  if (!base) {
    return <div className="app">{error ? <ErrorNote message={error} onRetry={() => void reload()} /> : <Loading />}</div>;
  }

  const top = route.path.split('/')[0];
  return (
    <AppContext.Provider value={{ ...base, reload, toast: showToast }}>
      <main className="app">
        <ScreenErrorBoundary key={route.path}>
          <Screen route={route} />
        </ScreenErrorBoundary>
      </main>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((tab) => (
          <a
            key={tab.path}
            href={`#/${tab.path}`}
            className={top === tab.path ? 'active' : ''}
            aria-current={top === tab.path ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault();
              go(tab.path);
            }}
          >
            <span className="tab-icon" aria-hidden="true">
              {tab.icon}
            </span>
            {tab.label}
          </a>
        ))}
      </nav>
      {toast && (
        <div className={`toast ${toast.tone}`} role="status">
          <span>{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                const { run } = toast.action!;
                window.clearTimeout(timer.current);
                setToast(null);
                run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </AppContext.Provider>
  );
}
