import type { Env } from '../env';

/**
 * Minimal Plaid REST client using fetch. The official plaid-node SDK depends on axios,
 * which doesn't run on Cloudflare Workers.
 */
const HOSTS: Record<Env['PLAID_ENV'], string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

export class PlaidError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly type: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export function plaidConfigured(env: Env): boolean {
  return Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET && env.TOKEN_ENC_KEY);
}

export async function plaid<T>(env: Env, path: string, body: Record<string, unknown>): Promise<T> {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    throw new PlaidError('NOT_CONFIGURED', 'Plaid keys are not set up yet.', 'CONFIG', 503);
  }
  const host = HOSTS[env.PLAID_ENV] ?? HOSTS.sandbox;
  const response = await fetch(`${host}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
      'PLAID-SECRET': env.PLAID_SECRET,
      'Plaid-Version': '2020-09-14',
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new PlaidError(
      String(json.error_code ?? 'UNKNOWN'),
      String(json.display_message ?? json.error_message ?? `Plaid request failed (${response.status})`),
      String(json.error_type ?? 'API_ERROR'),
      response.status,
      typeof json.request_id === 'string' ? json.request_id : undefined,
    );
  }
  return json as T;
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: 'depository' | 'credit' | 'loan' | 'investment' | 'brokerage' | 'other';
  subtype: string | null;
  balances: {
    current: number | null;
    available: number | null;
    limit: number | null;
    iso_currency_code: string | null;
  };
}

export interface PlaidTransaction {
  transaction_id: string;
  pending_transaction_id: string | null;
  account_id: string;
  amount: number;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  original_description?: string | null;
  pending: boolean;
  personal_finance_category?: { primary: string; detailed: string } | null;
}

export interface TransactionsSyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string; account_id?: string }[];
  next_cursor: string;
  has_more: boolean;
  accounts?: PlaidAccount[];
  /** NOT_READY right after linking; INITIAL_UPDATE_COMPLETE once ~30 days are in; HISTORICAL_UPDATE_COMPLETE when all history is in. */
  transactions_update_status?: 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN' | 'NOT_READY' | 'INITIAL_UPDATE_COMPLETE' | 'HISTORICAL_UPDATE_COMPLETE';
}

export interface LiabilitiesResponse {
  accounts: PlaidAccount[];
  liabilities: {
    credit?: {
      account_id: string | null;
      aprs: { apr_percentage: number; apr_type: string }[];
      minimum_payment_amount: number | null;
      next_payment_due_date: string | null;
      last_statement_balance: number | null;
    }[] | null;
    student?: {
      account_id: string | null;
      interest_rate_percentage: number;
      minimum_payment_amount: number | null;
      next_payment_due_date: string | null;
    }[] | null;
  };
}

export interface InvestmentTransaction {
  investment_transaction_id: string;
  account_id: string;
  date: string;
  name: string;
  amount: number;
  type: string;
  subtype: string;
}

/** Plaid amounts are positive for money out; the app uses negative for money out. */
export const plaidAmountToCents = (amount: number) => -Math.round(amount * 100);

/** Plaid balances are positive dollars; credit/loan balances are amounts owed. */
export const dollarsOrNull = (value: number | null | undefined) =>
  value == null ? null : Math.round(value * 100);
