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

Only in the browser on the computer or phone where it was entered, including when it's opened from the online link. The website only delivers the app; it never receives anyone's data. Use **Setup → Download backup** to keep a copy. v0 has no login, no server and no syncing between devices.

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

- Plain HTML, CSS and JavaScript, with no build step and no dependencies.
- `js/payroll.js`: pay rules (pure functions). `js/app.js`: screens. `js/demo.js`: demo yard. `js/i18n.js`: English and Spanish text. `js/store.js`: saving.
- Tests: `npm test` (needs Node 18+). Every expected number is worked out by hand in the test file.
