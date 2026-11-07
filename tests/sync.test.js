// Run with: npm test
// Two or more "devices" share one fake server that behaves like the Supabase
// records table: the server stamps the time, re-orders JSON keys like Postgres
// jsonb does, and refuses rate-card and settings changes from supervisors.
const test = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../js/sync.js');

const SHOP = 'shop-1';

function emptyData(lang) {
  return {
    version: 1, demo: false,
    settings: { shopName: 'Test Yard', lang: lang || 'en', minWageCents: 725, overtimeAfterHours: 40, weekStartDay: 1 },
    workers: [], items: [], hours: {}, entries: []
  };
}

// Postgres jsonb stores keys sorted by length, then alphabetically.
function jsonbOrder(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(jsonbOrder);
  const out = {};
  Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).forEach((k) => { out[k] = jsonbOrder(v[k]); });
  return out;
}

function fakeServer() {
  const rows = new Map();
  let micros = Date.parse('2026-11-07T12:00:00Z') * 1000;
  let down = false;
  const calls = { pull: 0, push: 0 };

  function stamp() {
    micros += 137; // a little time passes between writes
    const ms = Math.floor(micros / 1000);
    const iso = new Date(ms).toISOString();
    return iso.slice(0, 23) + String(micros % 1000).padStart(3, '0') + '+00:00';
  }
  function fail(kind) { const e = new Error(kind); e.kind = kind; return e; }

  return {
    rows,
    calls,
    setDown(v) { down = v; },
    remote(role) {
      return {
        async pull(q) {
          calls.pull++;
          if (down) throw fail('network');
          const list = [...rows.values()]
            .filter((r) => r.shop_id === SHOP)
            .filter((r) => !q.since || Date.parse(r.updated_at) > Date.parse(q.since))
            .filter((r) => !q.liveOnly || !r.deleted)
            .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0) ||
              (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.id < b.id ? -1 : 1));
          return JSON.parse(JSON.stringify(list.slice(q.offset, q.offset + q.limit)))
            .map(({ kind, id, data, deleted, updated_at }) => ({ kind, id, data, deleted, updated_at }));
        },
        async push(batch) {
          calls.push++;
          if (down) throw fail('network');
          // One statement: all or nothing, like Postgres.
          if (role === 'supervisor' && batch.some((r) => !['entry', 'hours', 'worker'].includes(r.kind))) throw fail('rejected');
          batch.forEach((r) => {
            rows.set(r.kind + ':' + r.id, {
              shop_id: r.shop_id, kind: r.kind, id: r.id,
              data: jsonbOrder(JSON.parse(JSON.stringify(r.data))), deleted: r.deleted, updated_at: stamp()
            });
          });
        }
      };
    }
  };
}

function memoryStorage() {
  const m = new Map();
  return {
    map: m,
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, String(v)); },
    remove: (k) => { m.delete(k); }
  };
}

function device(server, opts = {}) {
  const storage = opts.storage || memoryStorage();
  let changes = 0;
  const statuses = [];
  const engine = Sync.createEngine({
    shopId: SHOP,
    cacheKey: 'cache',
    storage,
    remote: server.remote(opts.role || 'owner'),
    initialData: opts.initialData || emptyData(opts.lang),
    uploadAll: !!opts.uploadAll,
    pushDelay: 60000, // tests call syncNow themselves
    pageSize: opts.pageSize,
    onChange: () => { changes++; },
    onStatus: (s) => { statuses.push(s); }
  });
  return {
    engine, storage, statuses,
    get data() { return engine.data; },
    get changes() { return changes; },
    async sync() { await engine.syncNow(); }
  };
}

function addCount(d, id, workerIds, itemId, count, rateCents) {
  d.data.entries.push({ id, date: '2026-11-07', workerIds, itemId, count, rateCents, createdAt: 1 });
  d.engine.save();
}

