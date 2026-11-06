/* Pallet Floor Ledger — screens and what the buttons do. */
(function () {
  'use strict';

  var P = window.Payroll;
  var MAX_COUNT = 100000;
  var TABS = ['tally', 'payroll', 'costs', 'earnings', 'setup'];
  var TAB_LABEL = { tally: 'tabTally', payroll: 'tabPayroll', costs: 'tabCosts', earnings: 'tabEarnings', setup: 'tabSetup' };

  // ---------- small helpers ----------

  function $(sel) { return document.querySelector(sel); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function defaultLang() {
    try { return /^es\b/i.test(navigator.language || '') ? 'es' : 'en'; } catch (e) { return 'en'; }
  }
  function prefGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function prefSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* not important */ } }
  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- state ----------

  var loaded = Store.load();
  var data = loaded.data;
  var startupNotice = null;
  if (!data) {
    data = Demo.build(today(), defaultLang());
    if (loaded.status === 'corrupt') startupNotice = 'storageDamaged';
    if (!Store.save(data)) startupNotice = 'saveFailed';
  }

  var ui = {
    tab: 'tally',
    tallyDate: today(),
    weekDate: today(),
    draft: { itemId: '', count: '', workerIds: [] },
    earningsWorker: ''
  };
  var savedTab = prefGet('pfl.tab');
  if (TABS.indexOf(savedTab) >= 0) ui.tab = savedTab;

  function t(key, vars) { return I18N.t(data.settings.lang, key, vars); }
  function locale() { return data.settings.lang === 'es' ? 'es-US' : 'en-US'; }

  function persist(quiet) {
    var ok = Store.save(data);
    if (!ok) toast(t('saveFailed'), true);
    else if (!quiet) toast(t('saved'));
    return ok;
  }

  // ---------- formatting ----------

  function money(cents) {
    if (cents == null) return '—';
    return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }
  function rateText(cents) {
    return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  }
  /** Rate for an edit box: always cents, a third decimal only when needed (0.70, 0.375). */
  function rateInputValue(cents) {
    return (cents / 100).toFixed(Math.round(cents * 10) % 10 ? 3 : 2);
  }
  function num(x, digits) {
    if (x == null) return '—';
    return Number(x).toLocaleString(locale(), { maximumFractionDigits: digits == null ? 1 : digits });
  }
  function dateText(s, opts) {
    var o = { timeZone: 'UTC' };
    for (var k in opts) o[k] = opts[k];
    return new Date(P.parseDate(s)).toLocaleDateString(locale(), o);
  }
  function dayShort(s) { return dateText(s, { weekday: 'short', month: 'short', day: 'numeric' }); }
  function dayLong(s) { return dateText(s, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }

  // ---------- lookups ----------

  function activeWorkers() {
    return data.workers.filter(function (w) { return w.active !== false; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function activeItems() {
    return data.items.filter(function (i) { return i.active !== false; });
  }
  function workerName(id) {
    for (var i = 0; i < data.workers.length; i++) if (data.workers[i].id === id) return data.workers[i].name;
    return '?';
  }
  function findItem(id) {
    for (var i = 0; i < data.items.length; i++) if (data.items[i].id === id) return data.items[i];
    return null;
  }
  function itemLabel(item) {
    return item.sku + ' · ' + item.task + ' · ' + rateText(item.rateCents);
  }

  // ---------- toast ----------

  var toastTimer;
  function toast(msg, isError) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, isError ? 5000 : 1800);
  }

  // ---------- render ----------

  function render() {
    document.documentElement.lang = data.settings.lang;
    $('#shop-name').textContent = data.settings.shopName || t('unnamedShop');

    var group = $('#lang-group');
    group.setAttribute('aria-label', t('language'));
    Array.prototype.forEach.call(group.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === data.settings.lang));
    });

    $('#tabs').innerHTML = TABS.map(function (k) {
      return '<button type="button" data-action="tab" data-tab="' + k + '"' +
        (ui.tab === k ? ' aria-current="page"' : '') + '>' + esc(t(TAB_LABEL[k])) + '</button>';
    }).join('');

    $('#banner').innerHTML = data.demo ? '<div class="banner">' + esc(t('demoBanner')) + '</div>' : '';

    var views = { tally: viewTally, payroll: viewPayroll, costs: viewCosts, earnings: viewEarnings, setup: viewSetup };
    $('#view').innerHTML = views[ui.tab]();
  }

  // ---------- Tally ----------

  function viewTally() {
    var d = ui.tallyDate;
    var workers = activeWorkers();
    var items = activeItems();

    var html =
      '<section class="card">' +
        '<div class="datebar">' +
          '<button type="button" class="btn icon" data-action="day-shift" data-n="-1" aria-label="' + esc(t('prevDay')) + '">‹</button>' +
          '<input type="date" value="' + d + '" data-change="tally-date" aria-label="' + esc(t('jumpTo')) + '">' +
          '<button type="button" class="btn icon" data-action="day-shift" data-n="1" aria-label="' + esc(t('nextDay')) + '">›</button>' +
          (d !== today() ? '<button type="button" class="btn ghost" data-action="day-today">' + esc(t('today')) + '</button>' : '') +
        '</div>' +
        '<p class="datelong">' + esc(dayLong(d)) + '</p>' +
      '</section>';

    if (!workers.length || !items.length) {
      return html +
        '<section class="card"><p>' + esc(t('needSetup')) + '</p>' +
        '<button type="button" class="btn primary" data-action="tab" data-tab="setup">' + esc(t('tabSetup')) + '</button></section>';
    }

    // Forget draft picks that are no longer active.
    var activeIds = {};
    workers.forEach(function (w) { activeIds[w.id] = true; });
    ui.draft.workerIds = ui.draft.workerIds.filter(function (id) { return activeIds[id]; });
    if (ui.draft.itemId && !items.some(function (i) { return i.id === ui.draft.itemId; })) ui.draft.itemId = '';

    var options = '<option value="">' + esc(t('chooseItem')) + '</option>' + items.map(function (i) {
      return '<option value="' + esc(i.id) + '"' + (i.id === ui.draft.itemId ? ' selected' : '') + '>' + esc(itemLabel(i)) + '</option>';
    }).join('');

    var chips = workers.map(function (w) {
      var on = ui.draft.workerIds.indexOf(w.id) >= 0;
      return '<button type="button" class="chip" data-action="toggle-worker" data-id="' + esc(w.id) + '" aria-pressed="' + on + '">' + esc(w.name) + '</button>';
    }).join('');

    html +=
      '<section class="card">' +
        '<h2>' + esc(t('addCount')) + '</h2>' +
        '<form data-submit="add-count" novalidate>' +
          '<div class="row2">' +
            '<label class="field">' + esc(t('item')) + '<select data-input="draft-item">' + options + '</select></label>' +
            '<label class="field">' + esc(t('count')) +
              '<input type="number" inputmode="numeric" min="1" step="1" value="' + esc(ui.draft.count) + '" data-input="draft-count"></label>' +
          '</div>' +
          '<fieldset><legend>' + esc(t('workers')) + '</legend>' +
            '<div class="chips">' + chips + '</div>' +
            '<p class="hint">' + esc(t('crewHint')) + '</p>' +
          '</fieldset>' +
          '<p class="form-error" role="alert" id="add-error"></p>' +
          '<button type="submit" class="btn primary wide">' + esc(t('add')) + '</button>' +
        '</form>' +
      '</section>';

    // Counts logged today
    var entries = data.entries.filter(function (e) { return e.date === d; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    var dayUnits = entries.reduce(function (s, e) { return s + Number(e.count || 0); }, 0);
    var rows = entries.map(function (e) {
      var item = findItem(e.itemId);
      var crew = e.workerIds.length;
      var what = (item ? item.sku + ' · ' + item.task : '?') +
        (typeof e.rateCents === 'number' ? ' · ' + rateText(e.rateCents) : '') +
        (crew > 1 ? ' · ' + t('crewOf', { n: crew }) + ' · ' + t('each', { units: num(e.count / crew) }) : '');
      return '<li>' +
        '<div class="grow"><div class="entry-who">' + esc(e.workerIds.map(workerName).join(', ')) + '</div>' +
        '<div class="entry-what">' + esc(what) + '</div></div>' +
        '<div class="entry-count">' + num(e.count, 0) + '</div>' +
        '<button type="button" class="btn small ghost" data-action="delete-entry" data-id="' + esc(e.id) + '" aria-label="' + esc(t('delete')) + '">✕</button>' +
        '</li>';
    }).join('');

    html +=
      '<section class="card">' +
        '<h2>' + esc(t('countsLogged')) + '</h2>' +
        (entries.length
          ? '<p class="muted">' + esc(t('dayTotal', { units: num(dayUnits, 0) })) + '</p><ul class="list">' + rows + '</ul>'
          : '<p class="muted">' + esc(t('noCounts')) + '</p>') +
      '</section>';

    // Hours worked today
    var dayHours = data.hours[d] || {};
    var hourRows = workers.map(function (w) {
      var v = dayHours[w.id] != null ? dayHours[w.id] : '';
      return '<li><span class="grow">' + esc(w.name) + '</span>' +
        '<input type="number" inputmode="decimal" min="0" max="24" step="0.25" value="' + esc(v) + '" data-change="hours" data-id="' + esc(w.id) + '" aria-label="' + esc(t('hoursWorked') + ': ' + w.name) + '"></li>';
    }).join('');

    html +=
      '<section class="card">' +
        '<h2>' + esc(t('hoursWorked')) + '</h2>' +
        '<p class="hint">' + esc(t('hoursHint')) + '</p>' +
        '<form class="inline-form" data-submit="fill-hours" novalidate style="margin:10px 0 4px">' +
          '<label>' + esc(t('fillBlanks')) +
            '<input type="number" name="h" inputmode="decimal" min="0" max="24" step="0.25" value="8"></label>' +
          '<button type="submit" class="btn small">' + esc(t('apply')) + '</button>' +
        '</form>' +
        '<ul class="list hours">' + hourRows + '</ul>' +
      '</section>';

    return html;
  }

  // ---------- week picker (Payroll, Costs, Earnings) ----------

  function weekBar() {
    var start = P.weekStart(ui.weekDate, data.settings.weekStartDay);
    var end = P.addDays(start, 6);
    return '<section class="card">' +
      '<div class="datebar">' +
        '<button type="button" class="btn icon" data-action="week-shift" data-n="-7" aria-label="' + esc(t('prevWeek')) + '">‹</button>' +
        '<div class="weeklabel"><span class="muted">' + esc(t('weekOf')) + '</span>' + esc(dayShort(start)) + ' – ' + esc(dayShort(end)) + '</div>' +
        '<button type="button" class="btn icon" data-action="week-shift" data-n="7" aria-label="' + esc(t('nextWeek')) + '">›</button>' +
      '</div>' +
      '<label class="jump">' + esc(t('jumpTo')) + ' <input type="date" value="' + ui.weekDate + '" data-change="week-date"></label>' +
    '</section>';
  }

  function warningText(row, w) {
    if (w.code === 'dayNoHours') return t('wDayNoHours', { name: row.name, date: dayShort(w.date) });
    if (w.code === 'longDay') return t('wLongDay', { name: row.name, hours: num(w.hours, 2), date: dayShort(w.date) });
    if (w.code === 'noUnits') return t('wNoUnits', { name: row.name });
    return row.name + ': ' + w.code;
  }

  // ---------- Payroll ----------

  function viewPayroll() {
    var week = P.computeWeek(data, ui.weekDate);
    var html = weekBar();
    if (!week.rows.length) return html + '<section class="card"><p>' + esc(t('noPayroll')) + '</p></section>';

    var warnings = [];
    week.rows.forEach(function (r) {
      r.warnings.forEach(function (w) { warnings.push(warningText(r, w)); });
    });
    html += '<section class="card ' + (warnings.length ? 'warn' : 'ok') + '">' +
      '<h2>' + esc(t('checksTitle')) + '</h2>' +
      (warnings.length
        ? '<ul class="checks">' + warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>'
        : '<p>' + esc(t('noChecks')) + '</p>') +
      '</section>';

    var head = ['colWorker', 'colHours', 'colOtHours', 'colUnits', 'colPiece', 'colTopUp', 'colRate', 'colOtPrem', 'colGross']
      .map(function (k) { return '<th scope="col">' + esc(t(k)) + '</th>'; }).join('');
    var body = week.rows.map(function (r) {
      return '<tr' + (r.warnings.length ? ' class="flag"' : '') + '>' +
        '<td>' + esc(r.name) + '</td>' +
        '<td>' + num(r.hours, 2) + '</td>' +
        '<td>' + (r.overtimeHours ? num(r.overtimeHours, 2) : '—') + '</td>' +
        '<td>' + num(r.units) + '</td>' +
        '<td>' + money(r.pieceCents) + '</td>' +
        '<td>' + (r.topUpCents ? money(r.topUpCents) : '—') + '</td>' +
        '<td>' + (r.regularRateCents == null ? '—' : money(Math.round(r.regularRateCents))) + '</td>' +
        '<td>' + (r.overtimePremiumCents ? money(r.overtimePremiumCents) : '—') + '</td>' +
        '<td><strong>' + money(r.grossCents) + '</strong></td>' +
      '</tr>';
    }).join('');
    var T = week.totals;
    var foot = '<tr><td>' + esc(t('total')) + '</td><td>' + num(T.hours, 2) + '</td><td>' + num(T.overtimeHours, 2) + '</td>' +
      '<td>' + num(T.units) + '</td><td>' + money(T.pieceCents) + '</td><td>' + money(T.topUpCents) + '</td><td></td>' +
      '<td>' + money(T.overtimePremiumCents) + '</td><td>' + money(T.grossCents) + '</td></tr>';

    html += '<section class="card">' +
      '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div>' +
      '<p class="hint">' + esc(t('payrollNote')) + '</p>' +
      '<p style="margin-top:12px"><button type="button" class="btn primary wide" data-action="export-csv">' + esc(t('exportCsv')) + '</button></p>' +
      '</section>';
    return html;
  }

  // ---------- Costs ----------

  function viewCosts() {
    var week = P.computeWeek(data, ui.weekDate);
    var T = week.totals;
    var html = weekBar();
    if (!week.rows.length) return html + '<section class="card"><p>' + esc(t('noPayroll')) + '</p></section>';

    function kpi(label, value) {
      return '<div class="kpi"><div class="label">' + esc(t(label)) + '</div><div class="value">' + esc(value) + '</div></div>';
    }
    html += '<div class="kpis">' +
      kpi('kpiUnits', num(T.units, 0)) +
      kpi('kpiManHours', num(T.hours, 1)) +
      kpi('kpiPerHour', num(T.unitsPerHour, 1)) +
      kpi('kpiLabor', money(T.grossCents)) +
      kpi('kpiPerUnit', money(T.laborPerUnitCents)) +
      '</div>';

    var head = ['colSku', 'colTask', 'colUnits', 'colRateCard', 'colLabor', 'colPerUnit'].map(function (k, i) {
      return '<th scope="col"' + (i === 1 ? ' class="text"' : '') + '>' + esc(t(k)) + '</th>';
    }).join('');
    var body = week.costs.items.map(function (c) {
      return '<tr><td>' + esc(c.sku) + '</td><td class="text">' + esc(c.task) + '</td>' +
        '<td>' + num(c.units) + '</td>' +
        '<td>' + (c.rateCents == null ? '—' : rateText(c.rateCents)) + '</td>' +
        '<td>' + money(c.laborCents) + '</td>' +
        '<td><strong>' + (c.perUnitCents == null ? '—' : rateText(Math.round(c.perUnitCents * 10) / 10)) + '</strong></td></tr>';
    }).join('');
    if (week.costs.unallocatedCents > 0) {
      body += '<tr><td>' + esc(t('unallocated')) + '</td><td class="text"></td><td></td><td></td><td>' + money(week.costs.unallocatedCents) + '</td><td></td></tr>';
    }

    html += '<section class="card">' +
      '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="hint">' + esc(t('costsNote')) + '</p>' +
      '</section>';
    return html;
  }

  // ---------- Earnings (what a worker sees) ----------

  function viewEarnings() {
    var workers = activeWorkers();
    if (!workers.length) return '<section class="card"><p>' + esc(t('noWorkers')) + '</p></section>';
    if (!workers.some(function (w) { return w.id === ui.earningsWorker; })) ui.earningsWorker = workers[0].id;

    var week = P.computeWeek(data, ui.weekDate);
    var r = null;
    week.rows.forEach(function (x) { if (x.workerId === ui.earningsWorker) r = x; });

    var options = workers.map(function (w) {
      return '<option value="' + esc(w.id) + '"' + (w.id === ui.earningsWorker ? ' selected' : '') + '>' + esc(w.name) + '</option>';
    }).join('');

    var html = '<section class="card"><label class="field">' + esc(t('pickWorker')) +
      '<select data-change="earnings-worker">' + options + '</select></label></section>' + weekBar();

    html += '<section class="card">' +
      '<p class="muted">' + esc(t('earnedSoFar')) + '</p>' +
      '<p class="big">' + money(r ? r.pieceCents : 0) + '</p>' +
      '<p class="muted">' + num(r ? r.units : 0) + ' ' + esc(t('colUnits').toLowerCase()) + ' · ' + num(r ? r.hours : 0, 2) + ' ' + esc(t('colHours').toLowerCase()) + '</p>' +
      '<p style="margin-top:12px">' + esc(t('estimatedGross')) + ': <strong>' + money(r ? r.grossCents : 0) + '</strong></p>' +
      '<p class="hint">' + esc(t('earningsNote')) + '</p>' +
      '</section>';

    var rows = week.dates.map(function (d) {
      var day = r ? r.days[d] : null;
      var has = day && (day.units > 0 || day.hours > 0);
      return '<tr><td>' + esc(dayShort(d)) + '</td>' +
        '<td>' + (has ? num(day.hours, 2) : '—') + '</td>' +
        '<td>' + (has ? num(day.units) : '—') + '</td>' +
        '<td>' + (has ? money(Math.round(day.pieceExact)) : '—') + '</td></tr>';
    }).join('');
    html += '<section class="card"><div class="table-wrap"><table>' +
      '<thead><tr><th scope="col">' + esc(t('colDay')) + '</th><th scope="col">' + esc(t('colHours')) + '</th><th scope="col">' + esc(t('colUnits')) + '</th><th scope="col">' + esc(t('colPiece')) + '</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></section>';
    return html;
  }

  // ---------- Setup ----------

  function viewSetup() {
    var s = data.settings;
    var dayOptions = [0, 1, 2, 3, 4, 5, 6].map(function (i) {
      var name = new Date(Date.UTC(2026, 10, 1 + i)).toLocaleDateString(locale(), { weekday: 'long', timeZone: 'UTC' });
      return '<option value="' + i + '"' + (i === s.weekStartDay ? ' selected' : '') + '>' + esc(name) + '</option>';
    }).join('');

    var html =
      '<section class="card"><h2>' + esc(t('shop')) + '</h2>' +
        '<form data-submit="save-shop" novalidate>' +
          '<label class="field">' + esc(t('shopName')) + '<input type="text" name="shopName" maxlength="80" value="' + esc(s.shopName) + '"></label>' +
          '<label class="field">' + esc(t('minWage')) + '<input type="number" name="minWage" inputmode="decimal" min="0" step="0.01" value="' + (s.minWageCents / 100).toFixed(2) + '">' +
            '<span class="hint" style="display:block">' + esc(t('minWageHint')) + '</span></label>' +
          '<label class="field">' + esc(t('otAfter')) + '<input type="number" name="ot" inputmode="decimal" min="1" max="168" step="0.5" value="' + s.overtimeAfterHours + '"></label>' +
          '<label class="field">' + esc(t('weekStarts')) + '<select name="weekStartDay">' + dayOptions + '</select></label>' +
          '<p class="form-error" role="alert" id="shop-error"></p>' +
          '<button type="submit" class="btn primary">' + esc(t('save')) + '</button>' +
        '</form>' +
      '</section>';

    var workers = data.workers.slice().sort(function (a, b) {
      return (b.active !== false) - (a.active !== false) || a.name.localeCompare(b.name);
    });
    html += '<section class="card"><h2>' + esc(t('workersTitle')) + '</h2>' +
      '<form class="inline-form" data-submit="add-worker" novalidate style="margin-bottom:8px">' +
        '<input type="text" name="name" maxlength="60" placeholder="' + esc(t('name')) + '" aria-label="' + esc(t('name')) + '">' +
        '<button type="submit" class="btn">' + esc(t('addWorker')) + '</button>' +
      '</form>' +
      '<p class="form-error" role="alert" id="worker-error"></p>' +
      '<ul class="list">' + workers.map(function (w) {
        return '<li><input type="text" class="grow" maxlength="60" value="' + esc(w.name) + '" data-change="worker-name" data-id="' + esc(w.id) + '" aria-label="' + esc(t('name')) + '">' +
          '<label class="check"><input type="checkbox" data-change="worker-active" data-id="' + esc(w.id) + '"' + (w.active !== false ? ' checked' : '') + '>' + esc(t('active')) + '</label></li>';
      }).join('') + '</ul></section>';

    html += '<section class="card"><h2>' + esc(t('rateCard')) + '</h2>' +
      '<p class="hint" style="margin-bottom:8px">' + esc(t('rateCardHint')) + '</p>' +
      '<div class="rate-row rate-head"><span>' + esc(t('sku')) + '</span><span>' + esc(t('task')) + '</span><span>' + esc(t('rate')) + '</span><span></span></div>' +
      data.items.map(function (i) {
        return '<div class="rate-row">' +
          '<input type="text" maxlength="60" value="' + esc(i.sku) + '" data-change="item-field" data-field="sku" data-id="' + esc(i.id) + '" aria-label="' + esc(t('sku')) + '">' +
          '<input type="text" maxlength="40" value="' + esc(i.task) + '" data-change="item-field" data-field="task" data-id="' + esc(i.id) + '" aria-label="' + esc(t('task')) + '">' +
          '<input type="number" inputmode="decimal" min="0" step="0.005" value="' + rateInputValue(i.rateCents) + '" data-change="item-field" data-field="rate" data-id="' + esc(i.id) + '" aria-label="' + esc(t('rate')) + '">' +
          '<label class="check"><input type="checkbox" data-change="item-active" data-id="' + esc(i.id) + '"' + (i.active !== false ? ' checked' : '') + '>' + esc(t('active')) + '</label>' +
        '</div>';
      }).join('') +
      '<form data-submit="add-item" novalidate style="margin-top:12px">' +
        '<div class="rate-row" style="border-bottom:0">' +
          '<input type="text" name="sku" maxlength="60" placeholder="' + esc(t('sku')) + '" aria-label="' + esc(t('sku')) + '">' +
          '<input type="text" name="task" maxlength="40" placeholder="' + esc(t('task')) + '" aria-label="' + esc(t('task')) + '">' +
          '<input type="number" name="rate" inputmode="decimal" min="0" step="0.005" placeholder="0.00" aria-label="' + esc(t('rate')) + '">' +
          '<button type="submit" class="btn small">' + esc(t('add')) + '</button>' +
        '</div>' +
        '<p class="form-error" role="alert" id="item-error"></p>' +
      '</form></section>';

    html += '<section class="card"><h2>' + esc(t('dataTitle')) + '</h2>' +
      '<p class="hint" style="margin-bottom:10px">' + esc(t('dataHint')) + '</p>' +
      '<div class="button-stack">' +
        '<button type="button" class="btn" data-action="backup">' + esc(t('backup')) + '</button>' +
        '<label class="btn file-button">' + esc(t('restore')) + '<input type="file" accept="application/json,.json" data-change="restore-file"></label>' +
        '<button type="button" class="btn" data-action="load-demo">' + esc(t('loadDemo')) + '</button>' +
        '<button type="button" class="btn danger" data-action="erase">' + esc(t('erase')) + '</button>' +
      '</div></section>';

    return html;
  }

  // ---------- actions ----------

  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function exportCsv() {
    var week = P.computeWeek(data, ui.weekDate);
    if (!week.rows.length) { toast(t('noPayroll'), true); return; }
    if (week.totals.warnings && !confirm(t('confirmExportWarnings', { n: week.totals.warnings }))) return;
    // The leading mark lets Excel read accented names (Hernández) correctly.
    download('payroll_' + week.start + '_to_' + week.end + '.csv', '﻿' + P.payrollCsv(week), 'text/csv;charset=utf-8');
    toast(t('downloaded'));
  }

  function resetDraft() {
    ui.draft = { itemId: '', count: '', workerIds: [] };
  }

  function replaceData(next, message) {
    data = next;
    resetDraft();
    ui.earningsWorker = '';
    persist(true);
    render();
    toast(message);
  }

  function onClick(ev) {
    var el = ev.target.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');

    switch (action) {
      case 'tab':
        ui.tab = el.getAttribute('data-tab');
        prefSet('pfl.tab', ui.tab);
        render();
        window.scrollTo(0, 0);
        break;
      case 'lang':
        data.settings.lang = el.getAttribute('data-lang') === 'es' ? 'es' : 'en';
        persist(true);
        render();
        break;
      case 'day-shift':
        ui.tallyDate = P.addDays(ui.tallyDate, Number(el.getAttribute('data-n')));
        render();
        break;
      case 'day-today':
        ui.tallyDate = today();
        render();
        break;
      case 'week-shift':
        ui.weekDate = P.addDays(ui.weekDate, Number(el.getAttribute('data-n')));
        render();
        break;
      case 'toggle-worker': {
        var id = el.getAttribute('data-id');
        var at = ui.draft.workerIds.indexOf(id);
        if (at >= 0) ui.draft.workerIds.splice(at, 1); else ui.draft.workerIds.push(id);
        el.setAttribute('aria-pressed', String(at < 0));
        break;
      }
      case 'delete-entry':
        if (!confirm(t('confirmDeleteEntry'))) return;
        data.entries = data.entries.filter(function (e) { return e.id !== el.getAttribute('data-id'); });
        persist();
        render();
        break;
      case 'export-csv':
        exportCsv();
        break;
      case 'backup':
        download('pallet-floor-ledger-backup-' + today() + '.json', JSON.stringify(data, null, 2), 'application/json');
        toast(t('downloaded'));
        break;
      case 'load-demo':
        if (!confirm(t('confirmDemo'))) return;
        replaceData(Demo.build(today(), data.settings.lang), t('demoLoaded'));
        break;
      case 'erase':
        if (!confirm(t('confirmErase'))) return;
        replaceData(Store.empty(data.settings.lang), t('erased'));
        break;
    }
  }

  function onInput(ev) {
    var kind = ev.target.getAttribute && ev.target.getAttribute('data-input');
    if (kind === 'draft-count') ui.draft.count = ev.target.value;
    if (kind === 'draft-item') ui.draft.itemId = ev.target.value;
  }

  function onChange(ev) {
    var el = ev.target;
    var kind = el.getAttribute && el.getAttribute('data-change');
    if (!kind) {
      onInput(ev);
      return;
    }
    var id = el.getAttribute('data-id');

    switch (kind) {
      case 'tally-date':
        if (isDate(el.value)) { ui.tallyDate = el.value; render(); }
        break;
      case 'week-date':
        if (isDate(el.value)) { ui.weekDate = el.value; render(); }
        break;
      case 'earnings-worker':
        ui.earningsWorker = el.value;
        render();
        break;
      case 'hours': {
        var d = ui.tallyDate;
        var day = data.hours[d] || {};
        var raw = el.value.trim();
        if (raw === '') {
          delete day[id];
        } else {
          var h = Number(raw);
          if (!(h >= 0 && h <= 24)) {
            toast(t('errHours'), true);
            el.value = day[id] != null ? day[id] : '';
            return;
          }
          h = Math.round(h * 100) / 100;
          if (h === 0) delete day[id]; else day[id] = h;
        }
        if (Object.keys(day).length) data.hours[d] = day; else delete data.hours[d];
        persist();
        break;
      }
      case 'worker-name': {
        var name = el.value.trim();
        data.workers.forEach(function (w) {
          if (w.id !== id) return;
          if (!name) { el.value = w.name; toast(t('errName'), true); return; }
          w.name = name;
          persist();
        });
        break;
      }
      case 'worker-active':
        data.workers.forEach(function (w) { if (w.id === id) w.active = el.checked; });
        persist();
        break;
      case 'item-field': {
        var field = el.getAttribute('data-field');
        var item = findItem(id);
        if (!item) return;
        if (field === 'rate') {
          var r = Number(el.value);
          if (el.value.trim() === '' || !(r >= 0)) { el.value = rateInputValue(item.rateCents); toast(t('errRate'), true); return; }
          item.rateCents = Math.round(r * 1000) / 10;
        } else {
          var v = el.value.trim();
          if (!v) { el.value = item[field]; toast(t('errRate'), true); return; }
          item[field] = v;
        }
        persist();
        break;
      }
      case 'item-active': {
        var it = findItem(id);
        if (it) { it.active = el.checked; persist(); }
        break;
      }
      case 'restore-file': {
        var file = el.files && el.files[0];
        el.value = '';
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          var next = null;
          try { next = JSON.parse(String(reader.result)); } catch (e) { next = null; }
          if (!Store.valid(next)) { toast(t('restoreFailed'), true); return; }
          if (!confirm(t('confirmRestore'))) return;
          replaceData(next, t('restored'));
        };
        reader.onerror = function () { toast(t('restoreFailed'), true); };
        reader.readAsText(file);
        break;
      }
    }
  }

  function onSubmit(ev) {
    var form = ev.target;
    var kind = form.getAttribute('data-submit');
    if (!kind) return;
    ev.preventDefault();
    var f = form.elements;

    function fail(boxId, key) {
      var box = document.getElementById(boxId);
      if (box) box.textContent = t(key); else toast(t(key), true);
    }

    switch (kind) {
      case 'add-count': {
        var item = findItem(ui.draft.itemId);
        var count = Number(String(ui.draft.count).trim());
        var activeIds = {};
        activeWorkers().forEach(function (w) { activeIds[w.id] = true; });
        var crew = ui.draft.workerIds.filter(function (wid) { return activeIds[wid]; });
        if (!item || item.active === false) return fail('add-error', 'errItem');
        if (!(Number.isInteger(count) && count > 0 && count <= MAX_COUNT)) return fail('add-error', 'errCount');
        if (!crew.length) return fail('add-error', 'errWorkers');
        data.entries.push({
          id: uid('e'),
          date: ui.tallyDate,
          workerIds: crew,
          itemId: item.id,
          count: count,
          rateCents: item.rateCents,
          createdAt: Date.now()
        });
        if (persist(true)) toast(t('countAdded'));
        ui.draft.count = '';
        ui.draft.workerIds = [];
        render();
        break;
      }
      case 'fill-hours': {
        var h = Number(f.h.value);
        if (!(h > 0 && h <= 24)) { toast(t('errHours'), true); return; }
        h = Math.round(h * 100) / 100;
        var d = ui.tallyDate;
        var day = data.hours[d] || {};
        data.entries.forEach(function (e) {
          if (e.date !== d) return;
          e.workerIds.forEach(function (wid) { if (!(day[wid] > 0)) day[wid] = h; });
        });
        if (Object.keys(day).length) data.hours[d] = day;
        persist();
        render();
        break;
      }
      case 'save-shop': {
        var mw = Number(f.minWage.value);
        var ot = Number(f.ot.value);
        if (f.minWage.value.trim() === '' || !(mw >= 0)) return fail('shop-error', 'errMinWage');
        if (!(ot >= 1 && ot <= 168)) return fail('shop-error', 'errOt');
        data.settings.shopName = f.shopName.value.trim();
        data.settings.minWageCents = Math.round(mw * 100);
        data.settings.overtimeAfterHours = ot;
        data.settings.weekStartDay = Number(f.weekStartDay.value);
        persist();
        render();
        break;
      }
      case 'add-worker': {
        var name = f.name.value.trim();
        if (!name) return fail('worker-error', 'errName');
        data.workers.push({ id: uid('w'), name: name, active: true });
        persist();
        render();
        var input = document.querySelector('[data-submit="add-worker"] input');
        if (input) input.focus();
        break;
      }
      case 'add-item': {
        var sku = f.sku.value.trim();
        var task = f.task.value.trim();
        var rate = Number(f.rate.value);
        if (!sku || !task || f.rate.value.trim() === '' || !(rate >= 0)) return fail('item-error', 'errRate');
        data.items.push({ id: uid('i'), sku: sku, task: task, rateCents: Math.round(rate * 1000) / 10, active: true });
        persist();
        render();
        break;
      }
    }
  }

  // ---------- start ----------

  document.addEventListener('click', onClick);
  var view = $('#view');
  view.addEventListener('input', onInput);
  view.addEventListener('change', onChange);
  view.addEventListener('submit', onSubmit);

  render();
  if (startupNotice) toast(t(startupNotice), true);
})();
