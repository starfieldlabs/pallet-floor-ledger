/*
 * Pallet Floor Ledger — a made-up yard for demos.
 *
 * 20 workers: repairers, a slow new hire (shows the minimum-wage top-up),
 * dismantlers, a sorter, and two 3-person nailing lines that log crew counts.
 * Covers last week and this week up to today. Most people work over 40 hours,
 * so overtime shows up. Two people have counts today but no hours yet, so the
 * Payroll screen has something to flag.
 */
(function (root) {
  'use strict';

  var P = root.Payroll;

  var ITEMS = [
    { id: 'i1', sku: '48x40 GMA #1', task: 'repair', rateCents: 70 },
    { id: 'i2', sku: '48x40 GMA #2', task: 'repair', rateCents: 55 },
    { id: 'i3', sku: '48x40 cores', task: 'dismantle', rateCents: 32 },
    { id: 'i4', sku: '48x40 GMA', task: 'sort', rateCents: 6 },
    { id: 'i5', sku: '48x40 combo (new)', task: 'build', rateCents: 140 },
    { id: 'i6', sku: '42x42 custom', task: 'build', rateCents: 165 },
    { id: 'i7', sku: '48x48 heavy-duty', task: 'build', rateCents: 195 }
  ];

  var TASKS = {
    en: { repair: 'Repair', dismantle: 'Dismantle', sort: 'Sort & grade', build: 'Build' },
    es: { repair: 'Reparar', dismantle: 'Desarmar', sort: 'Clasificar', build: 'Armar' }
  };

  // name, role, usual hours per day, works Saturday (hours)
  var CREW = [
    ['Juan Hernández', 'repair', 9, 0],
    ['María López', 'repair', 9, 0],
    ['José García', 'repair', 10, 6],
    ['Luis Martínez', 'repair', 9, 0],
    ['Carlos Rodríguez', 'repair', 9.5, 0],
    ['Miguel Sánchez', 'repair', 9, 0],
    ['Ana Ramírez', 'repair', 8.5, 0],
    ['Pedro Flores', 'trainee', 8, 0],
    ['Ricardo Morales', 'dismantle', 8.5, 0],
    ['DeShawn Carter', 'dismantle', 8.5, 0],
    ['Tyler Brooks', 'dismantle', 8, 0],
    ['Francisco Ortiz', 'dismantle', 8.5, 0],
    ['Samuel Díaz', 'dismantle', 8, 0],
    ['Marcus Johnson', 'sort', 9, 0],
    ['Kevin Nguyen', 'lineA', 10, 5],
    ['Brandon Lee', 'lineA', 10, 5],
    ['Rosa Gutiérrez', 'lineA', 10, 5],
    ['Alejandro Cruz', 'lineB', 9, 0],
    ['Daniel Reyes', 'lineB', 9, 0],
    ['Jorge Torres', 'lineB', 9, 0]
  ];

  // People whose hours are left blank today, to show the "check before paying" list.
  var NO_HOURS_TODAY = ['María López', 'Tyler Brooks'];

  /** Small seeded random generator, so the demo looks the same each time. */
  function seeded(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      var x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function build(todayStr, lang) {
    var es = lang === 'es';
    var rand = seeded(20261102);
    var data = root.Store.empty(es ? 'es' : 'en');
    data.demo = true;
    data.settings.shopName = es ? 'Patio de Tarimas (muestra)' : 'Demo Pallet Yard';

    data.items = ITEMS.map(function (i) {
      return { id: i.id, sku: i.sku, task: TASKS[es ? 'es' : 'en'][i.task], rateCents: i.rateCents, active: true };
    });
    var rates = {};
    ITEMS.forEach(function (i) { rates[i.id] = i.rateCents; });

    var people = CREW.map(function (c, n) {
      return { id: 'w' + (n + 1), name: c[0], role: c[1], hours: c[2], sat: c[3] };
    });
    data.workers = people.map(function (p) { return { id: p.id, name: p.name, active: true }; });

    var seq = 0;
    function addEntry(date, workerIds, itemId, count) {
      if (!(count > 0)) return;
      seq += 1;
      data.entries.push({
        id: 'e' + seq,
        date: date,
        workerIds: workerIds,
        itemId: itemId,
        count: count,
        rateCents: rates[itemId],
        createdAt: P.parseDate(date) + seq
      });
    }
    function setHours(date, workerId, h) {
      (data.hours[date] = data.hours[date] || {})[workerId] = h;
    }
    function jitter() {
      var steps = [-0.5, 0, 0, 0, 0.25];
      return steps[Math.floor(rand() * steps.length)];
    }
    function between(lo, hi) { return lo + rand() * (hi - lo); }

    var start = P.addDays(P.weekStart(todayStr, 1), -7);
    for (var d = start; d <= todayStr; d = P.addDays(d, 1)) {
      var dow = P.dayOfWeek(d);
      if (dow === 0) continue; // closed Sunday
      var saturday = dow === 6;
      var isToday = d === todayStr;

      // Individual workers
      people.forEach(function (p) {
        if (p.role === 'lineA' || p.role === 'lineB') return;
        var h = saturday ? p.sat : p.hours + jitter();
        if (!(h > 0)) return;
        if (!saturday && rand() < 0.03) return; // day off
        var f = h / p.hours;
        if (p.role === 'repair') {
          addEntry(d, [p.id], 'i1', Math.round(between(175, 240) * f));
          addEntry(d, [p.id], 'i2', Math.round(between(30, 70) * f));
        } else if (p.role === 'trainee') {
          addEntry(d, [p.id], 'i1', Math.round(between(50, 75) * f));
        } else if (p.role === 'dismantle') {
          addEntry(d, [p.id], 'i3', Math.round(between(330, 460) * f));
        } else if (p.role === 'sort') {
          addEntry(d, [p.id], 'i4', Math.round(between(1700, 2300) * f));
        }
        if (!(isToday && NO_HOURS_TODAY.indexOf(p.name) >= 0)) setHours(d, p.id, h);
      });

      // Nailing lines log one count for the whole crew.
      ['lineA', 'lineB'].forEach(function (line) {
        var crew = people.filter(function (p) { return p.role === line; });
        var base = crew[0].hours;
        var h = saturday ? crew[0].sat : base + jitter();
        if (!(h > 0)) return;
        var f = h / base;
        var ids = crew.map(function (p) { return p.id; });
        if (line === 'lineA') {
          addEntry(d, ids, 'i5', Math.round(between(430, 520) * f));
        } else if (dow <= 3) {
          addEntry(d, ids, 'i6', Math.round(between(300, 380) * f));
        } else {
          addEntry(d, ids, 'i7', Math.round(between(260, 330) * f));
        }
        ids.forEach(function (id) { setHours(d, id, h); });
      });
    }
    return data;
  }

  root.Demo = { build: build };
})(this);
