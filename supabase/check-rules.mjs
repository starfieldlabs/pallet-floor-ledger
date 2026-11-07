// Checks the access rules in supabase/schema.sql without a Supabase project.
// Runs the file in an in-process Postgres (PGlite) and acts as owner, supervisor,
// outsider and signed-out visitor, the way Supabase does (role "authenticated"
// plus the sign-in claims in request.jwt.claims).
//
// Run: npm install, then npm run test:db
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCHEMA = fileURLToPath(new URL('./schema.sql', import.meta.url));
const db = new PGlite();

// What a Supabase project already has before our file runs.
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  create schema extensions;
  -- stand-in for pgcrypto's gen_random_bytes (Supabase has the real one)
  create function extensions.gen_random_bytes(n int) returns bytea language sql volatile as
    $$ select substring(decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex') from 1 for n) $$;
  grant usage on schema extensions to anon, authenticated;
`);
const sql = readFileSync(SCHEMA, 'utf8').replace(/create extension if not exists pgcrypto with schema extensions;/, '');
await db.exec(sql);
await db.exec(sql); // running it twice must be safe

const U = {
  owner: { id: '11111111-1111-1111-1111-111111111111', email: 'owner@yard.test' },
  sup: { id: '22222222-2222-2222-2222-222222222222', email: 'sup@yard.test' },
  outsider: { id: '33333333-3333-3333-3333-333333333333', email: 'other@elsewhere.test' },
  late: { id: '44444444-4444-4444-4444-444444444444', email: 'late@yard.test' }
};
for (const u of Object.values(U)) await db.query('insert into auth.users values ($1, $2)', [u.id, u.email]);

/** Run queries as a signed-in person (or as the anon role when user is null). */
async function as(user, fn) {
  return db.transaction(async (tx) => {
    if (user) {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user.id, email: user.email, role: 'authenticated' })]);
      await tx.exec('set local role authenticated');
    } else {
      await tx.exec('set local role anon');
    }
    return fn(tx);
  });
}
async function fails(promise, pattern) {
  try { await promise; } catch (e) { if (pattern) assert.match(e.message, pattern); return e; }
  assert.fail('expected an error');
}
// What PostgREST runs for the app's upsert.
const UPSERT = `insert into public.records (shop_id, kind, id, data, deleted) values ($1, $2, $3, $4, $5)
  on conflict (shop_id, kind, id) do update set data = excluded.data, deleted = excluded.deleted`;

let shopId;
let code;

test('an owner creates a shop and writes every kind of record', async () => {
  shopId = await as(U.owner, async (tx) => (await tx.query(`select public.create_shop('  Riverside Pallets ') as id`)).rows[0].id);
  await as(U.owner, async (tx) => {
    await tx.query(UPSERT, [shopId, 'settings', 'shop', { shopName: 'Riverside Pallets LLC', minWageCents: 725 }, false]);
    await tx.query(UPSERT, [shopId, 'item', 'i1', { id: 'i1', sku: '48x40 #1', rateCents: 70 }, false]);
    await tx.query(UPSERT, [shopId, 'worker', 'w1', { id: 'w1', name: 'Juan' }, false]);
    await tx.query(UPSERT, [shopId, 'entry', 'e1', { id: 'e1', count: 10 }, false]);
    await tx.query(UPSERT, [shopId, 'hours', '2026-11-07|w1', { hours: 8 }, false]);
    // the same record again = an update
    await tx.query(UPSERT, [shopId, 'item', 'i1', { id: 'i1', sku: '48x40 #1', rateCents: 72 }, false]);
    const rows = (await tx.query(`select kind, updated_by from public.records order by kind`)).rows;
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r.updated_by === U.owner.id), 'the server records who made each change');
    const shop = (await tx.query(`select name from public.shops`)).rows;
    assert.deepEqual(shop, [{ name: 'Riverside Pallets LLC' }], 'shop list follows the name in Setup');
    const me = (await tx.query(`select role, email from public.shop_members`)).rows;
    assert.deepEqual(me, [{ role: 'owner', email: 'owner@yard.test' }]);
  });
});

test('the server sets the change time; a device cannot backdate it', async () => {
  await as(U.owner, async (tx) => {
    await tx.query(`insert into public.records (shop_id, kind, id, data, updated_at) values ($1, 'worker', 'w2', '{}', '2001-01-01')`, [shopId]);
    const r = (await tx.query(`select updated_at from public.records where id = 'w2'`)).rows[0];
    assert.ok(new Date(r.updated_at).getFullYear() > 2001);
  });
});

test('someone outside the shop sees nothing and can write nothing', async () => {
  await as(U.outsider, async (tx) => {
    assert.equal((await tx.query(`select * from public.records`)).rows.length, 0);
    assert.equal((await tx.query(`select * from public.shops`)).rows.length, 0);
    assert.equal((await tx.query(`select * from public.shop_members`)).rows.length, 0);
    assert.equal((await tx.query(`select * from public.shop_invites`)).rows.length, 0);
  });
  await fails(as(U.outsider, (tx) => tx.query(UPSERT, [shopId, 'entry', 'e9', { count: 999 }, false])), /row-level security/);
  await fails(as(U.outsider, (tx) => tx.query(`select public.create_invite($1, 'owner')`, [shopId])), /not_owner/);
  await as(U.outsider, async (tx) => {
    const del = await tx.query(`delete from public.shop_members where shop_id = $1 returning *`, [shopId]);
    assert.equal(del.rows.length, 0);
  });
});

test('signed-out visitors (the public key alone) get nothing', async () => {
  await fails(as(null, (tx) => tx.query(`select * from public.records`)), /permission denied/);
  await fails(as(null, (tx) => tx.query(`select * from public.shops`)), /permission denied/);
  await fails(as(null, (tx) => tx.query(`select public.create_shop('x')`)), /permission denied/);
  await fails(as(null, (tx) => tx.query(`select public.join_shop('ABCD2345')`)), /permission denied/);
  await fails(as(null, (tx) => tx.query(`select private.is_member($1)`, [shopId])), /permission denied/);
});

test('an owner invites a supervisor; the code works once', async () => {
  code = await as(U.owner, async (tx) => (await tx.query(`select public.create_invite($1, 'supervisor') as c`, [shopId])).rows[0].c);
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/, 'eight characters, no look-alikes');
  const typed = code.slice(0, 4).toLowerCase() + '-' + code.slice(4).toLowerCase();
  const joined = await as(U.sup, async (tx) => (await tx.query(`select public.join_shop($1) as s`, [typed])).rows[0].s);
  assert.equal(joined, shopId);
  await fails(as(U.late, (tx) => tx.query(`select public.join_shop($1)`, [code])), /invite_invalid/);
  await fails(as(U.late, (tx) => tx.query(`select public.join_shop('ZZZZ9999')`)), /invite_invalid/);
  await as(U.sup, async (tx) => {
    const roles = (await tx.query(`select email, role from public.shop_members order by role`)).rows;
    assert.deepEqual(roles, [{ email: 'owner@yard.test', role: 'owner' }, { email: 'sup@yard.test', role: 'supervisor' }]);
  });
});

test('an expired invite does not work', async () => {
  const old = await as(U.owner, async (tx) => (await tx.query(`select public.create_invite($1, 'supervisor') as c`, [shopId])).rows[0].c);
  await db.query(`update public.shop_invites set expires_at = now() - interval '1 minute' where code = $1`, [old]);
  await fails(as(U.late, (tx) => tx.query(`select public.join_shop($1)`, [old])), /invite_invalid/);
});

test('a supervisor enters counts, hours and workers but not rates, settings or people', async () => {
  await as(U.sup, async (tx) => {
    assert.equal((await tx.query(`select * from public.records`)).rows.length, 6, 'reads the whole shop');
    await tx.query(UPSERT, [shopId, 'entry', 'e2', { id: 'e2', count: 25 }, false]);
    await tx.query(UPSERT, [shopId, 'hours', '2026-11-07|w1', { hours: 9 }, false]);
    await tx.query(UPSERT, [shopId, 'worker', 'w3', { id: 'w3', name: 'New hire' }, false]);
    await tx.query(UPSERT, [shopId, 'entry', 'e1', {}, true]); // delete a count
  });
  await fails(as(U.sup, (tx) => tx.query(UPSERT, [shopId, 'item', 'i1', { rateCents: 999 }, false])), /row-level security/);
  await fails(as(U.sup, (tx) => tx.query(UPSERT, [shopId, 'item', 'i9', { rateCents: 500 }, false])), /row-level security/);
  await fails(as(U.sup, (tx) => tx.query(UPSERT, [shopId, 'settings', 'shop', { minWageCents: 1 }, false])), /row-level security/);
  await as(U.sup, async (tx) => {
    const r = await tx.query(`update public.records set data = '{"rateCents": 999}' where kind = 'item'`);
    assert.equal(r.affectedRows, 0, 'rate-card rows are out of reach, so nothing changes');
  });
  await fails(as(U.sup, (tx) => tx.query(`update public.records set kind = 'item' where id = 'e2'`)), /row-level security/);
  await fails(as(U.sup, (tx) => tx.query(`select public.create_invite($1, 'owner')`, [shopId])), /not_owner/);
  await fails(as(U.sup, (tx) => tx.query(`delete from public.records`)), /permission denied/);
  await as(U.sup, async (tx) => {
    assert.equal((await tx.query(`select * from public.shop_invites`)).rows.length, 0, 'cannot see invite codes');
    const del = await tx.query(`delete from public.shop_members where user_id = $1 returning *`, [U.owner.id]);
    assert.equal(del.rows.length, 0, 'cannot remove the owner');
  });
  const rate = (await db.query(`select data->>'rateCents' as r from public.records where kind = 'item' and id = 'i1'`)).rows[0].r;
  assert.equal(rate, '72');
});

test('nobody can move a record into another shop or pretend to be someone else', async () => {
  const other = await as(U.outsider, async (tx) => (await tx.query(`select public.create_shop('Other Yard') as id`)).rows[0].id);
  await fails(as(U.owner, (tx) => tx.query(UPSERT, [other, 'entry', 'x', {}, false])), /row-level security/);
  await fails(as(U.owner, (tx) => tx.query(`update public.records set shop_id = $1 where id = 'e2'`, [other])), /row-level security/);
  await as(U.sup, async (tx) => {
    await tx.query(`insert into public.records (shop_id, kind, id, data, updated_by) values ($1, 'entry', 'e3', '{}', $2)`, [shopId, U.owner.id]);
  });
  const by = (await db.query(`select updated_by from public.records where id = 'e3'`)).rows[0].updated_by;
  assert.equal(by, U.sup.id);
});

test('an owner removes a supervisor, who then sees nothing', async () => {
  await as(U.owner, async (tx) => {
    const self = await tx.query(`delete from public.shop_members where user_id = $1 returning *`, [U.owner.id]);
    assert.equal(self.rows.length, 0, 'an owner cannot remove themselves');
    const del = await tx.query(`delete from public.shop_members where user_id = $1 returning *`, [U.sup.id]);
    assert.equal(del.rows.length, 1);
  });
  await as(U.sup, async (tx) => {
    assert.equal((await tx.query(`select * from public.records`)).rows.length, 0);
  });
  await fails(as(U.sup, (tx) => tx.query(UPSERT, [shopId, 'entry', 'e4', {}, false])), /row-level security/);
});

test('limits: 5 shops per person, record size', async () => {
  for (let i = 0; i < 4; i++) await as(U.late, (tx) => tx.query(`select public.create_shop($1)`, ['Yard ' + i]));
  await as(U.late, (tx) => tx.query(`select public.create_shop('Yard 5')`));
  await fails(as(U.late, (tx) => tx.query(`select public.create_shop('Yard 6')`)), /too_many_shops/);
  await fails(as(U.late, (tx) => tx.query(`select public.create_shop('   ')`)), /name_required/);
  await fails(as(U.owner, (tx) => tx.query(UPSERT, [shopId, 'entry', 'big', { note: 'x'.repeat(40000) }, false])), /check constraint/);
  await fails(as(U.owner, (tx) => tx.query(UPSERT, [shopId, 'invoice', 'x', {}, false])), /check constraint/);
});

test('the app\'s download query works for a member', async () => {
  await as(U.owner, async (tx) => {
    const rows = (await tx.query(
      `select kind, id, data, deleted, updated_at from public.records
       where shop_id = $1 and updated_at > now() - interval '1 hour' and deleted is false
       order by updated_at, kind, id limit 1000 offset 0`, [shopId])).rows;
    assert.ok(rows.length >= 6);
    assert.ok(rows.every((r) => !r.deleted));
  });
});
