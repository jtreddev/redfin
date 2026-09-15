# Setup

Everything here runs on free tiers: Cloudflare (hosting, database, login) and Plaid's Trial plan (bank sync). Budget about an hour for the whole thing, most of it waiting on sign-ups.

## 1. Run it on your computer first

```powershell
cd C:\Users\james\fin
npm install
Copy-Item .dev.vars.example .dev.vars
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # paste into TOKEN_ENC_KEY in .dev.vars
npm run db:migrate:local
npm run dev
```

Open the address it prints (usually http://localhost:5173). `DEV_AUTH_BYPASS` in `.dev.vars` signs you in as that email. To test what your partner sees, go to **More › Local testing** and switch to a second email.

Without Plaid keys, everything works except bank sync: use **More › Import a file**.

## 2. Plaid (free bank sync)

Your first Plaid account only offered paid plans, so it isn't eligible for the free Trial.

1. Go to **dashboard.plaid.com/signup** and create a **new** team (your own name is fine as the company).
2. **Do not** click anything like "Request production access" or "Get production". That starts the paid Pay-as-you-go application, and an account that has applied can no longer get the Trial.
3. Look for the **Trial** plan: free, no card, 10 bank logins, includes Transactions, Liabilities and Investments. If you still only see paid plans, open a support ticket asking to be put on the Trial plan for personal use.
4. **Developers › Keys**: copy the `client_id` and the **Sandbox** secret into `.dev.vars` (`PLAID_CLIENT_ID`, `PLAID_SECRET`). Keep `PLAID_ENV` as `sandbox` in `wrangler.jsonc` while testing.
5. Restart `npm run dev`, then **More › Accounts & banks › Connect a bank**. In Sandbox, pick any bank and sign in with `user_good` / `pass_good`.

You'll need 3–4 of the 10 free logins: Chime, Capital One, Fidelity, plus the Fidelity Rewards Visa (issued by Elan) if you have it.

## 3. Put it online (Cloudflare, free)

```powershell
npx wrangler login
npx wrangler d1 create fin
```

1. Copy the `database_id` it prints into `wrangler.jsonc` (replace the zeros).
2. Create the database tables and deploy:

   ```powershell
   npm run db:migrate:remote
   npm run deploy
   ```

   The app is now at `https://fin.<your-subdomain>.workers.dev`. Every request is refused until the next step (that's intended).

3. **Lock it to the two of you** with Cloudflare Access (free for up to 50 users):
   - Cloudflare dashboard › **Workers & Pages** › `fin` › **Settings › Domains & Routes**: turn on **Cloudflare Access** for the workers.dev route.
   - In **Zero Trust › Access › Applications**, open that application › **Policies**: one Allow policy with **Emails** = your email and your partner's email.
   - Note the **team domain** (`https://<team>.cloudflareaccess.com`) and the application's **AUD tag**.
   - Put them in `wrangler.jsonc` under `vars`: `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.
4. Add the secrets (each command prompts for the value):

   ```powershell
   npx wrangler secret put TOKEN_ENC_KEY      # a NEW random key; save it in your password manager
   npx wrangler secret put PLAID_CLIENT_ID
   npx wrangler secret put PLAID_SECRET
   ```

   Never set `DEV_AUTH_BYPASS` online; the app refuses to run if you do.
5. `npm run deploy` again.

## 4. Switch Plaid to your real banks

1. In Plaid **Developers › API › Allowed redirect URIs**, add `https://fin.<your-subdomain>.workers.dev/oauth-return`.
2. In `wrangler.jsonc`, set `PLAID_ENV` to `production` and add `"PLAID_REDIRECT_URI": "https://fin.<your-subdomain>.workers.dev/oauth-return"` under `vars`.
3. `npx wrangler secret put PLAID_SECRET` with the **Production** secret, then `npm run deploy`.
4. **From a computer browser**, open the app › More › Accounts & banks › **Connect a bank**, once each for Chime, Capital One, and Fidelity. Chime and Capital One send you to their own sites to approve access. It pulls up to 2 years of history.
5. After the first sync:
   - Look at a few Fidelity transactions. Core-fund sweep rows ("REDEMPTION FROM CORE ACCOUNT…") should show as left out. If others slip through, add an ignore rule (More › Rules).
   - Open a paycheck deposit, copy a distinctive word from its description (like the employer name) into **More › Income & paydays › Words in the deposit description**.
   - **Plan › Bills › Find them** to detect subscriptions and bills; confirm the real ones.
   - If you imported CSVs before connecting, open that old account and **Merge** it into the synced one.

Bank data syncs automatically every morning (a small step every 15 minutes between about 5 and 9 am US time). The **Sync** button on Home does it on demand.

## 5. Install on both phones

Open the app URL and sign in with your email (Cloudflare emails you a code).
- **iPhone (Safari):** Share › **Add to Home Screen**.
- **Android (Chrome):** menu › **Install app**.

## 6. First sit-down together (30 minutes)

1. **More › Income & paydays**: add the paycheck.
2. **Plan › Budget**: "Use starter amounts", then adjust every line together.
3. **More › Fun money**: agree on an equal allowance per payday for each of you. Pick your personal card if you have one.
4. **More › Kids**: add the kids.
5. Sort the "Needs category" list. Say yes when it offers to make rules.
6. On the 1st of each month, Home reminds you to do the **Monthly check-in**.

## Maintenance

- **Backups:** `npm run backup` saves the whole database to `backups\`. Weekly is good. **More › Export** downloads your data too.
- **Bank asks you to sign in again:** Home shows a banner; tap Fix › Reconnect.
- **Tests:** `npm test` and `npm run typecheck`.
- **Lost TOKEN_ENC_KEY:** set a new one and reconnect each bank. History stays.
