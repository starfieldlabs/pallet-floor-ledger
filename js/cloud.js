/*
 * Pallet Floor Ledger — talks to the Supabase project: sign-in and the database.
 *
 * Plain fetch calls to Supabase's documented HTTP endpoints, so the app still
 * has no build step and no third-party code. The sign-in is kept in this
 * browser and renewed automatically; the server checks every request against
 * the access rules in supabase/schema.sql.
 *
 * Errors carry .kind:
 *   network   no connection (try again later)
 *   auth      not signed in, or the sign-in can no longer be renewed
 *   rejected  the server refused this change (access rules or bad data)
 *   server    anything else (try again later)
 */
(function (root) {
  'use strict';

  var SESSION_KEY = 'pfl.session';
  var TIMEOUT_MS = 20000;
  var RENEW_EARLY_MS = 60000;
  var REFUSED_CODES = /^(42501|23502|23503|23514|22P02|22023|P0001)$/;

  function cloudError(kind, status, code, message) {
    var e = new Error(message || kind);
    e.kind = kind;
    e.status = status || 0;
    e.code = code || '';
    return e;
  }

  function create(opts) {
    var base = String(opts.url || '').replace(/\/+$/, '');
    var key = opts.key;
    var storage = opts.storage;
    var fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : globalThis) : null);
    var now = opts.now || Date.now;
    var renewing = null;

    function readSession() {
      try {
        var s = JSON.parse(storage.get(SESSION_KEY) || 'null');
        return s && s.access_token && s.refresh_token && s.user && s.user.id ? s : null;
      } catch (e) {
        return null;
      }
    }

    function writeSession(s) {
      try {
        if (s) storage.set(SESSION_KEY, JSON.stringify(s));
        else storage.remove(SESSION_KEY);
      } catch (e) { /* the sign-in just won't survive a reload */ }
    }

    function toSession(r) {
      var expiresAt = r.expires_at ? r.expires_at * 1000 : now() + (r.expires_in || 3600) * 1000;
      return {
        access_token: r.access_token,
        refresh_token: r.refresh_token,
        expires_at: expiresAt,
        user: { id: r.user && r.user.id, email: (r.user && r.user.email) || '' }
      };
    }

    async function request(url, init) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
      if (ctrl) init.signal = ctrl.signal;
      var res, text;
      try {
        res = await fetchImpl(url, init);
        text = await res.text();
      } catch (e) {
        throw cloudError('network', 0, '', e && e.message);
      } finally {
        if (timer) clearTimeout(timer);
      }
      var body = null;
      if (text) {
        try { body = JSON.parse(text); } catch (e) { body = text; }
      }
      return { status: res.status, ok: res.ok, body: body };
    }

    function authError(r) {
      var b = r.body && typeof r.body === 'object' ? r.body : {};
      var kind = r.status === 429 || r.status >= 500 ? 'server' : 'auth';
      return cloudError(kind, r.status, b.error_code || b.error || '', b.msg || b.message || b.error_description || '');
    }

    async function authCall(path, body, token) {
      var headers = { apikey: key, 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      var r = await request(base + '/auth/v1/' + path, { method: 'POST', headers: headers, body: JSON.stringify(body || {}) });
      if (!r.ok) throw authError(r);
      return r.body;
    }

    async function signIn(email, password) {
      var s = toSession(await authCall('token?grant_type=password', { email: email, password: password }));
      writeSession(s);
      return s;
    }

    /** Returns { session } or, if the project asks people to confirm their email first, { needsConfirm: true }. */
    async function signUp(email, password) {
      var b = await authCall('signup', { email: email, password: password });
      if (b && b.access_token) {
        var s = toSession(b);
        writeSession(s);
        return { session: s };
      }
      return { needsConfirm: true };
    }

    async function signOut() {
      var s = readSession();
      writeSession(null);
      if (s) {
        try { await authCall('logout', {}, s.access_token); } catch (e) { /* already signed out here */ }
      }
    }

    /** Get a new access token. `stale` is the token that stopped working. */
    function renew(stale) {
      if (renewing) return renewing;
      renewing = (async function () {
        var s = readSession();
        if (!s) throw cloudError('auth', 401, 'no_session', 'Not signed in');
        // Another tab may have renewed it already.
        if (s.access_token !== stale && s.expires_at - now() > RENEW_EARLY_MS) return s;
        try {
          var next = toSession(await authCall('token?grant_type=refresh_token', { refresh_token: s.refresh_token }));
          writeSession(next);
          return next;
        } catch (e) {
          if (e.kind === 'auth') {
            var other = readSession();
            if (other && other.refresh_token !== s.refresh_token) return other;
            writeSession(null);
          }
          throw e;
        }
      })();
      return renewing.finally(function () { renewing = null; });
    }

    async function token() {
      var s = readSession();
      if (!s) throw cloudError('auth', 401, 'no_session', 'Not signed in');
      if (s.expires_at - now() < RENEW_EARLY_MS) s = await renew(s.access_token);
      return s.access_token;
    }

    function queryString(q) {
      if (!q) return '';
      var parts = [];
      Object.keys(q).forEach(function (k) {
        if (q[k] != null) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(q[k]));
      });
      return parts.length ? '?' + parts.join('&') : '';
    }

    function restError(r) {
      var b = r.body && typeof r.body === 'object' ? r.body : {};
      var code = String(b.code || '');
      var kind = r.status === 401 ? 'auth'
        : (r.status === 403 || REFUSED_CODES.test(code)) ? 'rejected'
        : 'server';
      return cloudError(kind, r.status, code, b.message || '');
    }

    /** A database call. o: { query, body, prefer }. Returns the parsed reply (or null). */
    async function rest(method, path, o) {
      o = o || {};
      var url = base + '/rest/v1/' + path + queryString(o.query);
      for (var attempt = 0; ; attempt++) {
        var tok = await token();
        var headers = { apikey: key, Authorization: 'Bearer ' + tok, Accept: 'application/json' };
        if (o.body !== undefined) headers['Content-Type'] = 'application/json';
        if (o.prefer) headers.Prefer = o.prefer;
        var init = { method: method, headers: headers };
        if (o.body !== undefined) init.body = JSON.stringify(o.body);
        var r = await request(url, init);
        if (r.ok) return r.body;
        if (r.status === 401 && attempt === 0) {
          await renew(tok);
          continue;
        }
        throw restError(r);
      }
    }

    function rpc(name, args) {
      return rest('POST', 'rpc/' + name, { body: args || {} });
    }

    return {
      session: readSession,
      signIn: signIn,
      signUp: signUp,
      signOut: signOut,
      rest: rest,
      rpc: rpc,
      sessionKey: SESSION_KEY
    };
  }

  root.Cloud = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Cloud;
})(this);
