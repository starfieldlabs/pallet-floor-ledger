/* Pallet Floor Ledger — screens and what the buttons do.
 *
 * Three modes:
 *   local  everything on this device only (no sign-in; also the demo)
 *   gate   the sign-in, sign-up and shop-picker screens
 *   shop   a signed-in shop, kept the same on every device by sync.js
 * Sharing is only offered when js/config.js has a Supabase project in it.
 */
(function () {
  'use strict';

  var P = window.Payroll;
  var CFG = window.PFL_CONFIG || {};
  var MAX_COUNT = 100000;
  var POLL_MS = 20000;
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
  function prefSet(k, v) {
    try {
      if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { /* not important */ }
  }
  /** Unique across devices: time plus 50+ random bits. */
  function uid(prefix) {
    var rand = '';
    try {
      var a = new Uint32Array(2);
      crypto.getRandomValues(a);
      rand = a[0].toString(36) + a[1].toString(36);
    } catch (e) {
      rand = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    return prefix + Date.now().toString(36) + rand.slice(0, 10);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var storage = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { localStorage.setItem(k, v); },
    remove: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  var cloud = CFG.supabaseUrl && CFG.supabaseKey && window.Cloud && window.Sync
    ? Cloud.create({ url: CFG.supabaseUrl, key: CFG.supabaseKey, storage: storage })
    : null;

  // ---------- state ----------

  var mode = 'local';
  var data = null;
  var lang = prefGet('pfl.lang');
  var shop = null;          // { id, name, role } in shop mode
  var engine = null;        // Sync engine in shop mode
  var syncState = null;
  var startupNotice = null;
  var joinCode = '';
  var gate = freshGate('start');
  var people = freshPeople(null);

  var ui = {
    tab: 'tally',
    tallyDate: today(),
    weekDate: today(),
    draft: { itemId: '', count: '', workerIds: [] },
    earningsWorker: ''
  };
  var savedTab = prefGet('pfl.tab');
  if (TABS.indexOf(savedTab) >= 0) ui.tab = savedTab;

  function freshGate(screen) {
    return { screen: screen, notice: '', error: '', email: prefGet('pfl.email') || '', shops: null, shopsError: '', joinError: '', autoOpen: false, reauth: false };
  }
  function freshPeople(shopId) {
    return { shopId: shopId, loading: false, loaded: false, members: [], invites: [], error: '', lastInvite: null };
  }

  function t(key, vars) { return I18N.t(lang || 'en', key, vars); }
  function locale() { return lang === 'es' ? 'es-US' : 'en-US'; }
  function me() { var s = cloud && cloud.session(); return s ? s.user : null; }
  function isOwner() { return mode !== 'shop' || (shop && shop.role === 'owner'); }
  function roleName(r) { return t(r === 'owner' ? 'roleOwner' : 'roleSupervisor'); }
  function shopTitle() {
    return (data && data.settings.shopName) || (shop && shop.name) || t('unnamedShop');
  }

  function persist(quiet) {
    var ok = mode === 'shop' ? engine.save() : Store.save(data);
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
  function codeText(code) { return String(code).slice(0, 4) + ' ' + String(code).slice(4); }
  function normalizeCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16); }

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
  /** This device's own (not demo) data, if it has any. */
  function localRealData() {
    var d = Store.peek();
    return d && !d.demo && (d.workers.length || d.entries.length) ? d : null;
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

  var renderPending = false;

  function typing() {
    var a = document.activeElement;
    return !!a && $('#view').contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox';
  }

  /** Redraw for changes from another device, but not under someone's fingers. */
  function requestRender() {
    if (typing()) { renderPending = true; return; }
    render();
  }

  function render() {
    renderPending = false;
    document.documentElement.lang = lang || 'en';

    var group = $('#lang-group');
    group.setAttribute('aria-label', t('language'));
    Array.prototype.forEach.call(group.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang));
    });

    var tabs = $('#tabs');
    if (mode === 'gate') {
      $('#shop-name').textContent = 'Pallet Floor Ledger';
      renderStatus();
      tabs.hidden = true;
      tabs.innerHTML = '';
      $('#banner').innerHTML = '';
      $('#view').innerHTML = viewGate();
      return;
    }

    $('#shop-name').textContent = shopTitle();
    renderStatus();
    tabs.hidden = false;
    tabs.innerHTML = TABS.map(function (k) {
      return '<button type="button" data-action="tab" data-tab="' + k + '"' +
        (ui.tab === k ? ' aria-current="page"' : '') + '>' + esc(t(TAB_LABEL[k])) + '</button>';
    }).join('');
    renderBanner();

    var views = { tally: viewTally, payroll: viewPayroll, costs: viewCosts, earnings: viewEarnings, setup: viewSetup };
    $('#view').innerHTML = views[ui.tab]();
  }

  function renderBanner() {
    var html = '';
    if (mode === 'local' && data.demo) {
      html = cloud
        ? '<div class="banner"><span>' + esc(t('demoBannerCloud')) + '</span> <button type="button" class="btn small" data-action="gate" data-screen="signup">' + esc(t('setUpMyShop')) + '</button></div>'
        : '<div class="banner">' + esc(t('demoBanner')) + '</div>';
    } else if (mode === 'shop' && syncState && syncState.state === 'signedOut') {
      html = '<div class="banner alert"><span>' + esc(t('signedOutBanner')) + '</span> <button type="button" class="btn small primary" data-action="reauth">' + esc(t('signIn')) + '</button></div>';
    }
    $('#banner').innerHTML = html;
  }

  function renderStatus() {
    var el = $('#product-line');
    if (mode !== 'shop') {
      el.className = 'product';
      el.textContent = mode === 'gate' ? '' : 'Pallet Floor Ledger';
      return;
    }
    var s = syncState || { state: 'idle', pending: 0 };
    var cls, text;
    if (s.state === 'offline') { cls = 'warn'; text = s.pending ? t('syncOffline', { n: s.pending }) : t('syncOfflineNone'); }
    else if (s.state === 'signedOut') { cls = 'bad'; text = t('syncSignedOut', { n: s.pending }); }
    else if (s.state === 'error') { cls = 'bad'; text = t('syncError', { n: s.pending }); }
    else if (s.pending > 0 || s.state === 'saving') { cls = 'busy'; text = t('syncSaving'); }
    else if (s.state === 'synced') { cls = 'ok'; text = t('syncSynced'); }
    else { cls = 'busy'; text = t('syncConnecting'); }
    el.className = 'product sync ' + cls;
    el.textContent = text;
  }

  // ---------- sign-in screens ----------

  function viewGate() {
    if (gate.screen === 'signin' || gate.screen === 'signup') return viewAuth(gate.screen);
    if (gate.screen === 'shops') return viewShops();
    return viewStart();
  }

  function notice() {
    return gate.notice ? '<p class="notice">' + esc(gate.notice) + '</p>' : '';
  }

  function viewStart() {
    var real = localRealData();
    return '<section class="card narrow hero">' +
      '<h1>' + esc(t('heroTitle')) + '</h1>' +
      '<p class="muted">' + esc(t('heroText')) + '</p>' +
      notice() +
      (joinCode ? '<p class="notice">' + esc(t('inviteWaiting')) + '</p>' : '') +
      '<div class="button-stack">' +
        '<button type="button" class="btn primary" data-action="gate" data-screen="signup">' + esc(t('createAccount')) + '</button>' +
        '<button type="button" class="btn" data-action="gate" data-screen="signin">' + esc(t('signIn')) + '</button>' +
        (joinCode ? '' : '<button type="button" class="btn ghost" data-action="use-local">' + esc(t(real ? 'keepLocal' : 'tryDemo')) + '</button>') +
      '</div></section>';
  }

  function viewAuth(kind) {
    var up = kind === 'signup';
    return '<section class="card narrow">' +
      '<h2>' + esc(t(up ? 'createAccount' : 'signIn')) + '</h2>' +
      notice() +
      (joinCode ? '<p class="notice">' + esc(t('inviteWaiting')) + '</p>' : '') +
      '<form data-submit="' + kind + '" novalidate>' +
        '<label class="field">' + esc(t('email')) +
          '<input type="email" name="email" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false" maxlength="254" value="' + esc(gate.email) + '"></label>' +
        '<label class="field">' + esc(t(up ? 'newPassword' : 'password')) +
          '<input type="password" name="password" autocomplete="' + (up ? 'new-password' : 'current-password') + '" maxlength="72"></label>' +
        '<p class="form-error" role="alert" id="gate-error">' + esc(gate.error) + '</p>' +
        '<button type="submit" class="btn primary wide">' + esc(t(up ? 'createAccount' : 'signIn')) + '</button>' +
      '</form>' +
      '<p class="switch">' + esc(t(up ? 'haveAccount' : 'noAccount')) + ' ' +
        '<button type="button" class="link" data-action="gate" data-screen="' + (up ? 'signin' : 'signup') + '">' + esc(t(up ? 'signIn' : 'createAccount')) + '</button></p>' +
      (up ? '' : '<p class="hint">' + esc(t('forgotHint')) + '</p>') +
      '<p style="margin-top:12px"><button type="button" class="btn ghost" data-action="gate" data-screen="start">' + esc(t('back')) + '</button></p>' +
    '</section>';
  }

  function viewShops() {
    var user = me();
    var html = '<section class="card narrow">' +
      '<p class="muted">' + esc(t('signedInAs', { email: user ? user.email : '' })) + '</p>' +
      notice() +
      '<h2>' + esc(t('yourShops')) + '</h2>';
    if (gate.shopsError) {
      html += '<p class="form-error">' + esc(gate.shopsError) + '</p>' +
        '<button type="button" class="btn" data-action="reload-shops">' + esc(t('tryAgain')) + '</button>';
    } else if (!gate.shops) {
      html += '<p class="muted">' + esc(t('loading')) + '</p>';
    } else if (!gate.shops.length) {
      html += '<p>' + esc(t('noShopsYet')) + '</p>';
    } else {
      html += '<div class="button-stack">' + gate.shops.map(function (s) {
        return '<button type="button" class="btn shop-button" data-action="open-shop" data-id="' + esc(s.id) + '">' +
          '<span>' + esc(s.name || t('unnamedShop')) + '</span><span class="muted">' + esc(roleName(s.role)) + '</span></button>';
      }).join('') + '</div>';
    }
    html += '</section>';

    html += '<section class="card narrow"><h2>' + esc(t('joinTitle')) + '</h2>' +
      '<p class="hint" style="margin:0 0 8px">' + esc(t('joinHint')) + '</p>' +
      '<form class="inline-form" data-submit="join-shop" novalidate>' +
        '<input type="text" name="code" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD 2345" aria-label="' + esc(t('inviteCode')) + '" value="' + esc(joinCode ? codeText(joinCode) : '') + '">' +
        '<button type="submit" class="btn">' + esc(t('join')) + '</button>' +
      '</form>' +
      '<p class="form-error" role="alert" id="join-error">' + esc(gate.joinError) + '</p>' +
      '</section>';

    var real = localRealData();
    html += '<section class="card narrow"><h2>' + esc(t('createShopTitle')) + '</h2>' +
      '<form data-submit="create-shop" novalidate>' +
        '<label class="field">' + esc(t('shopName')) + '<input type="text" name="name" maxlength="80" value="' + esc(real ? real.settings.shopName : '') + '"></label>' +
        (real ? '<label class="check wrap" style="margin-bottom:12px"><input type="checkbox" name="copy" checked>' + esc(t('copyLocal')) + '</label>' : '') +
        '<p class="form-error" role="alert" id="create-error"></p>' +
        '<button type="submit" class="btn primary">' + esc(t('createShop')) + '</button>' +
      '</form></section>';

    html += '<section class="card narrow"><button type="button" class="btn" data-action="sign-out">' + esc(t('signOut')) + '</button></section>';
    return html;
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
    var owner = isOwner();
    var lock = owner ? '' : ' disabled';
    var lockNote = owner ? '' : '<p class="hint">' + esc(t('ownerOnly')) + '</p>';
    var dayOptions = [0, 1, 2, 3, 4, 5, 6].map(function (i) {
      var name = new Date(Date.UTC(2026, 10, 1 + i)).toLocaleDateString(locale(), { weekday: 'long', timeZone: 'UTC' });
      return '<option value="' + i + '"' + (i === s.weekStartDay ? ' selected' : '') + '>' + esc(name) + '</option>';
    }).join('');

    var html = '';
    if (mode === 'local' && cloud && !data.demo) {
      html += '<section class="card share"><h2>' + esc(t('shareTitle')) + '</h2>' +
        '<p>' + esc(t('shareText')) + '</p>' +
        '<button type="button" class="btn primary" data-action="gate" data-screen="signup">' + esc(t('shareButton')) + '</button></section>';
    }

    html +=
      '<section class="card"><h2>' + esc(t('shop')) + '</h2>' +
        '<form data-submit="save-shop" novalidate><fieldset' + lock + '>' +
          '<label class="field">' + esc(t('shopName')) + '<input type="text" name="shopName" maxlength="80" value="' + esc(s.shopName) + '"></label>' +
          '<label class="field">' + esc(t('minWage')) + '<input type="number" name="minWage" inputmode="decimal" min="0" step="0.01" value="' + (s.minWageCents / 100).toFixed(2) + '">' +
            '<span class="hint" style="display:block">' + esc(t('minWageHint')) + '</span></label>' +
          '<label class="field">' + esc(t('otAfter')) + '<input type="number" name="ot" inputmode="decimal" min="1" max="168" step="0.5" value="' + s.overtimeAfterHours + '"></label>' +
          '<label class="field">' + esc(t('weekStarts')) + '<select name="weekStartDay">' + dayOptions + '</select></label>' +
          '<p class="form-error" role="alert" id="shop-error"></p>' +
          (owner ? '<button type="submit" class="btn primary">' + esc(t('save')) + '</button>' : '') +
        '</fieldset></form>' + lockNote +
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
      '<fieldset' + lock + '>' +
      '<div class="rate-row rate-head"><span>' + esc(t('sku')) + '</span><span>' + esc(t('task')) + '</span><span>' + esc(t('rate')) + '</span><span></span></div>' +
      data.items.map(function (i) {
        return '<div class="rate-row">' +
          '<input type="text" maxlength="60" value="' + esc(i.sku) + '" data-change="item-field" data-field="sku" data-id="' + esc(i.id) + '" aria-label="' + esc(t('sku')) + '">' +
          '<input type="text" maxlength="40" value="' + esc(i.task) + '" data-change="item-field" data-field="task" data-id="' + esc(i.id) + '" aria-label="' + esc(t('task')) + '">' +
          '<input type="number" inputmode="decimal" min="0" step="0.005" value="' + rateInputValue(i.rateCents) + '" data-change="item-field" data-field="rate" data-id="' + esc(i.id) + '" aria-label="' + esc(t('rate')) + '">' +
          '<label class="check"><input type="checkbox" data-change="item-active" data-id="' + esc(i.id) + '"' + (i.active !== false ? ' checked' : '') + '>' + esc(t('active')) + '</label>' +
        '</div>';
      }).join('') +
      (owner
        ? '<form data-submit="add-item" novalidate style="margin-top:12px">' +
            '<div class="rate-row" style="border-bottom:0">' +
              '<input type="text" name="sku" maxlength="60" placeholder="' + esc(t('sku')) + '" aria-label="' + esc(t('sku')) + '">' +
              '<input type="text" name="task" maxlength="40" placeholder="' + esc(t('task')) + '" aria-label="' + esc(t('task')) + '">' +
              '<input type="number" name="rate" inputmode="decimal" min="0" step="0.005" placeholder="0.00" aria-label="' + esc(t('rate')) + '">' +
              '<button type="submit" class="btn small">' + esc(t('add')) + '</button>' +
            '</div>' +
            '<p class="form-error" role="alert" id="item-error"></p>' +
          '</form>'
        : '') +
      '</fieldset>' + lockNote + '</section>';

    if (mode === 'shop') {
      html += viewPeople();
      var user = me();
      html += '<section class="card"><h2>' + esc(t('accountTitle')) + '</h2>' +
        '<p class="muted">' + esc(t('signedInAs', { email: user ? user.email : '' })) + ' · ' + esc(roleName(shop.role)) + '</p>' +
        '<div class="button-row">' +
          '<button type="button" class="btn" data-action="switch-shop">' + esc(t('switchShop')) + '</button>' +
          '<button type="button" class="btn" data-action="sign-out">' + esc(t('signOut')) + '</button>' +
        '</div></section>';
      html += '<section class="card"><h2>' + esc(t('dataTitle')) + '</h2>' +
        '<p class="hint" style="margin-bottom:10px">' + esc(t('dataHintShop')) + '</p>' +
        '<div class="button-stack">' +
          '<button type="button" class="btn" data-action="backup">' + esc(t('backup')) + '</button>' +
          (owner ? '<label class="btn file-button">' + esc(t('restore')) + '<input type="file" accept="application/json,.json" data-change="restore-file"></label>' : '') +
        '</div></section>';
    } else {
      html += '<section class="card"><h2>' + esc(t('dataTitle')) + '</h2>' +
        '<p class="hint" style="margin-bottom:10px">' + esc(t('dataHint')) + '</p>' +
        '<div class="button-stack">' +
          '<button type="button" class="btn" data-action="backup">' + esc(t('backup')) + '</button>' +
          '<label class="btn file-button">' + esc(t('restore')) + '<input type="file" accept="application/json,.json" data-change="restore-file"></label>' +
          '<button type="button" class="btn" data-action="load-demo">' + esc(t('loadDemo')) + '</button>' +
          '<button type="button" class="btn danger" data-action="erase">' + esc(t('erase')) + '</button>' +
        '</div></section>';
    }

    return html;
  }

  function inviteLink(code) {
    return location.href.split('#')[0].split('?')[0] + '?join=' + code;
  }

  function viewPeople() {
    if (people.shopId !== shop.id) people = freshPeople(shop.id);
    if (!people.loaded && !people.loading) loadPeople();
    var owner = isOwner();
    var user = me();
    var html = '<section class="card"><h2>' + esc(t('peopleTitle')) + '</h2>' +
      '<p class="hint" style="margin:0 0 8px">' + esc(t('peopleHint')) + '</p>';

    if (people.error) {
      html += '<p class="form-error">' + esc(people.error) + '</p>' +
        '<button type="button" class="btn small" data-action="reload-people">' + esc(t('tryAgain')) + '</button>';
    } else if (!people.loaded) {
      html += '<p class="muted">' + esc(t('loading')) + '</p>';
    } else {
      html += '<ul class="list">' + people.members.map(function (m) {
        var mine = user && m.user_id === user.id;
        return '<li><div class="grow"><div class="entry-who">' + esc(m.email || '—') +
          (mine ? ' <span class="muted">(' + esc(t('you')) + ')</span>' : '') + '</div>' +
          '<div class="entry-what">' + esc(roleName(m.role)) + '</div></div>' +
          (owner && !mine ? '<button type="button" class="btn small ghost" data-action="remove-member" data-id="' + esc(m.user_id) + '" data-email="' + esc(m.email) + '">' + esc(t('remove')) + '</button>' : '') +
          '</li>';
      }).join('') + '</ul>';
    }

    if (owner) {
      html += '<form class="inline-form" data-submit="create-invite" novalidate style="margin-top:12px">' +
        '<label>' + esc(t('inviteRole')) +
          '<select name="role"><option value="supervisor">' + esc(t('roleSupervisor')) + '</option><option value="owner">' + esc(t('roleOwner')) + '</option></select></label>' +
        '<button type="submit" class="btn">' + esc(t('createInvite')) + '</button>' +
        '</form>' +
        '<p class="form-error" role="alert" id="invite-error"></p>';

      var last = people.lastInvite;
      if (last) {
        html += '<div class="invite">' +
          '<p class="hint" style="margin:0">' + esc(t('inviteReady')) + '</p>' +
          '<div class="invite-code">' + esc(codeText(last.code)) + '</div>' +
          '<p class="muted" style="margin:0">' + esc(roleName(last.role)) + '</p>' +
          '<input type="text" readonly class="invite-link" value="' + esc(inviteLink(last.code)) + '" aria-label="' + esc(t('copyLink')) + '">' +
          '<div class="button-row">' +
            '<button type="button" class="btn small" data-action="copy-invite">' + esc(t('copyLink')) + '</button>' +
            (navigator.share ? '<button type="button" class="btn small" data-action="share-invite">' + esc(t('share')) + '</button>' : '') +
          '</div></div>';
      }

      var open = people.invites.filter(function (v) { return !last || v.code !== last.code; });
      if (open.length) {
        html += '<h3>' + esc(t('openInvites')) + '</h3><ul class="list">' + open.map(function (v) {
          return '<li><div class="grow"><div class="entry-who mono">' + esc(codeText(v.code)) + '</div>' +
            '<div class="entry-what">' + esc(roleName(v.role)) + ' · ' + esc(t('expiresOn', { date: dateText(v.expires_at.slice(0, 10), { month: 'short', day: 'numeric' }) })) + '</div></div>' +
            '<button type="button" class="btn small ghost" data-action="cancel-invite" data-id="' + esc(v.code) + '">' + esc(t('cancelInvite')) + '</button></li>';
        }).join('') + '</ul>';
      }
    }
    return html + '</section>';
  }

  // ---------- modes ----------

  function cacheKeyFor(userId, shopId) { return 'pfl.cache.' + userId + '.' + shopId; }

  function readLastShop() {
    try {
      var s = JSON.parse(prefGet('pfl.shop') || 'null');
      return s && s.id && s.userId ? s : null;
    } catch (e) {
      return null;
    }
  }

  function openLocal() {
    stopEngine();
    var loaded = Store.load();
    data = loaded.data;
    if (!data) {
      data = Demo.build(today(), lang || defaultLang());
      if (loaded.status === 'corrupt') startupNotice = 'storageDamaged';
      if (!Store.save(data)) startupNotice = 'saveFailed';
    }
    if (!lang) lang = data.settings.lang || defaultLang();
    data.settings.lang = lang;
    mode = 'local';
    shop = null;
    resetDraft();
  }

  function showGate(screen, extra) {
    stopEngine();
    mode = 'gate';
    shop = null;
    data = null;
    var keep = gate;
    gate = freshGate(screen);
    if (keep.email) gate.email = keep.email;
    if (extra) for (var k in extra) gate[k] = extra[k];
    if (!lang) lang = defaultLang();
  }

  function stopEngine() {
    if (engine) engine.stop();
    engine = null;
    syncState = null;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  var pollTimer = null;

  function makeRemote(shopId) {
    return {
      pull: function (q) {
        var query = {
          select: 'kind,id,data,deleted,updated_at',
          shop_id: 'eq.' + shopId,
          order: 'updated_at.asc,kind.asc,id.asc',
          limit: String(q.limit),
          offset: String(q.offset)
        };
        if (q.since) query.updated_at = 'gt.' + q.since;
        if (q.liveOnly) query.deleted = 'is.false';
        return cloud.rest('GET', 'records', { query: query });
      },
      push: function (rows) {
        return cloud.rest('POST', 'records', {
          query: { on_conflict: 'shop_id,kind,id' },
          body: rows,
          prefer: 'resolution=merge-duplicates,return=minimal'
        });
      }
    };
  }

  function openShop(s, opts) {
    opts = opts || {};
    var user = me();
    if (!user) { showGate('signin'); render(); return; }
    stopEngine();
    shop = { id: s.id, name: s.name || '', role: s.role === 'owner' ? 'owner' : 'supervisor' };
    var initial = opts.initialData || Store.empty(lang);
    engine = Sync.createEngine({
      shopId: shop.id,
      cacheKey: cacheKeyFor(user.id, shop.id),
      storage: storage,
      remote: makeRemote(shop.id),
      initialData: initial,
      uploadAll: !!opts.uploadAll,
      onChange: function () { requestRender(); },
      onStatus: onSyncStatus
    });
    data = engine.data;
    data.settings.lang = lang;
    data.demo = false;
    mode = 'shop';
    syncState = engine.status();
    people = freshPeople(shop.id);
    resetDraft();
    ui.earningsWorker = '';
    prefSet('pfl.shop', JSON.stringify({ id: shop.id, name: shop.name, role: shop.role, userId: user.id }));
    prefSet('pfl.mode', 'shop');
    var ticks = 0;
    pollTimer = setInterval(function () {
      if (!engine || document.hidden) return;
      engine.syncNow();
      if (++ticks % 10 === 0) checkMembership();   // about every 3 minutes
    }, POLL_MS);
    engine.syncNow();
    render();
  }

  function onSyncStatus(s) {
    var before = syncState && syncState.state;
    syncState = s;
    renderStatus();
    if ((s.state === 'signedOut') !== (before === 'signedOut')) renderBanner();
    if (s.rejected) {
      toast(t('rejectedChanges'), true);
      checkMembership();
    }
  }

  /** In the background: is this person still in the shop, and in the same role? */
  async function checkMembership() {
    if (!shop || !me()) return;
    var id = shop.id;
    var rows;
    try {
      rows = await cloud.rest('GET', 'shop_members', { query: { select: 'role', shop_id: 'eq.' + id, user_id: 'eq.' + me().id } });
    } catch (e) {
      return; // offline or signed out; the status line already says so
    }
    if (!shop || shop.id !== id) return;
    if (!rows.length) {
      var name = shopTitle();
      if (engine) engine.forget();
      storage.remove(cacheKeyFor(me().id, id));
      prefSet('pfl.shop', '');
      showGate('shops', { notice: t('accessGone', { shop: name }) });
      render();
      loadShops();
      return;
    }
    if (rows[0].role !== shop.role) {
      shop.role = rows[0].role;
      prefSet('pfl.shop', JSON.stringify({ id: shop.id, name: shop.name, role: shop.role, userId: me().id }));
      requestRender();
    }
  }

  async function loadShops() {
    if (!me()) { showGate('signin'); render(); return; }
    gate.shops = null;
    gate.shopsError = '';
    render();
    if (joinCode && await acceptInvite(joinCode)) return;
    try {
      var rows = await cloud.rest('GET', 'shop_members', {
        query: { select: 'shop_id,role,shops(name)', user_id: 'eq.' + me().id, order: 'joined_at.asc' }
      });
      if (mode !== 'gate') return;
      gate.shops = rows.map(function (r) {
        return { id: r.shop_id, role: r.role, name: (r.shops && r.shops.name) || '' };
      });
      if (gate.autoOpen && gate.shops.length === 1) {
        openShop(gate.shops[0]);
        return;
      }
    } catch (err) {
      if (mode !== 'gate') return;
      if (err.kind === 'auth') { showGate('signin'); render(); return; }
      gate.shopsError = t(errKey(err));
    }
    render();
  }

  async function acceptInvite(code) {
    try {
      var shopId = await cloud.rpc('join_shop', { p_code: code });
      joinCode = '';
      prefSet('pfl.join', '');
      var rows = await cloud.rest('GET', 'shop_members', {
        query: { select: 'role,shops(name)', shop_id: 'eq.' + shopId, user_id: 'eq.' + me().id }
      });
      var r = rows[0] || {};
      openShop({ id: shopId, role: r.role, name: (r.shops && r.shops.name) || '' });
      toast(t('joined', { shop: shopTitle() }));
      return true;
    } catch (err) {
      if (/invite_invalid/.test(err.message || '')) {
        joinCode = '';
        prefSet('pfl.join', '');
      }
      gate.joinError = t(errKey(err));
      return false;
    }
  }

  async function loadPeople() {
    if (!shop) return;
    var id = shop.id;
    people.loading = true;
    people.error = '';
    try {
      var members = await cloud.rest('GET', 'shop_members', {
        query: { select: 'user_id,role,email,joined_at', shop_id: 'eq.' + id, order: 'joined_at.asc' }
      });
      var invites = shop.role === 'owner'
        ? await cloud.rest('GET', 'shop_invites', {
            query: { select: 'code,role,expires_at', shop_id: 'eq.' + id, used_at: 'is.null', order: 'created_at.desc' }
          })
        : [];
      if (!shop || shop.id !== id) return;
      people.members = members;
      people.invites = invites.filter(function (v) { return Date.parse(v.expires_at) > Date.now(); });
    } catch (err) {
      if (!shop || shop.id !== id) return;
      people.error = t(errKey(err));
    }
    people.loading = false;
    people.loaded = true;
    if (ui.tab === 'setup' && mode === 'shop') requestRender();
  }

  function errKey(err) {
    if (!err) return 'errServer';
    if (err.kind === 'network') return 'errNetwork';
    var c = (err.code || '') + ' ' + (err.message || '');
    if (/invalid_credentials|invalid_grant|Invalid login/i.test(c)) return 'errBadLogin';
    if (/user_already_exists|already registered/i.test(c)) return 'errUserExists';
    if (/weak_password/i.test(c)) return 'errWeakPassword';
    if (/rate_limit|over_request|over_email/i.test(c)) return 'errRateLimit';
    if (/email_not_confirmed/i.test(c)) return 'errConfirmEmail';
    if (/email_address_not_authorized|sending confirmation/i.test(c)) return 'errEmailSetup';
    if (/signup_disabled/i.test(c)) return 'errSignupsOff';
    if (/email_address_invalid|validation_failed/i.test(c)) return 'errEmail';
    if (/invite_invalid/.test(c)) return 'errInviteInvalid';
    if (/name_required/.test(c)) return 'errShopName';
    if (/too_many_shops/.test(c)) return 'errTooManyShops';
    if (/too_many_invites/.test(c)) return 'errTooManyInvites';
    if (/not_owner|42501/.test(c) || err.status === 403) return 'errNotOwner';
    return 'errServer';
  }

  function pendingFor(userId) {
    var n = 0;
    var prefix = 'pfl.cache.' + userId + '.';
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) {
          var c = JSON.parse(localStorage.getItem(k) || 'null');
          if (c && c.outbox) n += Object.keys(c.outbox).length;
        }
      }
    } catch (e) { /* count what we can */ }
    return n;
  }

  function forgetDevice(userId) {
    var prefix = 'pfl.cache.' + userId + '.';
    var doomed = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) doomed.push(k);
      }
    } catch (e) { /* ignore */ }
    doomed.forEach(function (k) { storage.remove(k); });
  }

  function signOut() {
    var user = me();
    var n = user ? pendingFor(user.id) : 0;
    if (n && !confirm(t(n === 1 ? 'confirmSignOutPending1' : 'confirmSignOutPending', { n: n }))) return;
    if (engine) engine.forget();
    stopEngine();
    if (user) forgetDevice(user.id);
    prefSet('pfl.shop', '');
    prefSet('pfl.mode', '');
    cloud.signOut();
    showGate('start');
    render();
  }

  function afterSignIn(session) {
    prefSet('pfl.email', session.user.email);
    var last = readLastShop();
    if (gate.reauth && last && last.userId === session.user.id && !joinCode) {
      openShop(last);
      return;
    }
    showGate('shops', { autoOpen: true });
    loadShops();
  }

  /** Lock a form while it waits for the server; the button says "Loading…". */
  function busy(form, on) {
    Array.prototype.forEach.call(form.querySelectorAll('button, input, select'), function (el) { el.disabled = on; });
    var submit = form.querySelector('button[type="submit"]');
    if (!submit) return;
    if (on) {
      submit.setAttribute('data-label', submit.textContent);
      submit.textContent = t('loading');
    } else if (submit.hasAttribute('data-label')) {
      submit.textContent = submit.getAttribute('data-label');
    }
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
    if (mode === 'shop') {
      if (!engine.replaceAll(next)) toast(t('saveFailed'), true);
    } else {
      data = next;
      data.settings.lang = lang;
      persist(true);
    }
    resetDraft();
    ui.earningsWorker = '';
    render();
    toast(message);
  }

  function backupData() {
    var copy = JSON.parse(JSON.stringify(data));
    copy.demo = !!data.demo;
    return copy;
  }

  async function copyInvite() {
    var link = inviteLink(people.lastInvite.code);
    try {
      await navigator.clipboard.writeText(link);
      toast(t('linkCopied'));
    } catch (e) {
      var input = $('.invite-link');
      if (input) { input.focus(); input.select(); }
      toast(t('copyFailed'), true);
    }
  }

  function shareInvite() {
    var code = people.lastInvite.code;
    navigator.share({
      title: 'Pallet Floor Ledger',
      text: t('inviteShareText', { shop: shopTitle(), code: codeText(code) }),
      url: inviteLink(code)
    }).catch(function () { /* closed the share sheet */ });
  }

  async function removeMember(userId, email) {
    if (!confirm(t('confirmRemove', { email: email || '?' }))) return;
    try {
      var gone = await cloud.rest('DELETE', 'shop_members', {
        query: { shop_id: 'eq.' + shop.id, user_id: 'eq.' + userId },
        prefer: 'return=representation'
      });
      if (!gone || !gone.length) { toast(t('errNotOwner'), true); return; }
      toast(t('removed'));
    } catch (err) {
      toast(t(errKey(err)), true);
    }
    people.loaded = false;
    requestRender();
  }

  async function cancelInvite(code) {
    try {
      await cloud.rest('DELETE', 'shop_invites', { query: { code: 'eq.' + code } });
      if (people.lastInvite && people.lastInvite.code === code) people.lastInvite = null;
      toast(t('inviteCanceled'));
    } catch (err) {
      toast(t(errKey(err)), true);
    }
    people.loaded = false;
    requestRender();
  }

  function onClick(ev) {
    var el = ev.target.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');

    switch (action) {
      case 'tab':
        ui.tab = el.getAttribute('data-tab');
        prefSet('pfl.tab', ui.tab);
        if (ui.tab === 'setup' && mode === 'shop') people.loaded = false;
        render();
        window.scrollTo(0, 0);
        break;
      case 'lang':
        lang = el.getAttribute('data-lang') === 'es' ? 'es' : 'en';
        prefSet('pfl.lang', lang);
        if (data) {
          data.settings.lang = lang;
          if (mode === 'local') persist(true);
          else if (mode === 'shop') engine.save();
        }
        render();
        break;
      case 'gate': {
        var screen = el.getAttribute('data-screen');
        if (mode === 'local') prefSet('pfl.mode', '');
        showGate(screen);
        render();
        window.scrollTo(0, 0);
        break;
      }
      case 'use-local':
        prefSet('pfl.mode', 'local');
        openLocal();
        render();
        break;
      case 'reload-shops':
        loadShops();
        break;
      case 'open-shop': {
        var id = el.getAttribute('data-id');
        var found = (gate.shops || []).filter(function (s) { return s.id === id; })[0];
        if (found) openShop(found);
        break;
      }
      case 'switch-shop':
        showGate('shops');
        loadShops();
        break;
      case 'sign-out':
        signOut();
        break;
      case 'reauth':
        showGate('signin', { reauth: true });
        render();
        break;
      case 'reload-people':
        people.loaded = false;
        render();
        break;
      case 'remove-member':
        removeMember(el.getAttribute('data-id'), el.getAttribute('data-email'));
        break;
      case 'cancel-invite':
        cancelInvite(el.getAttribute('data-id'));
        break;
      case 'copy-invite':
        copyInvite();
        break;
      case 'share-invite':
        shareInvite();
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
        var wid = el.getAttribute('data-id');
        var at = ui.draft.workerIds.indexOf(wid);
        if (at >= 0) ui.draft.workerIds.splice(at, 1); else ui.draft.workerIds.push(wid);
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
        download('pallet-floor-ledger-backup-' + today() + '.json', JSON.stringify(backupData(), null, 2), 'application/json');
        toast(t('downloaded'));
        break;
      case 'load-demo':
        if (mode !== 'local' || !confirm(t('confirmDemo'))) return;
        replaceData(Demo.build(today(), lang), t('demoLoaded'));
        break;
      case 'erase':
        if (mode !== 'local' || !confirm(t('confirmErase'))) return;
        replaceData(Store.empty(lang), t('erased'));
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
        if (!isOwner()) return;
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
        if (!isOwner()) return;
        var it = findItem(id);
        if (it) { it.active = el.checked; persist(); }
        break;
      }
      case 'restore-file': {
        var file = el.files && el.files[0];
        el.value = '';
        if (!file || !isOwner()) return;
        var reader = new FileReader();
        reader.onload = function () {
          var next = null;
          try { next = JSON.parse(String(reader.result)); } catch (e) { next = null; }
          if (!Store.valid(next)) { toast(t('restoreFailed'), true); return; }
          if (!confirm(t(mode === 'shop' ? 'confirmRestoreShop' : 'confirmRestore'))) return;
          if (mode === 'shop') next.demo = false;
          replaceData(next, t('restored'));
        };
        reader.onerror = function () { toast(t('restoreFailed'), true); };
        reader.readAsText(file);
        break;
      }
    }
  }

  async function onSubmit(ev) {
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
      case 'signin':
      case 'signup': {
        var email = f.email.value.trim();
        var password = f.password.value;
        gate.email = email;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('gate-error', 'errEmail');
        if (kind === 'signup' ? password.length < 8 : !password) return fail('gate-error', 'errPassword');
        document.getElementById('gate-error').textContent = '';
        busy(form, true);
        try {
          if (kind === 'signin') {
            afterSignIn(await cloud.signIn(email, password));
          } else {
            var out = await cloud.signUp(email, password);
            if (out.needsConfirm) {
              showGate('signin', { notice: t('errConfirmEmail') });
              render();
            } else {
              afterSignIn(out.session);
            }
          }
        } catch (err) {
          busy(form, false);
          fail('gate-error', errKey(err));
        }
        break;
      }
      case 'join-shop': {
        var code = normalizeCode(f.code.value);
        if (code.length < 6) return fail('join-error', 'errInviteInvalid');
        busy(form, true);
        gate.joinError = '';
        if (!(await acceptInvite(code))) {
          busy(form, false);
          var box = document.getElementById('join-error');
          if (box) box.textContent = gate.joinError;
        }
        break;
      }
      case 'create-shop': {
        var shopName = f.name.value.trim();
        if (!shopName) return fail('create-error', 'errShopName');
        var copy = !!(f.copy && f.copy.checked);
        busy(form, true);
        try {
          var shopId = await cloud.rpc('create_shop', { shop_name: shopName });
          var initial = copy && localRealData() ? JSON.parse(JSON.stringify(localRealData())) : Store.empty(lang);
          initial.demo = false;
          initial.settings.shopName = shopName;
          initial.settings.lang = lang;
          ui.tab = copy ? 'tally' : 'setup';
          prefSet('pfl.tab', ui.tab);
          openShop({ id: shopId, name: shopName, role: 'owner' }, { initialData: initial, uploadAll: true });
          toast(t('shopCreated'));
        } catch (err) {
          busy(form, false);
          fail('create-error', errKey(err));
        }
        break;
      }
      case 'create-invite': {
        var role = f.role.value === 'owner' ? 'owner' : 'supervisor';
        busy(form, true);
        try {
          var newCode = await cloud.rpc('create_invite', { p_shop: shop.id, p_role: role });
          people.lastInvite = { code: newCode, role: role };
          people.loaded = false;
          render();
          var panel = $('.invite');
          if (panel) panel.scrollIntoView({ block: 'nearest' });
        } catch (err) {
          busy(form, false);
          fail('invite-error', errKey(err));
        }
        break;
      }
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
        if (!isOwner()) return;
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
        if (!isOwner()) return;
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

  function readJoinCode() {
    try {
      var params = new URLSearchParams(location.search);
      var c = normalizeCode(params.get('join'));
      if (c) {
        prefSet('pfl.join', c);
        params.delete('join');
        var rest = params.toString();
        history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
      }
    } catch (e) { /* old browser: type the code instead */ }
    joinCode = normalizeCode(prefGet('pfl.join'));
  }

  function boot() {
    if (!cloud) {
      openLocal();
      return;
    }
    readJoinCode();
    var user = me();
    if (user) {
      var last = readLastShop();
      if (last && last.userId === user.id && !joinCode && Sync.hasCache(storage, cacheKeyFor(user.id, last.id))) {
        if (!lang) lang = defaultLang();
        openShop(last);
        checkMembership();
      } else {
        showGate('shops', { autoOpen: true });
        loadShops();
      }
    } else if (prefGet('pfl.mode') === 'local' && !joinCode) {
      openLocal();
    } else {
      showGate('start');
    }
  }

  document.addEventListener('click', onClick);
  var view = $('#view');
  view.addEventListener('input', onInput);
  view.addEventListener('change', onChange);
  view.addEventListener('submit', onSubmit);
  view.addEventListener('focusout', function () {
    setTimeout(function () { if (renderPending && !typing()) render(); }, 0);
  });

  document.addEventListener('visibilitychange', function () {
    if (engine && !document.hidden) {
      engine.syncNow();
      checkMembership();
    }
  });
  window.addEventListener('online', function () { if (engine) engine.syncNow(); });
  window.addEventListener('storage', function (e) {
    if (engine && e.key === engine.cacheKey) engine.reload();
    // Signed out in another tab.
    if (cloud && e.key === cloud.sessionKey && !e.newValue && mode === 'shop') {
      showGate('start');
      render();
    }
  });

  boot();
  render();
  if (startupNotice) toast(t(startupNotice), true);
})();
