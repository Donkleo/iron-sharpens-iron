-- Iron Sharpens Iron: families from the lifegroup sheet
--
-- The Google Sheet script (apps-script/sheet-sync.gs) sends the sheet's
-- Families tab here, the way the app's sheet sync fills the app's family list:
--   * Each family gets the husband, wife and "pray for" from the sheet, and its
--     place in the sheet's order.
--   * "since" is the day a family first came from the sheet. The weekly
--     prayer rotation uses it so a new family joins on the following Sunday
--     and nobody's partner changes mid-week. A family that's already here
--     keeps its "since" as it is.
--   * A family the sheet added and then took off is removed, unless prayers
--     are filed under it; then it stays (so no prayer is lost) and just stops
--     being a sheet family. A family first added on the site is never removed
--     by the sync: if it's on the sheet too, the sheet fills in its details,
--     and when it leaves the sheet it simply stops being a sheet family.
--
-- Apply once in the Supabase dashboard: SQL Editor, paste this file, Run.
-- Run it after 20261125140000_sync_key_header.sql.

alter table public.families
  add column husband    text check (husband is null or length(husband) <= 80),
  add column wife       text check (wife is null or length(wife) <= 80),
  add column pray_for   text check (pray_for is null or length(pray_for) <= 2000),
  add column sort_order integer,
  add column since      date,
  add column from_sheet boolean not null default false,
  add column added_by_sheet boolean not null default false;

-- Raises "Unknown sync key." unless the key (from p_key or the x-sync-key
-- header) matches a stored key.
create or replace function private.check_sync_key(p_key text) returns void
language plpgsql stable set search_path = ''
as $$
declare
  k text := coalesce(nullif(btrim(p_key), ''), private.header_sync_key());
begin
  if k is null or length(k) < 24
     or not exists (select 1 from private.sync_keys s where s.key_hash = private.hash_key(k)) then
    raise exception 'Unknown sync key.' using errcode = '28000';
  end if;
end;
$$;
revoke all on function private.check_sync_key(text) from public, anon, authenticated;

-- Make the site's family list match the sheet's Families tab.
-- p_families is a JSON array, in the sheet's order, of objects with: name, and
-- optionally husband, wife, pray_for. Names are matched without regard to
-- case or spaces at the ends; if a name appears twice, the last one wins.
-- Returns how many families were saved.
create function public.sync_families(p_families jsonb, p_key text default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  n integer;
  today date := (now() at time zone 'America/Chicago')::date;
  clean jsonb;
begin
  perform private.check_sync_key(p_key);
  if jsonb_typeof(p_families) is distinct from 'array' then
    raise exception 'Families must be a JSON array.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_families) = 0 then
    raise exception 'An empty list would remove every family from the sheet, so nothing was changed.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_families) > 300 then
    raise exception 'Too many families at once (300 at most).' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_families) x
             where jsonb_typeof(x) is distinct from 'object'
                or nullif(btrim(x->>'name'), '') is null or length(btrim(x->>'name')) > 80) then
    raise exception 'Every family needs a name (80 characters at most).' using errcode = '22023';
  end if;

  select jsonb_agg(jsonb_build_object(
           'name', d.name, 'husband', d.husband, 'wife', d.wife,
           'pray_for', d.pray_for, 'sort_order', d.sort_order))
  into clean
  from (select distinct on (lower(btrim(x->>'name')))
               btrim(x->>'name') as name,
               left(nullif(btrim(x->>'husband'), ''), 80) as husband,
               left(nullif(btrim(x->>'wife'), ''), 80) as wife,
               left(nullif(btrim(x->>'pray_for'), ''), 2000) as pray_for,
               i::integer as sort_order
        from jsonb_array_elements(p_families) with ordinality as a(x, i)
        order by lower(btrim(x->>'name')), i desc) d;

  insert into public.families as f (name, husband, wife, pray_for, sort_order, since, from_sheet, added_by_sheet, created_by)
  select s.name, s.husband, s.wife, s.pray_for, s.sort_order, today, true, true, null
  from jsonb_to_recordset(clean) as s(name text, husband text, wife text, pray_for text, sort_order integer)
  on conflict ((lower(btrim(name)))) do update set
    name = excluded.name, husband = excluded.husband, wife = excluded.wife,
    pray_for = excluded.pray_for, sort_order = excluded.sort_order, from_sheet = true;
  get diagnostics n = row_count;

  -- Off the sheet: remove a family the sheet added, unless prayers use it;
  -- every other one stays as a site family.
  delete from public.families f
  where f.from_sheet and f.added_by_sheet
    and not exists (select 1 from jsonb_to_recordset(clean) as s(name text)
                    where lower(s.name) = lower(btrim(f.name)))
    and not exists (select 1 from public.requests r where r.family_id = f.id);
  update public.families f set from_sheet = false, sort_order = null
  where f.from_sheet
    and not exists (select 1 from jsonb_to_recordset(clean) as s(name text)
                    where lower(s.name) = lower(btrim(f.name)));

  return n;
end;
$$;

revoke all on function public.sync_families(jsonb, text) from public;
grant execute on function public.sync_families(jsonb, text) to anon, authenticated;
