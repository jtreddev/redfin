import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { GROUPS } from '../../shared/categorySet';
import { todayIn } from '../../shared/dates';
import type { AppEnv, Env, HouseholdSettings, Viewer } from '../env';
import { first, run } from '../lib/db';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(teamDomain: string) {
  let set = jwksByTeam.get(teamDomain);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeam.set(teamDomain, set);
  }
  return set;
}

/** Accepts the team domain as pasted: with or without https:// and a trailing slash. */
function normalizeTeamDomain(value: string) {
  const domain = value.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

async function emailFromAccess(env: Env, token: string | undefined): Promise<string | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  if (!token) {
    console.error('Access sign-in failed: no Cf-Access-Jwt-Assertion header (is Access turned on for this address?)');
    return null;
  }
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  try {
    const { payload } = await jwtVerify(token, jwks(teamDomain), {
      issuer: teamDomain,
      audience: env.ACCESS_AUD.trim(),
    });
    return typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
  } catch (error) {
    // Shows in `npx wrangler tail`; usually a wrong ACCESS_TEAM_DOMAIN or ACCESS_AUD.
    console.error(`Access sign-in failed for team ${teamDomain}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Every /api request must carry a valid Cloudflare Access token (Access only lets the
 * two of you through). Locally, DEV_AUTH_BYPASS stands in, and a deployed Worker with
 * that setting refuses to serve anything.
 */
export const requireViewer: MiddlewareHandler<AppEnv> = async (c, next) => {
  const env = c.env;
  const url = new URL(c.req.url);
  const isLocal = LOCAL_HOSTS.has(url.hostname);

  let email: string | null;
  if (env.DEV_AUTH_BYPASS) {
    if (!isLocal) return c.json({ error: 'DEV_AUTH_BYPASS must not be set on a deployed Worker.' }, 500);
    email = (c.req.header('x-dev-user') || env.DEV_AUTH_BYPASS).toLowerCase();
  } else {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
      return c.json({ error: 'Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD).' }, 500);
    }
    email = await emailFromAccess(env, c.req.header('cf-access-jwt-assertion'));
  }
  if (!email) return c.json({ error: 'Not signed in' }, 401);

  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin && origin !== url.origin) return c.json({ error: 'Cross-site request blocked' }, 403);
  }

  // Access decides who reaches the app; this list is a second lock in case that policy is ever loosened.
  // Without a list, only people already in the household get in.
  const allowed = env.ALLOWED_EMAILS?.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const existing = await first<ViewerRow>(env.DB, 'SELECT id AS memberId, email, name, hide_setup AS hideSetup, power_tools AS powerTools, hide_amounts AS hideAmounts FROM members WHERE email = ?', email);
  if (!env.DEV_AUTH_BYPASS && (allowed ? !allowed.includes(email) : !existing)) {
    return c.json({ error: 'This email isn’t part of this household. Ask to be added to ALLOWED_EMAILS.' }, 403);
  }
  const viewer = toViewer(existing ?? (await createMember(env.DB, email)));

  const household = await first<HouseholdSettings>(
    env.DB,
    `SELECT name, timezone, low_balance_cents AS lowBalanceCents, card_pay_mode AS cardPayMode,
            fun_money_start_date AS funMoneyStartDate, habit_cutoff_cents AS habitCutoffCents,
            categorized_all_at AS categorizedAllAt
       FROM household WHERE id = 1`,
  );
  if (!household) return c.json({ error: 'Database is not initialized. Run the migrations.' }, 500);

  c.set('viewer', viewer);
  c.set('household', household);
  c.set('today', todayIn(household.timezone));
  await next();
};

type ViewerRow = Omit<Viewer, 'hideSetup' | 'powerTools' | 'hideAmounts'> & { hideSetup: number; powerTools: number; hideAmounts: number };
const toViewer = (row: ViewerRow): Viewer => ({ ...row, hideSetup: row.hideSetup === 1, powerTools: row.powerTools === 1, hideAmounts: row.hideAmounts === 1 });

/** First sign-in for someone Access let through: add them and give them a fun money category. */
async function createMember(db: D1Database, email: string): Promise<ViewerRow> {
  const local = email.split('@')[0] ?? email;
  const name = local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()).trim() || 'Me';
  const colors = ['#3b6fd8', '#c2467a', '#2e9e6b', '#8a5cd6'];
  const count = (await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM members'))?.n ?? 0;
  await run(db, 'INSERT OR IGNORE INTO members (email, name, color) VALUES (?, ?, ?)', email, name, colors[count % colors.length]);
  const member = await first<ViewerRow>(db, 'SELECT id AS memberId, email, name, hide_setup AS hideSetup, power_tools AS powerTools, hide_amounts AS hideAmounts FROM members WHERE email = ?', email);
  if (!member) throw new Error('Could not create member');
  await run(
    db,
    `INSERT OR IGNORE INTO categories (section_id, name, kind, fun_member_id, sort)
     SELECT id, ?, 'expense', ?, ? FROM sections WHERE name = ?`,
    `${name}'s Fun Money`,
    member.memberId,
    member.memberId,
    GROUPS.fun,
  );
  return member;
}