test('a count entered on the supervisor phone shows up on the office computer', async () => {
  const server = fakeServer();
  const office = device(server, { uploadAll: true, initialData: Object.assign(emptyData(), {
    workers: [{ id: 'w1', name: 'Juan', active: true }],
    items: [{ id: 'i1', sku: '48x40 #1', task: 'Repair', rateCents: 70, active: true }]
  }) });
  await office.sync();

  const phone = device(server, { role: 'supervisor' });
  await phone.sync();
  assert.equal(phone.data.workers[0].name, 'Juan');
  assert.equal(phone.data.items[0].rateCents, 70);
  assert.equal(phone.data.settings.shopName, 'Test Yard');

  addCount(phone, 'e1', ['w1'], 'i1', 120, 70);
  phone.data.hours['2026-11-07'] = { w1: 9 };
  phone.engine.save();
  await phone.sync();
  assert.equal(phone.engine.pending(), 0);

  await office.sync();
  assert.equal(office.data.entries.length, 1);
  assert.equal(office.data.entries[0].count, 120);
  assert.deepEqual(office.data.hours, { '2026-11-07': { w1: 9 } });
  assert.ok(office.changes > 0);
});

test('with no signal, counts wait on the phone and are sent when the signal is back, even after a restart', async () => {
  const server = fakeServer();
  const office = device(server, { uploadAll: true });
  await office.sync();
  const phone = device(server, { role: 'supervisor' });
  await phone.sync();

  server.setDown(true);
  phone.data.workers.push({ id: 'w9', name: 'New guy', active: true });
  phone.engine.save();
  addCount(phone, 'e1', ['w9'], 'i1', 40, 70);
  await phone.sync();
  assert.equal(phone.engine.status().state, 'offline');
  assert.equal(phone.engine.pending(), 2);

  // The phone is closed and opened again before the signal comes back.
  phone.engine.stop();
  const reopened = device(server, { role: 'supervisor', storage: phone.storage });
  assert.equal(reopened.engine.pending(), 2);
  assert.equal(reopened.data.entries[0].count, 40);

  server.setDown(false);
  await reopened.sync();
  assert.equal(reopened.engine.pending(), 0);
  assert.equal(reopened.engine.status().state, 'synced');

  await office.sync();
  assert.equal(office.data.workers.find((w) => w.id === 'w9').name, 'New guy');
  assert.equal(office.data.entries[0].count, 40);
});

test('deleting a count and clearing hours reach the other device', async () => {
  const server = fakeServer();
  const a = device(server, { uploadAll: true });
  addCount(a, 'e1', ['w1'], 'i1', 10, 70);
  addCount(a, 'e2', ['w1'], 'i1', 20, 70);
  a.data.hours['2026-11-07'] = { w1: 8, w2: 7 };
  a.engine.save();
  await a.sync();

  const b = device(server);
  await b.sync();
  assert.equal(b.data.entries.length, 2);

  a.data.entries = a.data.entries.filter((e) => e.id !== 'e1');
  delete a.data.hours['2026-11-07'].w1;
  a.engine.save();
  await a.sync();

  await b.sync();
  assert.deepEqual(b.data.entries.map((e) => e.id), ['e2']);
  assert.deepEqual(b.data.hours, { '2026-11-07': { w2: 7 } });

  // A device that joins later never sees the deleted count.
  const c = device(server);
  await c.sync();
  assert.deepEqual(c.data.entries.map((e) => e.id), ['e2']);
});

test('two devices changing different things both keep their changes', async () => {
  const server = fakeServer();
  const a = device(server, { uploadAll: true, initialData: Object.assign(emptyData(), {
    workers: [{ id: 'w1', name: 'Juan', active: true }, { id: 'w2', name: 'Ana', active: true }]
  }) });
  await a.sync();
  const b = device(server);
  await b.sync();

  a.data.hours['2026-11-07'] = { w1: 9 };
  a.engine.save();
  addCount(b, 'e1', ['w2'], 'i1', 33, 70);
  b.data.workers[1].name = 'Ana R.';
  b.engine.save();

  await a.sync();
  await b.sync();
  await a.sync();

  for (const d of [a, b]) {
    assert.deepEqual(d.data.hours, { '2026-11-07': { w1: 9 } });
    assert.equal(d.data.entries.length, 1);
    assert.equal(d.data.workers.find((w) => w.id === 'w2').name, 'Ana R.');
  }
});

