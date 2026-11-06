/* Pallet Floor Ledger — saving to this browser. v0 keeps everything on one device. */
(function (root) {
  'use strict';

  var KEY = 'pallet-floor-ledger.v1';

  function valid(d) {
    return !!d && d.version === 1 && !!d.settings &&
      Array.isArray(d.workers) && Array.isArray(d.items) && Array.isArray(d.entries) &&
      !!d.hours && typeof d.hours === 'object';
  }

  function empty(lang) {
    return {
      version: 1,
      demo: false,
      settings: {
        shopName: '',
        lang: lang || 'en',
        minWageCents: 725,
        overtimeAfterHours: 40,
        weekStartDay: 1
      },
      workers: [],
      items: [],
      hours: {},
      entries: []
    };
  }

  /** Returns { status: 'ok' | 'none' | 'corrupt' | 'unavailable', data } */
  function load() {
    var raw;
    try {
      raw = root.localStorage.getItem(KEY);
    } catch (e) {
      return { status: 'unavailable', data: null };
    }
    if (!raw) return { status: 'none', data: null };
    try {
      var d = JSON.parse(raw);
      if (valid(d)) return { status: 'ok', data: d };
    } catch (e) { /* fall through */ }
    // Keep the damaged copy rather than overwrite it.
    try { root.localStorage.setItem(KEY + '.damaged-' + Date.now(), raw); } catch (e) { /* ignore */ }
    return { status: 'corrupt', data: null };
  }

  function save(d) {
    try {
      root.localStorage.setItem(KEY, JSON.stringify(d));
      return true;
    } catch (e) {
      return false;
    }
  }

  root.Store = { load: load, save: save, valid: valid, empty: empty };
})(this);
