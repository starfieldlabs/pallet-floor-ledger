-- Pallet Floor Ledger: shared shop data on Supabase (Postgres).
--
-- Run this whole file once on a new Supabase project:
--   Supabase dashboard → SQL Editor → New query → paste → Run.
-- Running it again is safe; it only creates or replaces its own tables, functions and rules.
--
-- How it works
--   shops         one row per pallet business
--   shop_members  who can open which shop, as 'owner' or 'supervisor'
--   shop_invites  one-time codes an owner sends to add someone
--   records       the shop's data: settings, workers, rate-card lines, hours, counts.
--                 One row per thing. Nothing is hard-deleted: deleted = true, so every
--                 device learns about deletions.
--
-- Who can do what (enforced here, not just in the app)
--   Anyone signed in can create a shop (up to 5) and becomes its owner.
--   Members read everything in their own shops and nothing in anyone else's.
--   Supervisors write counts, hours and workers. Owners write everything,
--   invite people and remove people.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

-- ---------- tables ----------

create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  name text not null default '' check (char_length(name) <= 80),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.shop_members (
  shop_id uuid not null references public.shops (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'supervisor')),
  email text not null default '',
  joined_at timestamptz not null default now(),
  primary key (shop_id, user_id)
);
create index if not exists shop_members_user on public.shop_members (user_id);

create table if not exists public.shop_invites (
  code text primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  role text not null check (role in ('owner', 'supervisor')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid references auth.users (id) on delete set null,
  used_at timestamptz
);
create index if not exists shop_invites_shop on public.shop_invites (shop_id);
-- Small indexes so deleting a user account does not scan these tables.
create index if not exists shops_created_by on public.shops (created_by);
create index if not exists shop_invites_created_by on public.shop_invites (created_by);
create index if not exists shop_invites_used_by on public.shop_invites (used_by);

create table if not exists public.records (
  shop_id uuid not null references public.shops (id) on delete cascade,
  kind text not null check (kind in ('settings', 'worker', 'item', 'hours', 'entry')),
  id text not null check (char_length(id) between 1 and 100),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) <= 16384),
  deleted boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid,
  primary key (shop_id, kind, id)
);
-- Devices ask "what changed in my shop since <time>?" every few seconds.
create index if not exists records_changes on public.records (shop_id, updated_at);

-- ---------- helpers used by the access rules ----------

create or replace function private.is_member(p_shop uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shop_members m
    where m.shop_id = p_shop and m.user_id = auth.uid()
  );
$$;

