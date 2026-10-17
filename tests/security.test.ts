import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncStep } from '../src/worker/plaid/sync';
import type { Env } from '../src/worker/env';
import { toCsv } from '../src/shared/import/csv';
import { api, call } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { seedBank, testEnv } from './helpers/plaid';

const YOU = 'you@example.com';
const PARTNER = 'partner@example.com';

let db: TestD1;
let env: Env;

beforeEach(() => {
  db = new TestD1();
  env = testEnv(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Signs both people in once, so each has a member row and a fun money category. */
async function twoPeople() {
  await api(env, 'GET', '/me', undefined, YOU);
  await api(env, 'GET', '/me', undefined, PARTNER);
  const id = (email: string) => db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', email)[0]!.id;
  const fun = (memberId: number) => db.rows<{ id: number }>('SELECT id FROM categories WHERE fun_member_id = ?', memberId)[0]!.id;
  const you = id(YOU);
  const partner = id(PARTNER);
  return { you, partner, yourFun: fun(you), partnerFun: fun(partner) };
}

describe('Cloudflare Access sign-in', () => {
  const TEAM = 'https://family.cloudflareaccess.com';
  const AUD = 'test-aud';
  let sign: (email: string) => Promise<string>;
  let jwk: Record<string, unknown>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    sign = (email) =>
      new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(TEAM).setAudience(AUD).setExpirationTime('5m').sign(privateKey);
  });

  // Cloudflare's signing keys.
  beforeEach(() => {
    vi.stubGlobal('fetch', async () => Response.json({ keys: [jwk] }));
  });

  const asAccess = async (email: string, extra: Partial<Env> = {}) => {
    const token = await sign(email);
    return call(
      { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...extra },
      new Request('https://fin.example.com/api/me', { headers: { 'cf-access-jwt-assertion': token } }),
    );
  };

  it('lets in only the emails on ALLOWED_EMAILS', async () => {
    const allowed = { ALLOWED_EMAILS: `${YOU}, Partner@Example.com` };
    expect((await asAccess(YOU, allowed)).status).toBe(200);
    expect((await asAccess(PARTNER, allowed)).status).toBe(200);
    expect((await asAccess('stranger@example.com', allowed)).status).toBe(403);
    expect(db.rows('SELECT email FROM members ORDER BY id')).toEqual([{ email: YOU }, { email: PARTNER }]);
  });

  it('without ALLOWED_EMAILS, lets in existing people but adds no one new', async () => {
    await asAccess(YOU, { ALLOWED_EMAILS: YOU });
    expect((await asAccess(YOU)).status).toBe(200);
    expect((await asAccess('stranger@example.com')).status).toBe(403);
    expect(db.rows('SELECT email FROM members')).toEqual([{ email: YOU }]);
  });

  it('sends security headers on API responses', async () => {
    const response = await asAccess(YOU, { ALLOWED_EMAILS: YOU });
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
  });
});

describe('static asset headers', () => {
  it('locks down the app pages', () => {
    const headers = readFileSync(join(import.meta.dirname, '../public/_headers'), 'utf8');
    expect(headers).toMatch(/^\/\*$/m);
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Strict-Transport-Security');
  });
});

describe('privacy between partners', () => {
  it('keeps private bills out of the shared check-in snapshot', async () => {
    const { you } = await twoPeople();
    db.exec(
      `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, next_date, status, private_member_id)
       VALUES ('SECRET GIFT', 'Anniversary surprise', 'yearly', -50000, '2026-10-20', 'confirmed', ?),
              ('INSURANCE', 'Car insurance', 'yearly', -90000, '2026-10-05', 'confirmed', NULL)`,
      you,
    );
    db.exec(`INSERT INTO checkins (month, status) VALUES ('2026-09', 'agreed')`);

    expect((await api(env, 'POST', '/checkins/2026-09/complete', {}, YOU)).status).toBe(200);

    const snapshot = db.rows<{ s: string }>(`SELECT snapshot_json AS s FROM checkins WHERE month = '2026-09'`)[0]!.s;
    expect(snapshot).toContain('Car insurance');
    expect(snapshot).not.toContain('Anniversary surprise');
  });

  it('only adjusts your own fun money', async () => {
    const { you, partner } = await twoPeople();
    await api(env, 'POST', '/fun/adjustments', { amountCents: 5000, memberId: partner }, YOU);
    expect(db.rows('SELECT member_id AS m FROM fun_adjustments')).toEqual([{ m: you }]);
  });

  it('exports only your own fun money adjustments', async () => {
    const { you, partner } = await twoPeople();
    db.exec(`INSERT INTO fun_adjustments (member_id, amount_cents, date, note) VALUES (?, 100, '2026-10-01', 'mine'), (?, 100, '2026-10-01', 'theirs')`, you, partner);
    const text = await (await api(env, 'GET', '/export/json', undefined, YOU)).text();
    expect(text).toContain('mine');
    expect(text).not.toContain('theirs');
  });

  it("won't let a rule edit file things into your partner's fun money", async () => {
    const { partnerFun } = await twoPeople();
    const { id } = (await (await api(env, 'POST', '/rules', { matchText: 'COFFEE', ignore: true }, YOU)).json()) as { id: number };
    expect((await api(env, 'PATCH', `/rules/${id}`, { categoryId: partnerFun }, YOU)).status).toBe(403);
  });

  it('makes a rule private when you point it at your own fun money', async () => {
    const { you, yourFun } = await twoPeople();
    const { id } = (await (await api(env, 'POST', '/rules', { matchText: 'COFFEE', ignore: true }, YOU)).json()) as { id: number };
    await api(env, 'PATCH', `/rules/${id}`, { categoryId: yourFun }, YOU);
    expect(db.rows('SELECT owner_member_id AS o, private_member_id AS p FROM rules WHERE id = ?', id)).toEqual([{ o: you, p: you }]);
  });

  it("reordering rules leaves your partner's private rules alone", async () => {
    const { partner } = await twoPeople();
    db.exec(`INSERT INTO rules (position, match_text, ignore_txn, owner_member_id, private_member_id) VALUES (500, 'THEIRS', 1, ?, ?)`, partner, partner);
    const theirs = db.rows<{ id: number }>(`SELECT id FROM rules WHERE match_text = 'THEIRS'`)[0]!.id;
    await api(env, 'POST', '/rules/reorder', { ids: [theirs] }, YOU);
    expect(db.rows('SELECT position FROM rules WHERE id = ?', theirs)).toEqual([{ position: 500 }]);
  });
});

describe('input limits and error messages', () => {
  it('caps the number of split parts', async () => {
    const { accountId } = await seedBank(db, env, 'chime');
    db.exec(`INSERT INTO transactions (account_id, date, amount_cents, name, source) VALUES (?, '2026-10-01', -3000, 'Store', 'manual')`, accountId);
    const parts = Array.from({ length: 30 }, () => ({ amountCents: -100 }));
    const response = await api(env, 'PUT', '/transactions/1/splits', { splits: parts }, YOU);
    expect(response.status).toBe(400);
  });

  it('keeps internal error details out of what the app shows', async () => {
    const { itemId } = await seedBank(db, env, 'chime');
    const result = await syncStep({ ...env, TOKEN_ENC_KEY: Buffer.alloc(32, 9).toString('base64') }, { itemId, trigger: 'manual' });
    expect(result.error).not.toMatch(/decrypt|operation|TOKEN/i);
    expect(db.rows<{ m: string }>('SELECT error_message AS m FROM plaid_items')[0]!.m).toBe(result.error);
  });
});

describe('CSV export', () => {
  it('neutralizes cells that spreadsheets would run as formulas', () => {
    const csv = toCsv([['=HYPERLINK("http://x")', '+1+1', '@SUM(A1)', '-12.34', '-cmd|x', 'Normal']]);
    expect(csv).toBe(`"'=HYPERLINK(""http://x"")",'+1+1,'@SUM(A1),-12.34,'-cmd|x,Normal`);
  });
});
