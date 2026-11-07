// Run with: npm test
// The Supabase connection, against a fake fetch: sign-in, renewing the sign-in,
// and sorting errors into "try again later" and "refused".
const test = require('node:test');
const assert = require('node:assert/strict');
const Cloud = require('../js/cloud.js');

const URL_ = 'https://example.supabase.co';
const KEY = 'sb_publishable_test';

function memoryStorage() {
  const m = new Map();
  return { map: m, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) };
}

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => (body == null ? '' : JSON.stringify(body)) };
}

function tokenReply(n, nowSec) {
  return { access_token: 'access-' + n, refresh_token: 'refresh-' + n, expires_in: 3600, expires_at: nowSec + 3600, user: { id: 'user-1', email: 'boss@yard.test' } };
}

function setup(handler, startMs = Date.parse('2026-11-07T12:00:00Z')) {
  let clock = startMs;
  const calls = [];
  const storage = memoryStorage();
  const cloud = Cloud.create({
    url: URL_ + '/', key: KEY, storage, now: () => clock,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init, calls.length);
    }
  });
  return { cloud, calls, storage, advance: (ms) => { clock += ms; }, nowSec: () => Math.floor(clock / 1000) };
}

test('signing in keeps the sign-in and sends it with database calls', async () => {
  const t = setup((url) => {
    if (url.includes('/auth/v1/token?grant_type=password')) return reply(200, tokenReply(1, Math.floor(Date.parse('2026-11-07T12:00:00Z') / 1000)));
    if (url.includes('/rest/v1/records')) return reply(200, [{ kind: 'worker', id: 'w1' }]);
    return reply(404, {});
  });
  const s = await t.cloud.signIn('boss@yard.test', 'secret123');
  assert.equal(s.user.id, 'user-1');
  assert.equal(t.cloud.session().access_token, 'access-1');

  const rows = await t.cloud.rest('GET', 'records', { query: { shop_id: 'eq.abc', select: 'kind,id' } });
  assert.deepEqual(rows, [{ kind: 'worker', id: 'w1' }]);
  const last = t.calls.at(-1);
  assert.equal(last.url, URL_ + '/rest/v1/records?shop_id=eq.abc&select=kind%2Cid');
  assert.equal(last.init.headers.apikey, KEY);
  assert.equal(last.init.headers.Authorization, 'Bearer access-1');
  assert.equal(JSON.parse(t.calls[0].init.body).email, 'boss@yard.test');
});

test('a sign-in about to expire is renewed before the call', async () => {
  const t = setup((url) => {
    if (url.includes('grant_type=password')) return reply(200, tokenReply(1, t.nowSec()));
    if (url.includes('grant_type=refresh_token')) return reply(200, tokenReply(2, t.nowSec()));
    return reply(200, []);
  });
  await t.cloud.signIn('boss@yard.test', 'secret123');
  t.advance(3570 * 1000); // 30 seconds left
  await t.cloud.rest('GET', 'records');
  const urls = t.calls.map((c) => c.url.replace(URL_, ''));
  assert.deepEqual(urls, ['/auth/v1/token?grant_type=password', '/auth/v1/token?grant_type=refresh_token', '/rest/v1/records']);
  assert.equal(JSON.parse(t.calls[1].init.body).refresh_token, 'refresh-1');
  assert.equal(t.calls[2].init.headers.Authorization, 'Bearer access-2');
});

test('a refused token is renewed once and the call is tried again', async () => {
  let restCalls = 0;
  const t = setup((url) => {
    if (url.includes('grant_type=password')) return reply(200, tokenReply(1, t.nowSec()));
    if (url.includes('grant_type=refresh_token')) return reply(200, tokenReply(2, t.nowSec()));
    restCalls++;
    return restCalls === 1 ? reply(401, { code: 'PGRST303', message: 'JWT expired' }) : reply(201, null);
  });
  await t.cloud.signIn('boss@yard.test', 'secret123');
  const out = await t.cloud.rest('POST', 'records', { body: [{ kind: 'worker' }], prefer: 'return=minimal' });
  assert.equal(out, null);
  assert.equal(restCalls, 2);
  assert.equal(t.calls.at(-1).init.headers.Authorization, 'Bearer access-2');
  assert.equal(t.calls.at(-1).init.headers.Prefer, 'return=minimal');
});

test('when the sign-in cannot be renewed, it is cleared and the error says so', async () => {
  const t = setup((url) => {
    if (url.includes('grant_type=password')) return reply(200, tokenReply(1, t.nowSec()));
    if (url.includes('grant_type=refresh_token')) return reply(400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
    return reply(401, { message: 'JWT expired' });
  });
  await t.cloud.signIn('boss@yard.test', 'secret123');
  await assert.rejects(t.cloud.rest('GET', 'records'), (e) => e.kind === 'auth');
  assert.equal(t.cloud.session(), null);
});

test('a busy sign-in server does not sign people out', async () => {
  const t = setup((url) => {
    if (url.includes('grant_type=password')) return reply(200, tokenReply(1, t.nowSec()));
    if (url.includes('grant_type=refresh_token')) return reply(429, { error_code: 'over_request_rate_limit' });
    return reply(200, []);
  });
  await t.cloud.signIn('boss@yard.test', 'secret123');
  t.advance(3590 * 1000);
  await assert.rejects(t.cloud.rest('GET', 'records'), (e) => e.kind === 'server');
  assert.ok(t.cloud.session(), 'still signed in');
});

test('errors are sorted into "try again later" and "refused"', async () => {
  let next;
  const t = setup((url) => {
    if (url.includes('grant_type=password')) return reply(200, tokenReply(1, t.nowSec()));
    return next();
  });
  await t.cloud.signIn('boss@yard.test', 'secret123');

  next = () => reply(403, { code: '42501', message: 'new row violates row-level security policy' });
  await assert.rejects(t.cloud.rest('POST', 'records', { body: [] }), (e) => e.kind === 'rejected' && e.code === '42501');
  next = () => reply(400, { code: 'P0001', message: 'invite_invalid' });
  await assert.rejects(t.cloud.rpc('join_shop', { p_code: 'X' }), (e) => e.kind === 'rejected' && e.message === 'invite_invalid');
  next = () => reply(503, { message: 'unavailable' });
  await assert.rejects(t.cloud.rest('GET', 'records'), (e) => e.kind === 'server');
  next = () => reply(404, { code: '42P01', message: 'relation "public.records" does not exist' });
  await assert.rejects(t.cloud.rest('GET', 'records'), (e) => e.kind === 'server', 'a missing table must not throw away waiting changes');
  next = () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(t.cloud.rest('GET', 'records'), (e) => e.kind === 'network');
});

test('signing up when the project asks for email confirmation', async () => {
  const t = setup(() => reply(200, { id: 'user-2', email: 'new@yard.test', confirmation_sent_at: '2026-11-07T12:00:00Z' }));
  const out = await t.cloud.signUp('new@yard.test', 'secret123');
  assert.deepEqual(out, { needsConfirm: true });
  assert.equal(t.cloud.session(), null);
});

test('wrong password', async () => {
  const t = setup(() => reply(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }));
  await assert.rejects(t.cloud.signIn('boss@yard.test', 'nope'), (e) => e.kind === 'auth' && e.code === 'invalid_credentials');
});
