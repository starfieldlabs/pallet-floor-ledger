# What v0 assumes about pallet shops

v0 was built before visiting any shops. These are the guesses it makes. The first real shop will prove some of them wrong. Each guess says where it lives, so it can be changed quickly.

## How work is counted

1. **One count = one pallet (or one core) for one task.** Pay is a rate per pallet and task on the rate card. *Change:* Setup → Rate card.
2. **Repair tiers are separate rate-card lines** (for example "#1 repair" and "#2 repair"), not a rate per board replaced. *Change:* add lines, or a new pay unit (code: `js/payroll.js`).
3. **A crew count is split equally** among the people picked. Uneven splits (lead nailer gets more) are not supported. *Code:* `computeWeek` in `js/payroll.js`.
4. **The supervisor enters counts and hours on a phone.** There's no time clock, no worker self-entry, and no photo of the paper tally.

## How people are paid

5. **Everyone on the floor is paid by the piece.** Hourly workers (forklift, drivers) and hourly pay for non-production time (cleanup, machine down, training) are not handled.
6. **Federal rules only.** One minimum wage per shop (set in Setup), and overtime after 40 hours a week. Daily overtime states (California, Alaska, Nevada, Colorado) and city minimum wages are not handled. California is out of scope for now.
7. **Regular rate = (piece pay + top-up) ÷ all hours.** Bonuses, attendance pay and shift differentials are not included. If a shop pays them, the regular rate and overtime would be too low.
8. **The rate on a count is the rate on the day it was entered.** Changing the rate card does not change past weeks.
9. **Gross pay only.** Taxes, deductions and direct deposit stay with the shop's payroll provider.
10. **Rounding:** piece pay is rounded to the cent once per worker per week, and the overtime premium is rounded to the cent.

## How the shop runs the software

11. **A shop shares its data across devices once someone signs in.** Without signing in, the data stays in that one browser. That is how the demo works.
12. **The payroll file is a generic CSV.** Each worker's ID in the file is this app's internal ID, not the payroll provider's employee ID. Most providers will need a matching step or a provider-specific format.
13. **Workweek starts Monday** (changeable in Setup) and the yard is closed Sunday in the demo.

## How a shop shares its data

14. **Two roles: owner and supervisor.** Workers don't sign in; someone shows them the Earnings screen. *Code:* `private.can_write` in `supabase/schema.sql`.
15. **Supervisors may add workers** (a new hire shows up on a Monday) but **not change rates or settings**. Everyone in the shop can see payroll and costs. Some owners may want payroll hidden from supervisors; that is not done yet.
16. **The last change to reach the server wins**, one record at a time. Two people rarely edit the same worker's hours for the same day at the same moment.
17. **A count gets the rate the supervisor's phone knows at that moment.** The phone checks for changes about every 20 seconds, so a count entered right after the owner changes a rate can still get the old rate.
18. **Sign-in is email and password, with no email confirmation and no "forgot password" email yet.** Shop floors are unlikely to set up email links on phones. A reset is done by hand from the Supabase dashboard until email sending is set up.
19. **Each device keeps a full copy of the shop.** That is fine for a yard's counts for a year or more. A very large shop would need older weeks archived.
20. **Supabase is the server.** It is one company's hosted Postgres. The data is in plain tables (`supabase/schema.sql`), so it can be moved.

## Not legal advice

The pay method follows the standard federal piece-rate approach. A payroll provider or employment lawyer should confirm it for each state before anyone is paid from this file.
