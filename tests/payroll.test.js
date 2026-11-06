// Run with: npm test   (or: node --test)
// Every expected number here is worked out by hand in the comments.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/payroll.js');

// Week of Monday 2026-11-02 to Sunday 2026-11-08.
const MON = '2026-11-02';
const WEEKDAYS = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];

function shop(extra) {
  return Object.assign({
    settings: { minWageCents: 725, overtimeAfterHours: 40, weekStartDay: 1 },
    workers: [
      { id: 'a', name: 'Ana' },
      { id: 'b', name: 'Beto' },
      { id: 'c', name: 'Carla' }
    ],
    items: [{ id: 'i1', sku: '48x40 #1', task: 'Repair', rateCents: 100 }],
    hours: {},
    entries: []
  }, extra);
}

function hoursEachWeekday(workerId, h) {
  const out = {};
  WEEKDAYS.forEach((d) => { out[d] = { [workerId]: h }; });
  return out;
}

function row(week, id) {
  return week.rows.find((r) => r.workerId === id);
}

test('workweek boundaries', () => {
  assert.equal(P.weekStart('2026-11-06', 1), '2026-11-02'); // Friday -> Monday
  assert.equal(P.weekStart('2026-11-08', 1), '2026-11-02'); // Sunday belongs to the week before
  assert.equal(P.weekStart('2026-11-08', 0), '2026-11-08'); // Sunday-start week
  assert.equal(P.addDays('2026-03-07', 2), '2026-03-09');   // across a daylight-saving change
});

test('piece rate with overtime: 50 h, $900 piece pay', () => {
  // regular rate = $900 / 50 h = $18.00; premium = 0.5 x $18 x 10 h = $90; gross = $990
  const data = shop({
    hours: hoursEachWeekday('a', 10),
    entries: [{ id: 'e1', date: MON, workerIds: ['a'], itemId: 'i1', count: 900 }]
  });
  const r = row(P.computeWeek(data, MON), 'a');
  assert.equal(r.hours, 50);
  assert.equal(r.pieceCents, 90000);
  assert.equal(r.topUpCents, 0);
  assert.equal(r.regularRateCents, 1800);
  assert.equal(r.overtimeHours, 10);
  assert.equal(r.regularHours, 40);
  assert.equal(r.overtimePremiumCents, 9000);
  assert.equal(r.grossCents, 99000);
});

test('minimum-wage top-up: 40 h, $250 piece pay', () => {
  // floor = $7.25 x 40 = $290; top-up = $40; no overtime; gross = $290
  const data = shop({
    hours: hoursEachWeekday('a', 8),
    entries: [{ id: 'e1', date: MON, workerIds: ['a'], itemId: 'i1', count: 250 }]
  });
  const r = row(P.computeWeek(data, MON), 'a');
  assert.equal(r.topUpCents, 4000);
  assert.equal(r.overtimePremiumCents, 0);
  assert.equal(r.grossCents, 29000);
});

test('top-up and overtime together: 45 h, $300 piece pay', () => {
  // floor = $7.25 x 45 = $326.25 -> top-up $26.25; regular rate = $7.25
  // premium = 0.5 x $7.25 x 5 = $18.125 -> $18.13; gross = $326.25 + $18.13 = $344.38
  const data = shop({
    hours: hoursEachWeekday('a', 9),
    entries: [{ id: 'e1', date: MON, workerIds: ['a'], itemId: 'i1', count: 300 }]
  });
  const r = row(P.computeWeek(data, MON), 'a');
  assert.equal(r.topUpCents, 2625);
  assert.equal(r.regularRateCents, 725);
  assert.equal(r.overtimePremiumCents, 1813);
  assert.equal(r.grossCents, 34438);
});

test('crew count is split equally', () => {
  // 90 units at $1.00 shared by 3 people = 30 units, $30 each
  const data = shop({
    hours: { [MON]: { a: 8, b: 8, c: 8 } },
    entries: [{ id: 'e1', date: MON, workerIds: ['a', 'b', 'c'], itemId: 'i1', count: 90 }]
  });
  const week = P.computeWeek(data, MON);
  ['a', 'b', 'c'].forEach((id) => {
    assert.equal(row(week, id).units, 30);
    assert.equal(row(week, id).pieceCents, 3000);
  });
});

test('a person listed twice on a crew is counted once', () => {
  const data = shop({
    hours: { [MON]: { a: 8, b: 8 } },
    entries: [{ id: 'e1', date: MON, workerIds: ['a', 'a', 'b'], itemId: 'i1', count: 100 }]
  });
  const week = P.computeWeek(data, MON);
  assert.equal(row(week, 'a').units, 50);
  assert.equal(row(week, 'b').units, 50);
});

