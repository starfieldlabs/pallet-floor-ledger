# What v0 assumes about pallet shops

v0 was built before visiting any shops. These are the guesses it makes. The first real shop will prove some of them wrong. Each guess says where it lives, so it can be changed quickly.

## How work is counted

1. **One count = one pallet (or one core) for one task.** Pay is a rate per pallet and task on the rate card. *Change:* Setup → Rate card.
2. **Repair tiers are separate rate-card lines** (for example "#1 repair" and "#2 repair"), not a rate per board replaced. *Change:* add lines, or a new pay unit (code: `js/payroll.js`).
3. **A crew count is split equally** among the people picked. Uneven splits (lead nailer gets more) are not supported. *Code:* `computeWeek` in `js/payroll.js`.
4. **The supervisor enters counts and hours.** There's no time clock, no worker self-entry, and no photo of the paper tally.

## How people are paid

5. **Everyone on the floor is paid by the piece.** Hourly workers (forklift, drivers) and hourly pay for non-production time (cleanup, machine down, training) are not handled.
6. **Federal rules only.** One minimum wage per shop (set in Setup), and overtime after 40 hours a week. Daily overtime states (California, Alaska, Nevada, Colorado) and city minimum wages are not handled. California is out of scope for now.
7. **Regular rate = (piece pay + top-up) ÷ all hours.** Bonuses, attendance pay and shift differentials are not included. If a shop pays them, the regular rate and overtime would be too low.
8. **The rate on a count is the rate on the day it was entered.** Changing the rate card does not change past weeks.
9. **Gross pay only.** Taxes, deductions and direct deposit stay with the shop's payroll provider.
10. **Rounding:** piece pay is rounded to the cent once per worker per week, and the overtime premium is rounded to the cent.

## How the shop runs the software

11. **One device, no login.** Data stays in that browser. Use backup and restore to move it.
12. **The payroll file is a generic CSV.** Each worker's ID in the file is this app's internal ID, not the payroll provider's employee ID. Most providers will need a matching step or a provider-specific format.
13. **Workweek starts Monday** (changeable in Setup) and the yard is closed Sunday in the demo.

## Not legal advice

The pay method follows the standard federal piece-rate approach. A payroll provider or employment lawyer should confirm it for each state before anyone is paid from this file.
