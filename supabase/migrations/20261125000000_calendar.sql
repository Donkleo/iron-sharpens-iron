-- Iron Sharpens Iron: calendar
--
-- Who can do what:
--   * Every signed-in member can see the calendar and add a group event.
--   * Whoever added a group event, or an admin, can delete it.
--   * Lifegroup sheet and church events come from the syncs. Only an admin
--     can hide or bring back a church event, so nobody hides one by accident.
--     Sheet events change only in the sheet.
--   * The syncs write through public.sync_events with a sync key that only
--     the database knows (stored as a hash). The key can only add, change or
--     remove sheet and church events; it can't read or touch prayers.
--   * The public (anon) key can read nothing.
--
-- Apply once in the Supabase dashboard: SQL Editor, paste this file, Run.
-- Run it after the prayer core file (20261124000000_prayer_core.sql).

create table public.events (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (length(btrim(title)) between 1 and 200),
  starts_on    date not null,
  ends_on      date check (ends_on is null or ends_on >= starts_on),
  time_text    text check (time_text is null or length(time_text) <= 40),
  location     text check (location is null or length(location) <= 200),
  address      text check (address is null or length(address) <= 300),
  notes        text check (notes is null or length(notes) <= 2000),
  url          text check (url is null or (url ~ '^https://' and length(url) <= 500)),
  -- group: added on the site. sheet: the lifegroup Google Sheet. church: the church calendar.
  source       text not null default 'group' check (source in ('group', 'sheet', 'church')),
  -- 'open' marks a sheet night that has no host yet.
  kind         text check (kind is null or kind = 'open'),
  -- The sync's own id for a sheet or church event, so a re-run updates it in place.
  external_id  text check (external_id is null or length(external_id) between 1 and 200),
  hidden       boolean not null default false,
  created_by   uuid default auth.uid() references public.members (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint events_external_id_key unique (source, external_id),
  constraint events_synced_have_ids check (source = 'group' or external_id is not null)
);
create index events_starts_on_idx on public.events (starts_on);

-- ---------------------------------------------------------------------------
-- Access rules
-- ---------------------------------------------------------------------------

alter table public.events enable row level security;
revoke all on public.events from public, anon, authenticated;

grant select on public.events to authenticated;
-- Members add group events with these fields only.
grant insert (title, starts_on, ends_on, time_text, location, notes) on public.events to authenticated;
-- Hiding is the only change made from the site.
grant update (hidden) on public.events to authenticated;
grant delete on public.events to authenticated;

create policy events_select on public.events for select to authenticated
  using ((select public.is_member()));
create policy events_insert on public.events for insert to authenticated
  with check ((select public.is_member()) and source = 'group' and created_by = (select auth.uid()));
create policy events_hide on public.events for update to authenticated
  using ((select public.is_admin()) and source = 'church')
  with check ((select public.is_admin()) and source = 'church');

-- Note when an event last changed (hiding included).
create function public.touch_event() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.touch_event() from public, anon, authenticated;
create trigger touch_event before update on public.events
  for each row execute function public.touch_event();
create policy events_delete on public.events for delete to authenticated
  using ((select public.is_member()) and source = 'group'
         and (created_by = (select auth.uid()) or (select public.is_admin())));

-- ---------------------------------------------------------------------------
-- Sync key and the function the syncs call
-- ---------------------------------------------------------------------------

-- Kept out of the API: the "private" schema isn't exposed by Supabase, and
-- nobody but the database owner is granted anything on it.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.sync_keys (
  key_hash    text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  label       text not null default 'calendar sync',
  created_at  timestamptz not null default now()
);

create function private.hash_key(k text) returns text
language sql immutable set search_path = ''
as $$ select encode(pg_catalog.sha256(convert_to(k, 'UTF8')), 'hex') $$;

-- Add or update sheet or church events, matched on external_id. When
-- p_replace_from is given, that source's events on or after that day that
-- aren't in p_events are removed (a night taken off the sheet disappears).
-- Hidden church events stay hidden while they're in the sync. If the same
-- items appear twice, the last one wins; a link that isn't https is dropped.
-- Returns how many events were saved.
--
-- p_events is a JSON array of objects with: id (the sync's own id), title,
-- date (YYYY-MM-DD), and optionally end_date, time, location, address, notes,
-- url, kind ('open').
create function public.sync_events(p_key text, p_source text, p_events jsonb, p_replace_from date default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  n integer;
begin
  if p_key is null or length(p_key) < 24
     or not exists (select 1 from private.sync_keys s where s.key_hash = private.hash_key(p_key)) then
    raise exception 'Unknown sync key.' using errcode = '28000';
  end if;
  if p_source not in ('sheet', 'church') then
    raise exception 'The source must be sheet or church.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'Events must be a JSON array.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_events) x
             where nullif(btrim(x->>'id'), '') is null or nullif(btrim(x->>'title'), '') is null
                or coalesce(x->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$') then
    raise exception 'Every event needs an id, a title and a date (YYYY-MM-DD).' using errcode = '22023';
  end if;

  insert into public.events as e
    (source, external_id, title, starts_on, ends_on, time_text, location, address, notes, url, kind, created_by)
  select p_source, x->>'id', btrim(x->>'title'), (x->>'date')::date, nullif(x->>'end_date', '')::date,
         nullif(btrim(x->>'time'), ''), nullif(btrim(x->>'location'), ''), nullif(btrim(x->>'address'), ''),
         nullif(btrim(x->>'notes'), ''),
         case when btrim(x->>'url') ~* '^https://' then 'https://' || substr(btrim(x->>'url'), 9) end,
         nullif(x->>'kind', ''), null
  from (select distinct on (x->>'id') x
        from jsonb_array_elements(p_events) with ordinality as a(x, i)
        order by x->>'id', i desc) d
  on conflict (source, external_id) do update set
    title = excluded.title, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
    time_text = excluded.time_text, location = excluded.location, address = excluded.address,
    notes = excluded.notes, url = excluded.url, kind = excluded.kind, updated_at = now();
  get diagnostics n = row_count;

  if p_replace_from is not null then
    delete from public.events e
    where e.source = p_source and e.starts_on >= p_replace_from
      and not exists (select 1 from jsonb_array_elements(p_events) x where x->>'id' = e.external_id);
  end if;
  return n;
end;
$$;

revoke all on function public.sync_events(text, text, jsonb, date) from public;
grant execute on function public.sync_events(text, text, jsonb, date) to anon, authenticated;
revoke all on function private.hash_key(text) from public, anon, authenticated;
