import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage } from './api';
import { go, useRoute, type Route } from './router';
import { Icon, type IconName } from './icons';
import { Activity } from './screens/Activity';
import { Home } from './screens/Home';
import { More, MORE_ITEMS } from './screens/More';
import { Plan } from './screens/Plan';
import { Trends } from './screens/Trends';
import { AppContext, type AppData, type ToastOptions } from './state';
import { recategorizeAll } from './sync';
import type { Account, Category, Me } from './types';
import { ErrorNote, Loading } from './ui';

const TABS: { path: string; label: string; icon: IconName }[] = [
  { path: 'home', label: 'Home', icon: 'home' },
  { path: 'activity', label: 'Activity', icon: 'activity' },
  { path: 'trends', label: 'Trends', icon: 'trends' },
  { path: 'plan', label: 'Plan', icon: 'plan' },
  { path: 'more', label: 'More', icon: 'more' },
];

/** Screens that may use the wide (two-column) layout on a computer. */
const WIDE = new Set(['trends', 'plan']);

/** The app's mark: the month ribbon in miniature (the same drawing as the app icon). */
function Mark() {
  return (
    <svg className="sidebar-mark" viewBox="80 150 352 212" aria-hidden="true" focusable="false">
      <rect x="92" y="214" width="164" height="84" rx="18" fill="var(--accent)" />
      <rect x="268" y="214" width="76" height="84" rx="18" fill="var(--accent)" fillOpacity="0.7" />
      <rect x="356" y="214" width="30" height="84" rx="12" fill="var(--accent)" fillOpacity="0.45" />
      <rect x="398" y="164" width="24" height="184" rx="12" fill="var(--accent)" />
    </svg>
  );
}

function NavLink({ path, label, icon, active }: { path: string; label: string; icon: IconName; active: boolean }) {
  return (
    <a
      href={`#/${path}`}
      className={active ? 'active' : ''}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        go(path);
      }}
    >
      <Icon name={icon} />
      <span>{label}</span>
    </a>
  );
}

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

/** Goals moved under Plan: old #/goals links land on #/plan?view=goals (replacing, so Back doesn't bounce). */
function GoalsRedirect({ params }: { params: URLSearchParams }) {
  useEffect(() => {
    const next = new URLSearchParams(params);
    next.set('view', 'goals');
    window.location.replace(`/#/plan?${next}`);
  }, [params]);
  return null;
}

function Screen({ route }: { route: Route }) {
  const [top, sub] = route.path.split('/');
  switch (top) {
    case 'activity':
      return <Activity params={route.params} />;
    case 'plan':
      return <Plan params={route.params} />;
    case 'trends':
      return <Trends />;
    case 'goals':
      return <GoalsRedirect params={route.params} />;
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

  const top = route.path.split('/')[0] ?? 'home';
  // On a phone, More's screens light up the More tab; the side menu lists them, so it lights up the screen itself.
  const sideActive = top === 'more' ? route.path : top;
  return (
    <AppContext.Provider value={{ ...base, reload, toast: showToast }}>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <div className="sidebar-name">
          <Mark />
          <span>Family Budget</span>
        </div>
        {TABS.map((tab) => (
          <NavLink key={tab.path} {...tab} active={sideActive === tab.path} />
        ))}
        {MORE_ITEMS.map((item) => (
          <NavLink key={item.path} path={`more/${item.path}`} label={item.short} icon={item.icon} active={sideActive === `more/${item.path}`} />
        ))}
      </nav>
      <main id="main" tabIndex={-1} className={`app ${WIDE.has(top) ? 'app-wide' : ''}`}>
        <ScreenErrorBoundary key={route.path}>
          <Screen route={route} />
        </ScreenErrorBoundary>
      </main>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((tab) => (
          <NavLink key={tab.path} {...tab} active={top === tab.path} />
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
