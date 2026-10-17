import { useState } from 'react';
import { getDevUser, setDevUser } from '../api';
import { go } from '../router';
import { useApp } from '../state';
import { Button, Card, Field, PageHeader } from '../ui';
import { Accounts } from './Accounts';
import { CheckIn } from './CheckIn';
import { Export } from './Export';
import { Fun } from './Fun';
import { Import } from './Import';
import { Income } from './Income';
import { Kids } from './Kids';
import { Rules } from './Rules';
import { Settings } from './Settings';

const MENU = [
  { path: 'checkin', icon: '🤝', title: 'Monthly check-in', text: 'Review last month together and agree on the next one' },
  { path: 'fun', icon: '🎈', title: 'Fun money', text: 'Personal allowances, no questions asked' },
  { path: 'kids', icon: '🧒', title: 'Kids', text: 'What each kid costs, budgets, tax summaries' },
  { path: 'accounts', icon: '🏦', title: 'Accounts & banks', text: 'Connect Chime, Capital One, Fidelity' },
  { path: 'import', icon: '📄', title: 'Import a file', text: 'CSV, OFX or QFX downloads from your bank' },
  { path: 'income', icon: '💵', title: 'Income & paydays', text: 'Paychecks that drive the weekly plan' },
  { path: 'rules', icon: '🏷️', title: 'Rules', text: 'How transactions get sorted automatically' },
  { path: 'settings', icon: '⚙️', title: 'Settings', text: 'Household, people, categories' },
  { path: 'export', icon: '⬇️', title: 'Export your data', text: 'Everything, in open formats' },
];

export function More({ sub, params }: { sub: string | undefined; params: URLSearchParams }) {
  switch (sub) {
    case 'checkin':
      return <CheckIn params={params} />;
    case 'fun':
      return <Fun />;
    case 'kids':
      return <Kids />;
    case 'accounts':
      return <Accounts />;
    case 'import':
      return <Import />;
    case 'income':
      return <Income />;
    case 'rules':
      return <Rules />;
    case 'settings':
      return <Settings />;
    case 'export':
      return <Export />;
    default:
      return <MoreMenu />;
  }
}

function MoreMenu() {
  const { me } = useApp();
  return (
    <div className="stack">
      <PageHeader title="More" />
      <div className="list">
        {MENU.map((item) => (
          <button key={item.path} type="button" className="row row-button" onClick={() => go(`more/${item.path}`)}>
            <span style={{ fontSize: '1.4rem' }} aria-hidden="true">
              {item.icon}
            </span>
            <div className="row-main">
              <div className="row-title">{item.title}</div>
              <div className="row-sub">{item.text}</div>
            </div>
            <span className="muted">›</span>
          </button>
        ))}
      </div>
      {me.devMode ? (
        <DevUserSwitcher />
      ) : (
        <Card>
          <p className="muted small">Signed in as {me.viewer.email}</p>
          {/* Ends the Cloudflare Access session, so a shared device stops showing your private fun money. */}
          <Button variant="secondary" onClick={() => window.location.assign('/cdn-cgi/access/logout')}>
            Sign out
          </Button>
        </Card>
      )}
    </div>
  );
}

function DevUserSwitcher() {
  const { me } = useApp();
  const [email, setEmail] = useState(getDevUser() ?? '');
  return (
    <Card>
      <h2>Local testing: act as</h2>
      <p className="muted small">Only on your computer with DEV_AUTH_BYPASS. Try a second email to test fun money privacy.</p>
      <div className="cluster">
        {me.members.map((m) => (
          <Button
            key={m.id}
            small
            variant={m.email === me.viewer.email ? 'primary' : 'secondary'}
            onClick={() => {
              setDevUser(m.email);
              window.location.reload();
            }}
          >
            {m.name}
          </Button>
        ))}
      </div>
      <Field label="Another email">
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="partner@example.com" />
      </Field>
      <Button
        small
        onClick={() => {
          setDevUser(email.trim() || null);
          window.location.reload();
        }}
      >
        Switch
      </Button>
    </Card>
  );
}

export function SubHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <>
      <Button small variant="ghost" onClick={() => go('more')} className="back">
        ‹ More
      </Button>
      <PageHeader title={title} subtitle={subtitle} action={action} />
    </>
  );
}
