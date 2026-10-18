import { useEffect, useState } from 'react';
import { usePlaidLink, type PlaidLinkError, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link';
import { api, del, errorMessage, patch, post } from '../api';
import { describeBalance, money, plural, timeAgo } from '../format';
import { go } from '../router';
import { useApp, useLoad } from '../state';
import { syncOneBank } from '../sync';
import type { Account } from '../types';
import { AmountInput, Button, Card, ErrorNote, Field, Sheet, Toggle } from '../ui';
import { SubHeader } from './More';

interface PlaidStatus {
  configured: boolean;
  env: string;
  itemLimit: number;
  items: {
    id: number;
    institutionName: string | null;
    status: 'ok' | 'login_required' | 'error';
    errorMessage: string | null;
    lastSyncedAt: string | null;
    hasMore: number;
    historyComplete: number;
    accountCount: number;
  }[];
}

const LINK_STATE_KEY = 'fin.plaidLink';

/** Checking and savings: the bank's "available" leaves out pending charges, which is what most bank apps show. */
const availableDiffers = (a: Account) =>
  a.type !== 'credit' && a.type !== 'loan' && a.availableBalanceCents != null && a.availableBalanceCents !== a.currentBalanceCents;

export function Accounts() {
  const { accounts, reload, toast, me } = useApp();
  const status = useLoad(() => api<PlaidStatus>('/plaid/status'), []);
  const [link, setLink] = useState<{ token: string; itemId: number | null; redirect?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Account | 'new' | null>(null);

  // Returning from a bank's OAuth page: resume the same Link session.
  useEffect(() => {
    if (window.location.pathname !== '/oauth-return') return;
    try {
      const saved = JSON.parse(localStorage.getItem(LINK_STATE_KEY) ?? 'null') as { token: string; itemId: number | null } | null;
      if (saved) setLink({ ...saved, redirect: window.location.href });
    } catch {
      // ignore
    }
  }, []);

  function finishLinkSession() {
    setLink(null);
    try {
      localStorage.removeItem(LINK_STATE_KEY);
    } catch {
      // ignore
    }
    if (window.location.pathname === '/oauth-return') go('more/accounts');
  }

  async function startLink(itemId?: number) {
    try {
      setBusy('Opening Plaid…');
      const res = await post<{ linkToken: string }>('/plaid/link-token', itemId ? { itemId } : {});
      const state = { token: res.linkToken, itemId: itemId ?? null };
      localStorage.setItem(LINK_STATE_KEY, JSON.stringify(state));
      setLink(state);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function onLinked(publicToken: string, metadata: PlaidLinkOnSuccessMetadata) {
    const itemId = link?.itemId ?? null;
    finishLinkSession();
    try {
      let syncId = itemId;
      if (itemId) {
        await post(`/plaid/items/${itemId}/reconnected`);
      } else {
        setBusy('Saving connection…');
        const res = await post<{ itemId: number; accounts: number }>('/plaid/exchange', {
          publicToken,
          institutionId: metadata.institution?.institution_id,
          institutionName: metadata.institution?.name,
        });
        syncId = res.itemId;
        toast(`Connected ${plural(res.accounts, 'account')}. Pulling history…`);
      }
      if (syncId) await pullHistory(syncId);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
      await Promise.all([reload(), status.reload()]);
    }
  }

  async function pullHistory(itemId: number) {
    const result = await syncOneBank(itemId, (step) => setBusy(`Importing… ${step.added ? `+${step.added}` : ''}`));
    if (result.errors.length) toast(result.errors[0] ?? 'Sync problem', 'error');
    else if (!result.added && result.notes?.length) toast(result.notes[result.notes.length - 1] ?? '');
    else toast(`${plural(result.added, 'transaction')} imported`);
  }

  async function connectTestBank() {
    setBusy('Connecting test bank…');
    try {
      const res = await post<{ itemId: number; accounts: number }>('/plaid/sandbox-connect');
      toast(`Test bank connected with ${plural(res.accounts, 'account')}`);
      await pullHistory(res.itemId);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
      await Promise.all([reload(), status.reload()]);
    }
  }

  async function syncBank(itemId: number) {
    setBusy('Syncing…');
    try {
      const result = await syncOneBank(itemId);
      if (result.errors.length) toast(result.errors[0] ?? 'Sync problem', 'error');
      else if (!result.added && result.notes?.length) toast(result.notes[result.notes.length - 1] ?? '');
      else toast(`${plural(result.added, 'new transaction')}`);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
      await Promise.all([reload(), status.reload()]);
    }
  }

  async function refreshDetails(itemId: number) {
    setBusy('Refreshing bank details…');
    try {
      await post(`/plaid/items/${itemId}/refresh-details`, {});
      const result = await syncOneBank(itemId);
      if (result.errors.length) toast(result.errors[0] ?? 'Sync problem', 'error');
      else toast(`Updated ${plural(result.refreshed ?? 0, 'charge')}`);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
      await Promise.all([reload(), status.reload()]);
    }
  }

  async function disconnect(itemId: number, name: string | null) {
    if (!window.confirm(`Disconnect ${name ?? 'this bank'}? Its history stays; it just stops syncing.`)) return;
    try {
      await del(`/plaid/items/${itemId}`);
      await Promise.all([reload(), status.reload()]);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  const s = status.data;
  return (
    <div className="stack">
      <SubHeader title="Accounts & banks" />
      {busy && <div className="banner">{busy}</div>}
      {status.error && <ErrorNote message={status.error} onRetry={() => void status.reload()} />}

      {s && !s.configured && (
        <Card>
          <h2>Bank sync isn’t set up yet</h2>
          <p className="muted small">
            Add your free Plaid keys (see SETUP.md) to connect Chime, Capital One and Fidelity. Until then, import CSV files from
            your bank. Everything else works the same.
          </p>
          <Button onClick={() => go('more/import')}>Import a file</Button>
        </Card>
      )}

      {s?.configured && (
        <>
          <div className="section-title">
            <h3>Connected banks</h3>
            <span className="muted small">
              {s.items.length} of {s.itemLimit} free
            </span>
          </div>
          {s.items.map((item) => (
            <Card key={item.id}>
              <div className="spread">
                <div>
                  <strong>{item.institutionName ?? 'Bank'}</strong>
                  <div className="muted small">
                    {plural(item.accountCount, 'account')} · synced {timeAgo(item.lastSyncedAt)}
                    {item.hasMore ? ' · catching up' : ''}
                  </div>
                </div>
                <span className={item.status === 'ok' ? 'chip chip-brand' : 'chip chip-bad'}>
                  {item.status === 'ok' ? 'Syncing' : item.status === 'login_required' ? 'Sign in again' : 'Problem'}
                </span>
              </div>
              {item.errorMessage && item.status !== 'ok' && <p className="small tone-bad">{item.errorMessage}</p>}
              <div className="cluster" style={{ marginTop: 10 }}>
                {item.status === 'ok' ? (
                  <Button small onClick={() => void syncBank(item.id)} disabled={Boolean(busy)}>
                    Sync now
                  </Button>
                ) : (
                  <Button small variant="primary" onClick={() => void startLink(item.id)} disabled={Boolean(busy)}>
                    Reconnect
                  </Button>
                )}
                {item.status === 'ok' && (
                  <Button small variant="ghost" onClick={() => void refreshDetails(item.id)} disabled={Boolean(busy)}>
                    Refresh bank details
                  </Button>
                )}
                <Button small variant="ghost" onClick={() => void disconnect(item.id, item.institutionName)}>
                  Disconnect
                </Button>
              </div>
            </Card>
          ))}
          <Button variant="primary" onClick={() => void startLink()} disabled={Boolean(busy) || s.items.length >= s.itemLimit}>
            Connect a bank
          </Button>
          {me.devMode && s.env === 'sandbox' && (
            <Button onClick={() => void connectTestBank()} disabled={Boolean(busy)}>
              Add a fake test bank (Sandbox, local only)
            </Button>
          )}
          <p className="muted small">
            Connects through Plaid: you sign in on your bank’s own page and this app never sees your password. It can read
            transactions and balances but can’t move money. If the bank page gets stuck on a phone, try from a computer.
            {s.env === 'sandbox' && ' (Sandbox mode: use user_good / pass_good.)'}
          </p>
        </>
      )}

      <div className="section-title">
        <h3>Accounts</h3>
        <Button small onClick={() => setEditing('new')}>
          Add manually
        </Button>
      </div>
      <div className="list">
        {accounts.length === 0 && <div className="row muted">No accounts yet.</div>}
        {accounts.map((a) => (
          <button key={a.id} type="button" className="row row-button" onClick={() => setEditing(a)}>
            <div className="row-main">
              <div className="row-title">
                {a.name}
                {a.mask ? ` ••${a.mask}` : ''}
              </div>
              <div className="row-sub">
                {[a.institution, a.type, a.isCash ? 'counts as cash' : null, a.plaidItemId ? 'synced' : 'manual/import', a.hidden ? 'hidden' : null]
                  .filter(Boolean)
                  .join(' · ')}
                {a.ownerMemberId && ` · ${me.members.find((m) => m.id === a.ownerMemberId)?.name}’s`}
              </div>
            </div>
            {a.currentBalanceCents !== null && (
              <div className="money" style={{ textAlign: 'right' }}>
                {describeBalance(a.type, a.currentBalanceCents)}
                {availableDiffers(a) && <div className="muted small">{money(a.availableBalanceCents!)} available</div>}
              </div>
            )}
          </button>
        ))}
      </div>
      <Button variant="ghost" onClick={() => go('more/import')}>
        Import a CSV / OFX file instead
      </Button>

      {link && (
        <PlaidLauncher
          token={link.token}
          receivedRedirectUri={link.redirect}
          onSuccess={(publicToken, metadata) => void onLinked(publicToken, metadata)}
          onExit={(error) => {
            finishLinkSession();
            if (error) toast(error.display_message || error.error_message || 'Plaid closed with an error', 'error');
          }}
        />
      )}
      {editing && (
        <AccountSheet
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function PlaidLauncher({
  token,
  receivedRedirectUri,
  onSuccess,
  onExit,
}: {
  token: string;
  receivedRedirectUri?: string;
  onSuccess: (publicToken: string, metadata: PlaidLinkOnSuccessMetadata) => void;
  onExit: (error: PlaidLinkError | null) => void;
}) {
  const { open, ready } = usePlaidLink({
    token,
    ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
    onSuccess: (publicToken, metadata) => {
      if (publicToken) onSuccess(publicToken, metadata);
    },
    onExit: (error) => onExit(error),
  });
  useEffect(() => {
    if (ready) open();
  }, [ready, open]);
  return null;
}

const TYPES: Account['type'][] = ['checking', 'savings', 'credit', 'investment', 'loan', 'cash', 'other'];

function AccountSheet({ account, onClose, onSaved }: { account: Account | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { accounts, me, toast } = useApp();
  const [name, setName] = useState(account?.name ?? '');
  const [institution, setInstitution] = useState(account?.institution ?? '');
  const [mask, setMask] = useState(account?.mask ?? '');
  const [type, setType] = useState<Account['type']>(account?.type ?? 'checking');
  const [isCash, setIsCash] = useState(account?.isCash ?? true);
  const [hidden, setHidden] = useState(account?.hidden ?? false);
  const [owner, setOwner] = useState<number | null>(account?.ownerMemberId ?? null);
  const [balance, setBalance] = useState<number | null>(account?.currentBalanceCents ?? null);
  const [mergeInto, setMergeInto] = useState<number | null>(null);

  async function save() {
    try {
      const body = {
        name,
        institution: institution || null,
        mask: mask || null,
        type,
        isCash,
        hidden,
        ownerMemberId: owner,
        ...(account?.plaidItemId ? {} : { currentBalanceCents: balance }),
      };
      if (account) await patch(`/accounts/${account.id}`, body);
      else await post('/accounts', body);
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function merge() {
    if (!account || !mergeInto) return;
    if (!window.confirm('Move this account’s history into the synced account? Duplicates are dropped and your edits kept.')) return;
    try {
      const res = await post<{ moved: number; duplicates: number }>(`/accounts/${account.id}/merge`, { intoAccountId: mergeInto });
      toast(`Moved ${plural(res.moved, 'transaction')}, dropped ${plural(res.duplicates, 'duplicate')}`);
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function remove() {
    if (!account || !window.confirm(`Delete ${account.name} and its ${plural(account.transactionCount, 'transaction')}?`)) return;
    try {
      await del(`/accounts/${account.id}`);
      await onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title={account ? account.name : 'Add an account'}>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Chime Checking" />
      </Field>
      <div className="grid-2">
        <Field label="Bank">
          <input value={institution} onChange={(e) => setInstitution(e.target.value)} disabled={Boolean(account?.plaidItemId)} />
        </Field>
        <Field label="Last 4 digits">
          <input value={mask} onChange={(e) => setMask(e.target.value)} maxLength={4} disabled={Boolean(account?.plaidItemId)} />
        </Field>
      </div>
      <Field label="Type">
        <select value={type} onChange={(e) => setType(e.target.value as Account['type'])}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>
      {!account?.plaidItemId && (
        <Field label={type === 'credit' || type === 'loan' ? 'Amount owed' : 'Current balance'}>
          <AmountInput cents={balance} onChange={setBalance} allowNegative />
        </Field>
      )}
      <Toggle checked={isCash} onChange={setIsCash} label="Counts as spendable cash" hint="Checking and cash-management accounts. Used for the weekly forecast." />
      <Field label="Whose account">
        <select value={owner ?? ''} onChange={(e) => setOwner(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Joint</option>
          {me.members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </Field>
      <Toggle checked={hidden} onChange={setHidden} label="Hide" hint="Keeps history but hides it from pickers and balances." />
      <div className="cluster">
        <Button variant="primary" onClick={() => void save()} disabled={!name.trim()}>
          Save
        </Button>
        {account && !account.plaidItemId && (
          <Button variant="danger" onClick={() => void remove()}>
            Delete
          </Button>
        )}
      </div>

      {account && !account.plaidItemId && accounts.some((a) => a.plaidItemId) && (
        <Card>
          <h3>Now synced by the bank?</h3>
          <p className="muted small">Merge this imported account into its synced version so history isn’t doubled.</p>
          <select value={mergeInto ?? ''} onChange={(e) => setMergeInto(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Pick the synced account</option>
            {accounts
              .filter((a) => a.plaidItemId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.mask ? ` ••${a.mask}` : ''}
                </option>
              ))}
          </select>
          <Button small onClick={() => void merge()} disabled={!mergeInto}>
            Merge
          </Button>
        </Card>
      )}
      {account?.balanceUpdatedAt && (
        <p className="muted small">
          Balance {describeBalance(account.type, account.currentBalanceCents ?? 0)}
          {availableDiffers(account) && `, ${money(account.availableBalanceCents!)} available`} as of {timeAgo(account.balanceUpdatedAt)}
        </p>
      )}
    </Sheet>
  );
}