test('a change not yet sent is not overwritten by the server copy', async () => {
  const server = fakeServer();
  const a = device(server, { uploadAll: true });
  a.data.hours['2026-11-07'] = { w1: 8 };
  a.engine.save();
  await a.sync();
  const b = device(server);
  await b.sync();

  // B goes offline and changes the hours; meanwhile A changes them too.
  server.setDown(true);
  b.data.hours['2026-11-07'].w1 = 10;
  b.engine.save();
  await b.sync();
  server.setDown(false);
  a.data.hours['2026-11-07'].w1 = 9;
  a.engine.save();
  await a.sync();

  // B still shows its own number until it is sent, then the last one sent wins everywhere.
  assert.equal(b.data.hours['2026-11-07'].w1, 10);
  await b.sync();
  await a.sync();
  assert.equal(a.data.hours['2026-11-07'].w1, 10);
  assert.equal(b.data.hours['2026-11-07'].w1, 10);
});

test('typing hours while a download is under way is not undone by it', async () => {
  const server = fakeServer();
  const a = device(server, { uploadAll: true });
  a.data.hours['2026-11-07'] = { w1: 8 };
  a.engine.save();
  await a.sync();
  const b = device(server);
  await b.sync();
  a.data.hours['2026-11-07'].w1 = 9;   // the server now says 9
  a.engine.save();
  await a.sync();

  // Hold B's download open while the supervisor types 10 on B.
  const remote = server.remote('owner');
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = Sync.createEngine({
    shopId: SHOP, cacheKey: 'cache', storage: b.storage, initialData: emptyData(), pushDelay: 60000,
    remote: { push: remote.push, pull: async (q) => { const rows = await remote.pull(q); await gate; return rows; } }
  });
  const running = slow.syncNow();
  await new Promise((r) => setImmediate(r));
  slow.data.hours['2026-11-07'].w1 = 10;
  slow.save();
  release();
  await running;
  assert.equal(slow.data.hours['2026-11-07'].w1, 10, 'what was typed stays');
  assert.equal(slow.pending(), 1);
  await slow.syncNow();
  assert.equal(server.rows.get('hours:2026-11-07|w1').data.hours, 10);
  slow.stop();
});

test('each person keeps their own language', async () => {
  const server = fakeServer();
  const owner = device(server, { uploadAll: true, lang: 'en' });
  await owner.sync();
  const sup = device(server, { lang: 'es' });
  await sup.sync();
  assert.equal(sup.data.settings.lang, 'es');
  assert.equal(sup.data.settings.shopName, 'Test Yard');

  owner.data.settings.lang = 'es';
  owner.engine.save();
  assert.equal(owner.engine.pending(), 0, 'switching language is not a shop change');

  owner.data.settings.minWageCents = 1000;
  owner.engine.save();
  await owner.sync();
  await sup.sync();
  assert.equal(sup.data.settings.minWageCents, 1000);
  assert.equal(sup.data.settings.lang, 'es');
  assert.equal(server.rows.get('settings:shop').data.lang, undefined);
});

test('a supervisor rate-card change is refused and undone; the rest of the batch is saved', async () => {
  const server = fakeServer();
  const owner = device(server, { uploadAll: true, initialData: Object.assign(emptyData(), {
    items: [{ id: 'i1', sku: '48x40 #1', task: 'Repair', rateCents: 70, active: true }]
  }) });
  await owner.sync();
  const sup = device(server, { role: 'supervisor' });
  await sup.sync();

  sup.data.items[0].rateCents = 99;                                  // not allowed
  sup.data.items.push({ id: 'i2', sku: 'Fake', task: 'Build', rateCents: 500, active: true }); // not allowed
  addCount(sup, 'e1', ['w1'], 'i1', 50, 70);                         // allowed
  await sup.sync();

  assert.equal(sup.engine.pending(), 0);
  assert.equal(sup.statuses.at(-1).rejected, 2);
  assert.equal(sup.data.items.length, 1, 'the made-up rate-card line is removed');
  assert.equal(sup.data.items[0].rateCents, 70, 'the rate is put back');
  assert.equal(sup.data.entries.length, 1, 'the count is kept');
  assert.equal(server.rows.get('item:i1').data.rateCents, 70);
  assert.equal(server.rows.has('entry:e1'), true);
});

test('a large shop downloads completely, page by page', async () => {
  const server = fakeServer();
  const a = device(server, { uploadAll: true });
  for (let i = 0; i < 25; i++) a.data.entries.push({ id: 'e' + i, date: '2026-11-07', workerIds: ['w1'], itemId: 'i1', count: i + 1, rateCents: 70 });
  a.engine.save();
  await a.sync();

  const b = device(server, { pageSize: 4 });
  await b.sync();
  assert.equal(b.data.entries.length, 25);
  assert.equal(b.data.entries.reduce((s, e) => s + e.count, 0), 325);
});