test('the rate saved on a count wins over a later rate-card change', () => {
  const data = shop({
    hours: { [MON]: { a: 8 } },
    entries: [{ id: 'e1', date: MON, workerIds: ['a'], itemId: 'i1', count: 100, rateCents: 80 }]
  });
  data.items[0].rateCents = 120; // raised after the count was logged
  assert.equal(row(P.computeWeek(data, MON), 'a').pieceCents, 8000);
});

test('fractions of a cent in a rate', () => {
  // 3 units x 37.5 cents = 112.5 cents -> $1.13
  const data = shop({
    hours: { [MON]: { a: 1 } },
    entries: [{ id: 'e1', date: MON, workerIds: ['a'], itemId: 'i1', count: 3, rateCents: 37.5 }]
  });
  data.settings.minWageCents = 0;
  assert.equal(row(P.computeWeek(data, MON), 'a').pieceCents, 113);
});

test('counts outside the week are ignored', () => {
  const data = shop({
    hours: { [MON]: { a: 8 } },
    entries: [
      { id: 'e1', date: MON, workerIds: ['a'], itemId: 'i1', count: 300 },
      { id: 'e2', date: '2026-11-09', workerIds: ['a'], itemId: 'i1', count: 999 }
    ]
  });
  assert.equal(row(P.computeWeek(data, MON), 'a').units, 300);
});

test('warnings: counts with no hours, long day, hours with no counts', () => {
  const data = shop({
    hours: { [MON]: { b: 18 }, '2026-11-03': { c: 8 } },
    entries: [
      { id: 'e1', date: MON, workerIds: ['a'], itemId: 'i1', count: 50 },
      { id: 'e2', date: MON, workerIds: ['b'], itemId: 'i1', count: 50 }
    ]
  });
  const week = P.computeWeek(data, MON);
  assert.deepEqual(row(week, 'a').warnings.map((w) => w.code), ['dayNoHours']);
  assert.deepEqual(row(week, 'b').warnings.map((w) => w.code), ['longDay']);
  assert.deepEqual(row(week, 'c').warnings.map((w) => w.code), ['noUnits']);
  assert.equal(row(week, 'c').grossCents, 5800); // 8 h x $7.25
});

test('cost report adds up to what was paid', () => {
  const data = shop({
    items: [
      { id: 'i1', sku: '48x40 #1', task: 'Repair', rateCents: 70 },
      { id: 'i2', sku: '48x40 new', task: 'Build', rateCents: 140 }
    ],
    hours: Object.assign(hoursEachWeekday('a', 10), { [MON]: { a: 10, b: 9, c: 8 } }),
    entries: [
      { id: 'e1', date: MON, workerIds: ['a'], itemId: 'i1', count: 700 },
      { id: 'e2', date: MON, workerIds: ['a', 'b'], itemId: 'i2', count: 333 },
      { id: 'e3', date: MON, workerIds: ['c'], itemId: 'i1', count: 20 }
    ]
  });
  const week = P.computeWeek(data, MON);
  const itemLabor = week.costs.items.reduce((s, i) => s + i.laborCents, 0) + week.costs.unallocatedCents;
  assert.ok(Math.abs(itemLabor - week.totals.grossCents) <= week.rows.length,
    `items ${itemLabor} vs paid ${week.totals.grossCents}`);
});

test('payroll file', () => {
  const data = shop({
    workers: [{ id: 'a', name: 'Lopez, Ana' }, { id: 'b', name: '=HYPERLINK("x")' }],
    hours: hoursEachWeekday('a', 10), // a: 50 h
    entries: [
      { id: 'e1', date: MON, workerIds: ['a'], itemId: 'i1', count: 900 },
      { id: 'e2', date: MON, workerIds: ['b'], itemId: 'i1', count: 100 }
    ]
  });
  data.hours[MON].b = 8; // b: 8 h
  const lines = P.payrollCsv(P.computeWeek(data, MON)).trim().split('\r\n');
  assert.equal(lines[0], 'Employee ID,Employee name,Week start,Week end,Hours worked,Regular hours,Overtime hours,Units,Piece earnings,Minimum wage top-up,Regular rate,Overtime premium,Gross pay');
  assert.equal(lines[1], 'b,"\'=HYPERLINK(""x"")",2026-11-02,2026-11-08,8.00,8.00,0.00,100,100.00,0.00,12.50,0.00,100.00');
  assert.equal(lines[2], 'a,"Lopez, Ana",2026-11-02,2026-11-08,50.00,40.00,10.00,900,900.00,0.00,18.00,90.00,990.00');
});
