import type { ISODate } from '../shared/dates';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PLAID_ENV: 'sandbox' | 'production';
  /** Registered OAuth redirect, e.g. https://fin.example.workers.dev/oauth-return. Optional in Sandbox. */
  PLAID_REDIRECT_URI?: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  /** 32 random bytes, base64. Encrypts Plaid access tokens at rest. */
  TOKEN_ENC_KEY?: string;
  /** https://<team>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application audience tag. */
  ACCESS_AUD?: string;
  /** Comma-separated emails allowed in (a secret). Unset: only people already in the household. */
  ALLOWED_EMAILS?: string;
  /** Local development only: act as this email without Cloudflare Access. */
  DEV_AUTH_BYPASS?: string;
}

export interface Viewer {
  memberId: number;
  email: string;
  name: string;
  hideSetup: boolean;
  powerTools: boolean;
}

export interface HouseholdSettings {
  name: string;
  timezone: string;
  lowBalanceCents: number;
  cardPayMode: 'when_made' | 'when_paid';
  funMoneyStartDate: ISODate | null;
  habitCutoffCents: number;
  categorizedAllAt: string | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    viewer: Viewer;
    household: HouseholdSettings;
    today: ISODate;
  };
};
