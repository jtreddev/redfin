import { useEffect, useState } from 'react';

/**
 * Tiny hash router: #/home, #/activity?category=12, #/more/rules.
 * Plaid's OAuth redirect lands on /oauth-return, which shows the Accounts screen.
 */
export interface Route {
  path: string;
  params: URLSearchParams;
}

export function currentRoute(): Route {
  if (window.location.pathname === '/oauth-return') {
    return { path: 'more/accounts', params: new URLSearchParams() };
  }
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = hash.split('?');
  return { path: path || 'home', params: new URLSearchParams(query) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onChange);
    window.addEventListener('popstate', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener('popstate', onChange);
    };
  }, []);
  return route;
}

export function go(path: string, params?: Record<string, string | number | null | undefined>) {
  const query = params
    ? new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== null && v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : '';
  const hash = `#/${path}${query ? `?${query}` : ''}`;
  if (window.location.pathname !== '/') {
    window.history.replaceState(null, '', `/${hash}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  } else {
    window.location.hash = hash;
  }
  window.scrollTo(0, 0);
}
