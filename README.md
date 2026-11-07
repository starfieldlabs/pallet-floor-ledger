# Pallet Floor Ledger — v0

The supervisor logs each worker's daily production. On Friday the owner downloads a ready-to-pay piece-rate payroll file and sees labor cost per pallet.

This is the first wedge of the pallet-yard operating system: **Floor ledger → piece-rate pay**.

## How to open it

**Online:** https://starfieldlabs.github.io/pallet-floor-ledger/ works on any phone or computer.

**On this computer:** double-click `index.html`. It opens in your web browser, with nothing to install and no internet needed.

The first time it opens, it loads a **demo yard**: 20 made-up workers with last week's and this week's counts. To start your own shop, go to **Setup → Erase everything**.

## The five screens

| Screen | Who uses it | What it does |
|---|---|---|
| **Tally** | Yard supervisor | Pick the day, then add counts: pallet + task, count, who did it. Pick several people for a crew count and it splits equally. Enter each person's hours for the day. |
| **Payroll** | Owner / office | The week's pay for every worker: piece pay, minimum-wage top-up, overtime premium, gross. A "check before paying" list flags missing hours. Downloads a CSV for the payroll provider. |
| **Costs** | Owner | Units, man-hours, units per man-hour, and labor cost per unit for each pallet and task, including overtime and top-up. |
| **Earnings** | Worker | One person's piece pay so far this week, day by day. |
| **Setup** | Owner | Shop name, minimum wage, overtime threshold, workweek start day, workers, rate card, backup and restore. |

English and Spanish: the **EN / ES** switch at the top right.

## Where the data lives

There are two ways to use it:

- **This device only** (the demo, or "Keep using this device only"): everything stays in this browser. Nothing is sent anywhere. Use **Setup → Download backup** to keep a copy.
- **A shared shop** (after signing in): the supervisor's phone and the office computer see the same counts. The data is kept in the shop's account on the server and also on each device, so the supervisor can keep entering counts with no signal.

Shared shops are switched on: `js/config.js` points at the Supabase project **pallet-floor-ledger** (organization *starfieldlabs*, US East). Emptying the two values in that file turns sharing off again, and the app goes back to v0's no-sign-in, this-device-only mode.

## Shared shops: how a shop uses them

1. **The owner** opens the app, taps **Create an account**, then **Start a new shop**. If they were already using the app on that device, they can copy those workers, rates and counts into the new shop.
2. **Setup → People with access → Create invite** makes a one-time code and link, good for 7 days. The owner texts it to the supervisor.
3. **The supervisor** opens the link on their phone, creates an account and is in the shop. Spanish or English is each person's own choice.
4. The line under the shop name says whether everything has reached the server: **All changes saved**, **Saving…**, or **Offline · 3 waiting to send**. Waiting changes are kept on the phone, even if it is turned off, and go out when the signal returns.

| | Owner | Supervisor |
|---|---|---|
| Enter counts and hours, add workers | ✓ | ✓ |
| See payroll, costs, earnings | ✓ | ✓ |
| Change the rate card and shop settings | ✓ | |
| Invite and remove people, restore a backup | ✓ | |

The server enforces this, not just the app: a supervisor's phone that tried to change a rate would be refused and the rate put back.

If two people change the *same* thing (the same worker's hours on the same day), the change that reaches the server last wins. Different things never overwrite each other.

## Turning on shared shops (one-time; already done for the project above)

To set up another project, for example a separate test project:

1. Create a project at [supabase.com](https://supabase.com) (the free plan is enough to start).
2. **SQL Editor → New query**: paste all of [`supabase/schema.sql`](supabase/schema.sql) and run it. It creates the tables and the access rules.
3. **Authentication → Sign In / Providers → Email**: turn **off** "Confirm email". (Supabase's built-in email only sends to your own team, so confirmation emails would never reach a shop.)
4. **Project Settings → API**: copy the **Project URL** and the **publishable** (or "anon") key into [`js/config.js`](js/config.js). Never use the secret / service_role key there.
5. Push to `main`. The site updates within a couple of minutes.

Good to know before real shops depend on it:

- Supabase pauses free projects after a week with no use. Move to the paid plan before the first paying shop.
- There is no "forgot password" email yet; it needs email sending set up (custom SMTP). Until then, reset a password from the Supabase dashboard (**Authentication → Users**).
- `npm run test:db` checks the access rules in `supabase/schema.sql` on a local Postgres, no Supabase project needed. Run it after any change to that file.

## Publishing changes

The online version is served by GitHub Pages from the `main` branch of `starfieldlabs/pallet-floor-ledger`. Pushing to `main` updates the site within a minute or two.

## How the pay is worked out

US federal rules, over the whole workweek:

1. **Piece pay** = units × piece rate (a crew count is split equally).
2. **Minimum-wage top-up**: if piece pay ÷ hours is below the minimum wage, the shortfall is added.
3. **Regular rate** = (piece pay + top-up) ÷ all hours worked.
4. **Overtime premium** = ½ × regular rate × hours over 40.
5. **Gross pay** = piece pay + top-up + overtime premium.

Example: 50 hours and $900 piece pay → regular rate $18.00 → overtime premium ½ × $18 × 10 = $90 → gross $990.

**Before paying real people from this:** run it next to your current payroll for at least two weeks, and have your payroll provider or accountant confirm the method for your state.

What v0 guesses about how shops work is listed in [ASSUMPTIONS.md](ASSUMPTIONS.md).

## For developers

- Plain HTML, CSS and JavaScript, with no build step and no third-party code in the app.
- `js/payroll.js`: pay rules (pure functions). `js/app.js`: screens. `js/demo.js`: demo yard. `js/i18n.js`: English and Spanish text. `js/store.js`: saving for "this device only".
- `js/sync.js`: keeps a shared shop the same on every device (outbox of unsent changes, record-by-record merge). `js/cloud.js`: sign-in and database calls to Supabase over plain `fetch`. `js/config.js`: which Supabase project.
- `supabase/schema.sql`: tables and access rules. `supabase/check-rules.mjs`: tests for those rules.
- Tests: `npm test` (needs Node 18+) for pay rules, syncing and the Supabase connection. Every expected pay number is worked out by hand in the test file. `npm install` then `npm run test:db` for the database rules.
