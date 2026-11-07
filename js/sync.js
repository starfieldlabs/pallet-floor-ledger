/*
 * Pallet Floor Ledger — keeps one shop's data the same on every device.
 *
 * The shop's data is split into records: the shop settings, each worker, each
 * rate-card line, each count, and each person's hours on each day.
 *
 * - Every change made on this device goes into an outbox, which is saved on the
 *   device. The outbox is sent to the server when there is a connection, so
 *   counts entered with no signal are not lost.
 * - The device asks the server what changed since it last asked and applies it,
 *   except for records it still has unsent changes to.
 * - The last change to reach the server wins, record by record. Two people
 *   editing different things never overwrite each other.
 *
 * The server side is passed in as `remote`, so this file has no network code and
 * can be tested in Node.
 */
(function (root) {
  'use strict';

  var CACHE_VERSION = 1;
  var OVERLAP_MS = 60 * 1000;   // re-read the last minute of changes on every pull
  var LIST = { worker: 'workers', item: 'items', entry: 'entries' };

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /** JSON with sorted keys, so the same record always gives the same text. */
  function canon(v) {
    if (v === null || typeof v !== 'object') {
      var s = JSON.stringify(v);
      return s === undefined ? 'null' : s;
    }
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort()
      .map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
  }

  function splitKey(key) {
    var i = key.indexOf(':');
    return { kind: key.slice(0, i), id: key.slice(i + 1) };
  }

  /** Settings everyone in the shop shares. The language is each person's own choice. */
  function sharedSettings(settings) {
    var s = {};
    for (var k in settings) if (hasOwn(settings, k) && k !== 'lang') s[k] = settings[k];
    return s;
  }

  /** key → canonical JSON for every record in the data. */
  function snapshot(data) {
    var snap = Object.create(null);
    snap['settings:shop'] = canon(sharedSettings(data.settings || {}));
    Object.keys(LIST).forEach(function (kind) {
      data[LIST[kind]].forEach(function (x) { snap[kind + ':' + x.id] = canon(x); });
    });
    Object.keys(data.hours).forEach(function (date) {
      var day = data.hours[date] || {};
      Object.keys(day).forEach(function (wid) {
        snap['hours:' + date + '|' + wid] = canon({ date: date, workerId: wid, hours: day[wid] });
      });
    });
    return snap;
  }

  /** Apply server rows to the data, in place. Rows: { kind, id, data, deleted }. */
  function applyRows(data, rows) {
    var maps = {};
    function mapFor(kind) {
      if (!maps[kind]) {
        var m = new Map();
        data[LIST[kind]].forEach(function (x) { m.set(x.id, x); });
        maps[kind] = m;
      }
      return maps[kind];
    }
    rows.forEach(function (r) {
      if (r.kind === 'settings') {
        if (!r.deleted && r.data) {
          var lang = data.settings.lang;
          data.settings = Object.assign({}, data.settings, r.data);
          if (lang) data.settings.lang = lang;
        }
      } else if (LIST[r.kind]) {
        var m = mapFor(r.kind);
        if (r.deleted) m.delete(r.id);
        else m.set(r.id, r.data.id === r.id ? r.data : Object.assign({}, r.data, { id: r.id }));
      } else if (r.kind === 'hours') {
        var bar = r.id.indexOf('|');
        var date = r.id.slice(0, bar);
        var wid = r.id.slice(bar + 1);
        var h = r.deleted ? 0 : Number(r.data && r.data.hours);
        if (h > 0) {
          (data.hours[date] = data.hours[date] || {})[wid] = h;
        } else if (data.hours[date]) {
          delete data.hours[date][wid];
          if (!Object.keys(data.hours[date]).length) delete data.hours[date];
        }
      }
    });
    Object.keys(maps).forEach(function (kind) { data[LIST[kind]] = Array.from(maps[kind].values()); });
  }

  function later(a, b) { return !b || Date.parse(a) > Date.parse(b); }

  /**
   * opts:
   *   shopId, cacheKey, storage { get, set, remove }, remote { pull(q), push(rows) }
   *   initialData   data to start from when this device has nothing saved for the shop
   *   uploadAll     true for a brand-new shop: send everything in initialData
   *   onChange()    data changed because of another device
   *   onStatus(s)   { state, pending, error, rejected }
   *   pageSize, batchSize, pushDelay
   */
  function createEngine(opts) {
    var storage = opts.storage;
    var remote = opts.remote;
    var pageSize = opts.pageSize || 1000;
    var batchSize = opts.batchSize || 500;
    var pushDelay = opts.pushDelay == null ? 700 : opts.pushDelay;
    var onChange = opts.onChange || function () {};
    var onStatus = opts.onStatus || function () {};

    var state = readCache();
    var fresh = !state;
    if (fresh) {
      state = { v: CACHE_VERSION, data: opts.initialData, outbox: {}, cursor: null, seq: 0 };
    }
    var data = state.data;
    var known = fresh && opts.uploadAll ? Object.create(null) : snapshot(data);
    if (fresh && opts.uploadAll) diffLocal();
    if (fresh) persist();

    var status = { state: Object.keys(state.outbox).length ? 'pending' : 'idle', pending: 0, error: null };
    var running = null;
    var again = false;
    var failures = 0;
    var pushTimer = null;
    var retryTimer = null;
    var stopped = false;
    var forgotten = false;

    function readCache() {
      var raw = storage.get(opts.cacheKey);
      if (!raw) return null;
      try {
        var s = JSON.parse(raw);
        if (s && s.v === CACHE_VERSION && s.data && s.outbox) return s;
      } catch (e) { /* unreadable: start over from the server */ }
      return null;
    }

    function persist() {
      if (forgotten) return false;
      try {
        storage.set(opts.cacheKey, JSON.stringify(state));
        return true;
      } catch (e) {
        return false;
      }
    }

    function pending() { return Object.keys(state.outbox).length; }

    function setStatus(name, error, extra) {
      status = { state: name, pending: pending(), error: error || null };
      if (extra) for (var k in extra) status[k] = extra[k];
      if (!stopped) onStatus(status);
    }

    /** Put every local change since the last call into the outbox. */
    function diffLocal() {
      var snap = snapshot(data);
      var n = 0;
      Object.keys(snap).forEach(function (k) {
        if (snap[k] !== known[k]) {
          var p = splitKey(k);
          state.outbox[k] = { kind: p.kind, id: p.id, data: JSON.parse(snap[k]), deleted: false, v: ++state.seq };
          n++;
        }
      });
      Object.keys(known).forEach(function (k) {
        if (!(k in snap)) {
          var p = splitKey(k);
          state.outbox[k] = { kind: p.kind, id: p.id, data: {}, deleted: true, v: ++state.seq };
          n++;
        }
      });
      known = snap;
      return n;
    }

    function timer(fn, ms) {
      var t = setTimeout(fn, ms);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    }

    /** Call after changing the data. Returns false if this device could not save it. */
    function save() {
      var n = diffLocal();
      var ok = persist();
      if (n && !stopped) {
        clearTimeout(pushTimer);
        pushTimer = timer(syncNow, pushDelay);
        if (status.state !== 'offline' && status.state !== 'signedOut') setStatus('saving');
        else setStatus(status.state, status.error);
      }
      return ok;
    }

    function toRow(o) {
      return { shop_id: opts.shopId, kind: o.kind, id: o.id, data: o.data, deleted: o.deleted };
    }

    function settle(sent) {
      sent.forEach(function (s) {
        var cur = state.outbox[s.key];
        if (cur && cur.v === s.v) delete state.outbox[s.key];
      });
      persist();
    }

    async function pushAll() {
      var rejected = 0;
      var keys = Object.keys(state.outbox);
      while (keys.length) {
        var chunk = keys.slice(0, batchSize);
        keys = keys.slice(batchSize);
        var sent = chunk.filter(function (k) { return state.outbox[k]; }).map(function (k) {
          return { key: k, v: state.outbox[k].v, row: toRow(state.outbox[k]) };
        });
        if (!sent.length) continue;
        try {
          await remote.push(sent.map(function (s) { return s.row; }));
          settle(sent);
        } catch (err) {
          if (!err || err.kind !== 'rejected') throw err;
          // Something in the batch is not allowed. Send one at a time to find it.
          rejected += await pushOneByOne(sent);
        }
      }
      return rejected;
    }

    async function pushOneByOne(sent) {
      var rejected = 0;
      for (var i = 0; i < sent.length; i++) {
        var s = sent[i];
        try {
          await remote.push([s.row]);
          settle([s]);
        } catch (err) {
          if (!err || err.kind !== 'rejected') throw err;
          rejected++;
          settle([s]);   // drop it; the full download below puts back the server's copy
        }
      }
      if (rejected) {
        state.cursor = null;
        persist();
      }
      return rejected;
    }

    async function pullAll() {
      diffLocal();
      var full = !state.cursor;
      var since = full ? null : new Date(Date.parse(state.cursor) - OVERLAP_MS).toISOString();
      var rows = [];
      var seen = Object.create(null);
      var maxTs = state.cursor;
      for (var offset = 0; ; ) {
        var page = await remote.pull({ since: since, offset: offset, limit: pageSize, liveOnly: full });
        page.forEach(function (r) {
          rows.push(r);
          seen[r.kind + ':' + r.id] = true;
          if (later(r.updated_at, maxTs)) maxTs = r.updated_at;
        });
        if (page.length < pageSize) break;
        offset += page.length;
      }

      var apply = rows.filter(function (r) {
        var k = r.kind + ':' + r.id;
        if (hasOwn(state.outbox, k)) return false;          // our unsent change wins for now
        return r.deleted ? (k in known) : canon(r.data) !== known[k];
      });
      if (full) {
        // A full download is the whole truth: drop what the server does not have,
        // unless it is still waiting to be sent.
        Object.keys(known).forEach(function (k) {
          if (!seen[k] && !hasOwn(state.outbox, k) && k !== 'settings:shop') {
            var p = splitKey(k);
            apply.push({ kind: p.kind, id: p.id, data: {}, deleted: true });
          }
        });
      }
      if (apply.length) {
        applyRows(data, apply);
        known = snapshot(data);
      }
      if (maxTs) state.cursor = maxTs;
      persist();
      return apply.length;
    }

    function backoff() {
      return Math.min(60000, 5000 * Math.pow(2, Math.max(0, failures - 1)));
    }

    /** Send waiting changes, then fetch other devices' changes. Safe to call often. */
    function syncNow() {
      if (stopped) return Promise.resolve();
      if (running) { again = true; return running; }
      clearTimeout(pushTimer);
      clearTimeout(retryTimer);
      running = (async function () {
        var changed = 0;
        var rejected = 0;
        try {
          do {
            again = false;
            if (pending()) setStatus('saving');
            rejected += await pushAll();
            changed += await pullAll();
          } while (again && !stopped);
          failures = 0;
          setStatus(pending() ? 'saving' : 'synced', null, rejected ? { rejected: rejected } : null);
          if (pending() && !stopped) pushTimer = timer(syncNow, pushDelay);
        } catch (err) {
          failures++;
          var kind = err && err.kind;
          if (kind === 'auth') {
            setStatus('signedOut', err);
          } else {
            setStatus(kind === 'network' ? 'offline' : 'error', err);
            if (!stopped) retryTimer = timer(syncNow, backoff());
          }
        } finally {
          running = null;
        }
        if (changed && !stopped) onChange();
      })();
      return running;
    }

    /** Another tab on this device saved the same shop: load what it saved. */
    function reload() {
      var s = readCache();
      if (!s) return;
      var lang = data.settings && data.settings.lang;
      Object.keys(s.data).forEach(function (k) { data[k] = s.data[k]; });
      if (lang) data.settings.lang = lang;
      state.outbox = s.outbox;
      state.cursor = s.cursor;
      state.seq = Math.max(state.seq, s.seq || 0);
      known = snapshot(data);
      setStatus(pending() ? status.state : 'synced', status.error);
      onChange();
    }

    /** Replace all of the shop's data (restore from backup). Every device gets it. */
    function replaceAll(next) {
      var lang = data.settings.lang;
      data.settings = Object.assign({}, next.settings, { lang: lang });
      data.workers = next.workers;
      data.items = next.items;
      data.hours = next.hours;
      data.entries = next.entries;
      return save();
    }

    function stop() {
      stopped = true;
      clearTimeout(pushTimer);
      clearTimeout(retryTimer);
    }

    /** Stop and delete this shop from the device, including anything still on its way. */
    function forget() {
      stop();
      forgotten = true;
      storage.remove(opts.cacheKey);
    }

    return {
      data: data,
      cacheKey: opts.cacheKey,
      save: save,
      syncNow: syncNow,
      reload: reload,
      replaceAll: replaceAll,
      pending: pending,
      status: function () { return status; },
      stop: stop,
      forget: forget
    };
  }

  function hasCache(storage, cacheKey) {
    return !!storage.get(cacheKey);
  }

  root.Sync = {
    createEngine: createEngine,
    hasCache: hasCache,
    snapshot: snapshot,
    applyRows: applyRows,
    canon: canon
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Sync;
})(this);
