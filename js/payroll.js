/*
 * Pallet Floor Ledger — pay calculation engine.
 *
 * Pure functions, no screen code. Loaded by the app as window.Payroll and by
 * the tests through require().
 *
 * Money is in cents. A piece rate may carry a fraction of a cent
 * (37.5 = $0.375). Dates are 'YYYY-MM-DD' strings handled in UTC so a
 * daylight-saving change never moves a day.
 *
 * Pay rules: US federal (FLSA), worked out over the whole workweek.
 *   piece earnings   = sum of units credited x piece rate
 *   minimum-wage floor = minimum wage x all hours worked in the week
 *   top-up           = floor - piece earnings, when piece earnings fall short
 *   straight-time    = piece earnings + top-up
 *   regular rate     = straight-time / all hours worked
 *   overtime premium = 0.5 x regular rate x hours over the weekly threshold
 *   gross pay        = straight-time + overtime premium
 * See ASSUMPTIONS.md for what this does not cover.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Payroll = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY_MS = 86400000;
  var LONG_DAY_HOURS = 16;

  // ---------- dates ----------

  function parseDate(s) {
    var p = String(s).split('-');
    return Date.UTC(+p[0], +p[1] - 1, +p[2]);
  }

  function formatDate(ms) {
    var d = new Date(ms);
    var m = d.getUTCMonth() + 1;
    var day = d.getUTCDate();
    return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function addDays(s, n) {
    return formatDate(parseDate(s) + n * DAY_MS);
  }

  /** 0 = Sunday ... 6 = Saturday */
  function dayOfWeek(s) {
    return new Date(parseDate(s)).getUTCDay();
  }

  /** First day of the workweek that contains `date`. */
  function weekStart(date, weekStartDay) {
    var back = (dayOfWeek(date) - weekStartDay + 7) % 7;
    return addDays(date, -back);
  }

  function weekDates(start) {
    var out = [];
    for (var i = 0; i < 7; i++) out.push(addDays(start, i));
    return out;
  }

  // ---------- helpers ----------

  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  function byId(list) {
    var map = {};
    (list || []).forEach(function (x) { map[x.id] = x; });
    return map;
  }

  function unique(ids) {
    var seen = {};
    var out = [];
    (ids || []).forEach(function (id) {
      if (id && !seen[id]) { seen[id] = true; out.push(id); }
    });
    return out;
  }

  /** The rate saved on the entry wins, so changing the rate card never rewrites past weeks. */
  function rateFor(entry, itemsById) {
    if (typeof entry.rateCents === 'number') return entry.rateCents;
    var item = itemsById[entry.itemId];
    return item ? Number(item.rateCents) || 0 : 0;
  }

  // ---------- the week ----------

  /**
   * Work out pay for every worker in the workweek that contains `date`.
   *
   * data = {
   *   settings: { minWageCents, overtimeAfterHours, weekStartDay },
   *   workers:  [{ id, name }],
   *   items:    [{ id, sku, task, rateCents }],
   *   hours:    { 'YYYY-MM-DD': { workerId: hours } },
   *   entries:  [{ id, date, workerIds: [...], itemId, count, rateCents }]
   * }
   * An entry with several workers is a crew count, split equally among them.
   */
  function computeWeek(data, date) {
    var s = data.settings;
    var start = weekStart(date, s.weekStartDay);
    var dates = weekDates(start);
    var inWeek = {};
    dates.forEach(function (d) { inWeek[d] = true; });

    var itemsById = byId(data.items);
    var workersById = byId(data.workers);
    var rows = {};

    function rowFor(id) {
      if (!rows[id]) {
        var w = workersById[id];
        var r = {
          workerId: id,
          name: w ? w.name : '?',
          hours: 0,
          units: 0,
          pieceExact: 0,
          lines: {},
          days: {},
          warnings: []
        };
        dates.forEach(function (d) { r.days[d] = { hours: 0, units: 0, pieceExact: 0 }; });
        rows[id] = r;
      }
      return rows[id];
    }

    var hours = data.hours || {};
    dates.forEach(function (d) {
      var day = hours[d] || {};
      Object.keys(day).forEach(function (wid) {
        var h = Number(day[wid]);
        if (!(h > 0)) return;
        var r = rowFor(wid);
        r.hours += h;
        r.days[d].hours += h;
      });
    });

    (data.entries || []).forEach(function (e) {
      if (!inWeek[e.date]) return;
      var crew = unique(e.workerIds);
      var count = Number(e.count);
      if (!crew.length || !(count > 0)) return;
      var rate = rateFor(e, itemsById);
      var share = count / crew.length;
      crew.forEach(function (wid) {
        var r = rowFor(wid);
        var pay = share * rate;
        r.units += share;
        r.pieceExact += pay;
        var line = r.lines[e.itemId] || (r.lines[e.itemId] = { itemId: e.itemId, units: 0, pieceExact: 0 });
        line.units += share;
        line.pieceExact += pay;
        r.days[e.date].units += share;
        r.days[e.date].pieceExact += pay;
      });
    });

    var list = Object.keys(rows).map(function (id) { return finishRow(rows[id], s, dates); });
    list.sort(function (a, b) { return a.name.localeCompare(b.name); });

    return {
      start: start,
      end: dates[6],
      dates: dates,
      rows: list,
      totals: totalsFor(list),
      costs: costReport(list, itemsById)
    };
  }

  function finishRow(r, s, dates) {
    var hours = round2(r.hours);
    r.hours = hours;
    r.pieceCents = Math.round(r.pieceExact);

    if (hours > 0) {
      var floor = Math.round(s.minWageCents * hours);
      r.topUpCents = Math.max(0, floor - r.pieceCents);
      r.straightCents = r.pieceCents + r.topUpCents;
      r.regularRateCents = r.straightCents / hours;
      r.overtimeHours = Math.max(0, round2(hours - s.overtimeAfterHours));
      r.overtimePremiumCents = Math.round(0.5 * r.regularRateCents * r.overtimeHours);
    } else {
      // Counts with no hours: the minimum-wage check and overtime cannot be worked out.
      r.topUpCents = 0;
      r.straightCents = r.pieceCents;
      r.regularRateCents = null;
      r.overtimeHours = 0;
      r.overtimePremiumCents = 0;
    }
    r.regularHours = round2(hours - r.overtimeHours);
    r.grossCents = r.straightCents + r.overtimePremiumCents;

    dates.forEach(function (d) {
      var day = r.days[d];
      if (day.units > 0 && !(day.hours > 0)) r.warnings.push({ code: 'dayNoHours', date: d });
      if (day.hours > LONG_DAY_HOURS) r.warnings.push({ code: 'longDay', date: d, hours: round2(day.hours) });
    });
    if (hours > 0 && r.units === 0) r.warnings.push({ code: 'noUnits' });
    return r;
  }

  function totalsFor(rows) {
    var t = {
      hours: 0, overtimeHours: 0, units: 0,
      pieceCents: 0, topUpCents: 0, overtimePremiumCents: 0, grossCents: 0,
      warnings: 0
    };
    rows.forEach(function (r) {
      t.hours += r.hours;
      t.overtimeHours += r.overtimeHours;
      t.units += r.units;
      t.pieceCents += r.pieceCents;
      t.topUpCents += r.topUpCents;
      t.overtimePremiumCents += r.overtimePremiumCents;
      t.grossCents += r.grossCents;
      t.warnings += r.warnings.length;
    });
    t.hours = round2(t.hours);
    t.overtimeHours = round2(t.overtimeHours);
    t.unitsPerHour = t.hours > 0 ? t.units / t.hours : null;
    t.laborPerUnitCents = t.units > 0 ? t.grossCents / t.units : null;
    return t;
  }

  /**
   * Labor cost by pallet and task. Each worker's top-up and overtime premium is
   * shared across their work in proportion to piece pay, so the cost per unit
   * reflects what the shop actually paid.
   */
  function costReport(rows, itemsById) {
    var by = {};
    var unallocatedCents = 0;
    rows.forEach(function (r) {
      var extra = r.topUpCents + r.overtimePremiumCents;
      Object.keys(r.lines).forEach(function (id) {
        var line = r.lines[id];
        var b = by[id] || (by[id] = { itemId: id, units: 0, pieceExact: 0, extraExact: 0 });
        b.units += line.units;
        b.pieceExact += line.pieceExact;
        if (r.pieceExact > 0) b.extraExact += extra * (line.pieceExact / r.pieceExact);
      });
      if (!(r.pieceExact > 0)) unallocatedCents += extra;
    });

    var items = Object.keys(by).map(function (id) {
      var b = by[id];
      var item = itemsById[id] || {};
      var labor = b.pieceExact + b.extraExact;
      return {
        itemId: id,
        sku: item.sku || '?',
        task: item.task || '?',
        rateCents: item.rateCents,
        units: b.units,
        pieceCents: Math.round(b.pieceExact),
        extraCents: Math.round(b.extraExact),
        laborCents: Math.round(labor),
        perUnitCents: b.units > 0 ? labor / b.units : null
      };
    });
    items.sort(function (a, b) { return b.laborCents - a.laborCents; });
    return { items: items, unallocatedCents: unallocatedCents };
  }

  // ---------- payroll file ----------

  function dollars(cents) {
    return (cents / 100).toFixed(2);
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    // Stop a spreadsheet from reading a name as a formula.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function payrollCsv(week) {
    var lines = [[
      'Employee ID', 'Employee name', 'Week start', 'Week end',
      'Hours worked', 'Regular hours', 'Overtime hours', 'Units',
      'Piece earnings', 'Minimum wage top-up', 'Regular rate', 'Overtime premium', 'Gross pay'
    ]];
    week.rows.forEach(function (r) {
      lines.push([
        r.workerId, r.name, week.start, week.end,
        r.hours.toFixed(2), r.regularHours.toFixed(2), r.overtimeHours.toFixed(2), round2(r.units),
        dollars(r.pieceCents), dollars(r.topUpCents),
        r.regularRateCents == null ? '' : dollars(Math.round(r.regularRateCents)),
        dollars(r.overtimePremiumCents), dollars(r.grossCents)
      ]);
    });
    return lines.map(function (l) { return l.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  return {
    parseDate: parseDate,
    formatDate: formatDate,
    addDays: addDays,
    dayOfWeek: dayOfWeek,
    weekStart: weekStart,
    weekDates: weekDates,
    computeWeek: computeWeek,
    payrollCsv: payrollCsv,
    dollars: dollars,
    round2: round2
  };
});
