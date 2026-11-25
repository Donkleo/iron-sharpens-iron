-- Iron Sharpens Iron: calendar sync key in a header
--
-- The syncs can now send their key in an "x-sync-key" request header instead
-- of in the request body. A header can be stored as a secret in the place the
-- sync runs, so the key never has to be written into the sync's instructions.
-- (Sending it in the body as p_key still works.)
--
-- Also:
--   * Turns on row-level security for private.sync_keys. Nothing is allowed
--     through it, which is the point: only the database owner, who runs the
--     sync function, can read the key fingerprints.
--   * Makes a sync more forgiving: an unknown "kind" (like "bible-study"),
--     an end date before the start, or text longer than the site allows no
--     longer stops the whole sync; they're dropped or shortened instead.
--
-- Apply once in the Supabase dashboard: SQL Editor, paste this file, Run.
-- Run it after the calendar file (20261125000000_calendar.sql).

alter table private.sync_keys enable row level security;

-- The x-sync-key header of the current API request, if any. PostgREST puts
-- the request's headers (names in lower case) in the request.headers setting.
create function private.header_sync_key() returns text
language plpgsql stable set search_path = ''
as $$
declare
  h text := current_setting('request.headers', true);
begin
  if h is null or h = '' then
    return null;
  end if;
  return nullif(btrim(h::json ->> 'x-sync-key'), '');
exception when others then
  return null;
end;
$$;
revoke all on function private.header_sync_key() from public, anon, authenticated;

drop function public.sync_events(text, text, jsonb, date);

-- Add or update sheet or church events, matched on the sync's own id. When
-- p_replace_from is given, that source's events on or after that day that
-- aren't in p_events are removed (a night taken off the sheet disappears).
-- Hidden church events stay hidden while they're in the sync. If the same
-- item appears twice, the last one wins; a link that isn't https is dropped.
-- Returns how many events were saved.
--
-- The key comes from the x-sync-key header, or from p_key.
--
-- p_events is a JSON array of objects with: id (the sync's own id), title,
-- date (YYYY-MM-DD), and optionally end_date, time, location, address, notes,
-- url, kind ('open' for a night with no host yet; anything else is ignored).
create function public.sync_events(p_source text, p_events jsonb, p_replace_from date default null, p_key text default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  k text := coalesce(nullif(btrim(p_key), ''), private.header_sync_key());
  n integer;
begin
  if k is null or length(k) < 24
     or not exists (select 1 from private.sync_keys s where s.key_hash = private.hash_key(k)) then
    raise exception 'Unknown sync key.' using errcode = '28000';
  end if;
  if p_source is null or p_source not in ('sheet', 'church') then
    raise exception 'The source must be sheet or church.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'Events must be a JSON array.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_events) x
             where jsonb_typeof(x) is distinct from 'object'
                or nullif(btrim(x->>'id'), '') is null or nullif(btrim(x->>'title'), '') is null
                or coalesce(x->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$') then
    raise exception 'Every event needs an id, a title and a date (YYYY-MM-DD).' using errcode = '22023';
  end if;

  insert into public.events as e
    (source, external_id, title, starts_on, ends_on, time_text, location, address, notes, url, kind, created_by)
  select p_source, left(btrim(x->>'id'), 200), left(btrim(x->>'title'), 200), (x->>'date')::date,
         case when x->>'end_date' ~ '^\d{4}-\d{2}-\d{2}$' and (x->>'end_date')::date >= (x->>'date')::date
              then (x->>'end_date')::date end,
         left(nullif(btrim(x->>'time'), ''), 40), left(nullif(btrim(x->>'location'), ''), 200),
         left(nullif(btrim(x->>'address'), ''), 300), left(nullif(btrim(x->>'notes'), ''), 2000),
         case when btrim(x->>'url') ~* '^https://' and length(btrim(x->>'url')) <= 500
              then 'https://' || substr(btrim(x->>'url'), 9) end,
         case when x->>'kind' = 'open' then 'open' end, null
  from (select distinct on (btrim(x->>'id')) x
        from jsonb_array_elements(p_events) with ordinality as a(x, i)
        order by btrim(x->>'id'), i desc) d
  on conflict (source, external_id) do update set
    title = excluded.title, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
    time_text = excluded.time_text, location = excluded.location, address = excluded.address,
    notes = excluded.notes, url = excluded.url, kind = excluded.kind;
  get diagnostics n = row_count;

  if p_replace_from is not null then
    delete from public.events e
    where e.source = p_source and e.starts_on >= p_replace_from
      and not exists (select 1 from jsonb_array_elements(p_events) x where btrim(x->>'id') = e.external_id);
  end if;
  return n;
end;
$$;

revoke all on function public.sync_events(text, jsonb, date, text) from public;
grant execute on function public.sync_events(text, jsonb, date, text) to anon, authenticated;