create or replace function private.is_owner(p_shop uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shop_members m
    where m.shop_id = p_shop and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

-- Supervisors may record counts and hours and add workers. Owners may change everything.
create or replace function private.can_write(p_shop uuid, p_kind text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shop_members m
    where m.shop_id = p_shop and m.user_id = auth.uid()
      and (m.role = 'owner' or p_kind in ('entry', 'hours', 'worker'))
  );
$$;

grant usage on schema private to authenticated;
revoke all on all functions in schema private from public, anon;
grant execute on function private.is_member(uuid), private.is_owner(uuid), private.can_write(uuid, text) to authenticated;

-- ---------- server-side stamps ----------

-- The server, not the device, sets the time of every change, so a phone with a
-- wrong clock cannot hide its changes from the other devices.
create or replace function private.records_stamp() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists records_stamp on public.records;
create trigger records_stamp before insert or update on public.records
  for each row execute function private.records_stamp();

-- Keep the shop list's name the same as the name in Setup.
create or replace function private.records_shop_name() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.shops set name = left(coalesce(new.data ->> 'shopName', ''), 80)
  where id = new.shop_id;
  return null;
end;
$$;

drop trigger if exists records_shop_name on public.records;
create trigger records_shop_name after insert or update on public.records
  for each row when (new.kind = 'settings' and new.id = 'shop' and not new.deleted)
  execute function private.records_shop_name();

-- ---------- access rules ----------

alter table public.shops enable row level security;
alter table public.shop_members enable row level security;
alter table public.shop_invites enable row level security;
alter table public.records enable row level security;

revoke all on public.shops, public.shop_members, public.shop_invites, public.records from anon, authenticated;
grant select on public.shops to authenticated;
grant select, delete on public.shop_members to authenticated;
grant select, delete on public.shop_invites to authenticated;
grant select, insert, update on public.records to authenticated;

drop policy if exists "members read their shops" on public.shops;
create policy "members read their shops" on public.shops
  for select to authenticated using (private.is_member(id));

drop policy if exists "members see who is in the shop" on public.shop_members;
create policy "members see who is in the shop" on public.shop_members
  for select to authenticated using (private.is_member(shop_id));

drop policy if exists "owners remove other people" on public.shop_members;
create policy "owners remove other people" on public.shop_members
  for delete to authenticated using (private.is_owner(shop_id) and user_id <> (select auth.uid()));

drop policy if exists "owners see invites" on public.shop_invites;
create policy "owners see invites" on public.shop_invites
  for select to authenticated using (private.is_owner(shop_id));

drop policy if exists "owners cancel invites" on public.shop_invites;
create policy "owners cancel invites" on public.shop_invites
  for delete to authenticated using (private.is_owner(shop_id));

drop policy if exists "members read records" on public.records;
create policy "members read records" on public.records
  for select to authenticated using (private.is_member(shop_id));

drop policy if exists "members add allowed records" on public.records;
create policy "members add allowed records" on public.records
  for insert to authenticated with check (private.can_write(shop_id, kind));

drop policy if exists "members change allowed records" on public.records;
create policy "members change allowed records" on public.records
  for update to authenticated
  using (private.can_write(shop_id, kind))
  with check (private.can_write(shop_id, kind));

-- ---------- actions the app calls ----------

-- Errors are raised with a short code as the message; the app turns it into words.

create or replace function public.create_shop(shop_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  clean text := left(btrim(coalesce(shop_name, '')), 80);
  new_id uuid;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  if clean = '' then raise exception 'name_required'; end if;
  if (select count(*) from public.shops s where s.created_by = me) >= 5 then
    raise exception 'too_many_shops';
  end if;
  insert into public.shops (name, created_by) values (clean, me) returning id into new_id;
  insert into public.shop_members (shop_id, user_id, role, email)
    values (new_id, me, 'owner', coalesce(auth.jwt() ->> 'email', ''));
  return new_id;
end;
$$;

-- An 8-character code from an alphabet without look-alikes (no 0/O, 1/I).
create or replace function public.create_invite(p_shop uuid, p_role text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea;
  new_code text;
  i int;
begin
  if not private.is_owner(p_shop) then raise exception 'not_owner'; end if;
  if p_role is null or p_role not in ('owner', 'supervisor') then raise exception 'bad_role'; end if;
  if (select count(*) from public.shop_invites v
      where v.shop_id = p_shop and v.used_at is null and v.expires_at > now()) >= 20 then
    raise exception 'too_many_invites';
  end if;
  loop
    bytes := extensions.gen_random_bytes(8);
    new_code := '';
    for i in 0..7 loop
      new_code := new_code || substr(alphabet, 1 + (get_byte(bytes, i) % 32), 1);
    end loop;
    exit when not exists (select 1 from public.shop_invites v where v.code = new_code);
  end loop;
  insert into public.shop_invites (code, shop_id, role, created_by)
    values (new_code, p_shop, p_role, auth.uid());
  return new_code;
end;
$$;

create or replace function public.join_shop(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  clean text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  inv public.shop_invites%rowtype;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  select * into inv from public.shop_invites v where v.code = clean for update;
  if not found or inv.used_at is not null or inv.expires_at <= now() then
    raise exception 'invite_invalid';
  end if;
  -- Already in the shop: keep the code unused for someone else.
  if exists (select 1 from public.shop_members m where m.shop_id = inv.shop_id and m.user_id = me) then
    return inv.shop_id;
  end if;
  insert into public.shop_members (shop_id, user_id, role, email)
    values (inv.shop_id, me, inv.role, coalesce(auth.jwt() ->> 'email', ''));
  update public.shop_invites v set used_by = me, used_at = now() where v.code = clean;
  return inv.shop_id;
end;
$$;

revoke all on function public.create_shop(text), public.create_invite(uuid, text), public.join_shop(text) from public, anon;
grant execute on function public.create_shop(text), public.create_invite(uuid, text), public.join_shop(text) to authenticated;