test('this device\'s own changes coming back from the server are not treated as news', async () => {
  const server = fakeServer();
  const a = device(server, { uploadAll: true });
  await a.sync();
  addCount(a, 'e1', ['w1'], 'i1', 5, 37.5);
  a.data.workers.push({ id: 'w1', name: 'Rosa Gutiérrez', active: true });
  a.engine.save();
  await a.sync();
  await a.sync();
  await a.sync();
  assert.equal(a.changes, 0);
  assert.equal(a.engine.pending(), 0);
});

test('a new shop uploads the data already on this device', async () => {
  const server = fakeServer();
  const local = Object.assign(emptyData(), {
    workers: [{ id: 'w1', name: 'Juan', active: true }],
    items: [{ id: 'i1', sku: '48x40 #1', task: 'Repair', rateCents: 70, active: true }],
    hours: { '2026-11-06': { w1: 8.5 } },
    entries: [{ id: 'e1', date: '2026-11-06', workerIds: ['w1'], itemId: 'i1', count: 90, rateCents: 70, createdAt: 1 }]
  });
  const a = device(server, { uploadAll: true, initialData: local });
  assert.equal(a.engine.pending(), 5); // settings, worker, item, hours, entry
  await a.sync();
  assert.equal(server.rows.size, 5);

  const b = device(server);
  await b.sync();
  assert.deepEqual(Sync.snapshot(b.data), Sync.snapshot(a.data));
});

test('when the sign-in has expired, changes stay waiting', async () => {
  const server = fakeServer();
  const storage = memoryStorage();
  const engine = Sync.createEngine({
    shopId: SHOP, cacheKey: 'cache', storage, initialData: emptyData(), pushDelay: 60000,
    remote: { pull: async () => { const e = new Error('expired'); e.kind = 'auth'; throw e; },
              push: async () => { const e = new Error('expired'); e.kind = 'auth'; throw e; } }
  });
  engine.data.workers.push({ id: 'w1', name: 'Juan', active: true });
  engine.save();
  await engine.syncNow();
  assert.equal(engine.status().state, 'signedOut');
  assert.equal(engine.pending(), 1);
  engine.stop();

  // Signed in again: the waiting change goes through.
  const again = device(server, { storage });
  await again.sync();
  assert.equal(again.engine.pending(), 0);
  assert.equal(server.rows.get('worker:w1').data.name, 'Juan');
});

test('forgetting a shop deletes it from the device, even with a download under way', async () => {
  const server = fakeServer();
  const a = device(server, { uploadAll: true });
  await a.sync();
  const remote = server.remote('owner');
  let release;
  const gate = new Promise((r) => { release = r; });
  let statusCalls = 0;
  const slow = Sync.createEngine({
    shopId: SHOP, cacheKey: 'cache', storage: a.storage, initialData: emptyData(), pushDelay: 60000,
    onStatus: () => { statusCalls++; },
    remote: { push: remote.push, pull: async (q) => { const rows = await remote.pull(q); await gate; return rows; } }
  });
  const running = slow.syncNow();
  await new Promise((r) => setImmediate(r));
  const before = statusCalls;
  slow.forget();
  release();
  await running;
  assert.equal(a.storage.get('cache'), null, 'nothing written back after forgetting');
  assert.equal(statusCalls, before, 'a stopped engine no longer reports to the screen');
});

test('another tab saving the same shop is picked up', async () => {
  const server = fakeServer();
  const storage = memoryStorage();
  const tab1 = device(server, { uploadAll: true, storage });
  await tab1.sync();
  const tab2 = device(server, { storage });
  tab2.data.workers.push({ id: 'w5', name: 'Pedro', active: true });
  tab2.engine.save();

  const sameObject = tab1.data;
  tab1.engine.reload();
  assert.equal(tab1.data, sameObject, 'the screen keeps using the same data object');
  assert.equal(tab1.data.workers[0].name, 'Pedro');
  assert.equal(tab1.engine.pending(), 1);
  await tab1.sync();
  assert.equal(server.rows.get('worker:w5').data.name, 'Pedro');
});
