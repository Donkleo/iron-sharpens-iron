-- Iron Sharpens Iron: your family and brother to pray for each week
--
-- Like the app: each person picks their family once. Every family prays for
-- one other family each week, and the pairs change every Sunday (or the
-- family the sheet's "Pray for" column names). Each person also gets that
-- family's brother, and can tap "I prayed for Mike" for the man himself, not
-- only for his requests.
--
-- This builds on the families' husband, wife, pray_for and since columns
-- from 20261125220000_sheet_families.sql, so run that file first.
--
-- Who can do what:
--   * Members set their own family (and their wife's first name) with
--     set_my_family(). A family typed in that isn't on the list yet joins
--     the weekly circle the next Sunday, so nobody's pairs change mid-week.
--   * "I prayed for him" marks are yours to add or undo, like "I prayed".
--   * "Also praying for" picks are private to the person who made them.
--
-- Apply once in the Supabase dashboard: SQL Editor, paste this file, Run.

-- ---------------------------------------------------------------------------
-- Members: which family each person belongs to
-- ---------------------------------------------------------------------------

alter table public.members
  add column family_id uuid references public.families (id) on delete set null;
create index members_family_idx on public.members (family_id);

grant select (family_id) on public.members to authenticated;

-- Pick (or add) your own family. Members can't write family_id directly, so
-- nobody can move someone else into a family.
create function public.set_my_family(p_family uuid, p_name text, p_wife text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  fid uuid := p_family;
  nm text := nullif(btrim(coalesce(p_name, '')), '');
  wf text := nullif(btrim(coalesce(p_wife, '')), '');
  first text;
  added boolean := false;
begin
  if not public.is_member() then
    raise exception 'Only group members can do that.' using errcode = '42501';
  end if;
  if fid is null then
    if nm is null then
      raise exception 'Pick your family or type its name.' using errcode = '22023';
    end if;
    select f.id into fid from public.families f where lower(btrim(f.name)) = lower(nm);
    if fid is null then
      insert into public.families (name, created_by) values (nm, auth.uid())
      on conflict do nothing
      returning id into fid;
      added := fid is not null;
      if fid is null then
        select f.id into fid from public.families f where lower(btrim(f.name)) = lower(nm);
      end if;
    end if;
  elsif not exists (select 1 from public.families f where f.id = fid) then
    raise exception 'That family is no longer on the list.' using errcode = '22023';
  end if;

  update public.members set family_id = fid where id = auth.uid();

  select nullif(split_part(btrim(m.display_name), ' ', 1), '') into first
  from public.members m where m.id = auth.uid();

  -- Fill in the names the sheet hasn't given. The sheet sync still wins.
  update public.families f set
    husband = coalesce(f.husband, left(first, 80)),
    wife = coalesce(left(wf, 80), f.wife),
    since = case when added then (now() at time zone 'America/Chicago')::date else f.since end
  where f.id = fid;

  return fid;
end;
$$;

revoke all on function public.set_my_family(uuid, text, text) from public, anon;
grant execute on function public.set_my_family(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- "I prayed for him": a prayer for a person, not a request
-- ---------------------------------------------------------------------------

create table public.person_prayers (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.members (id) on delete cascade,
  prayed_by   uuid not null default auth.uid() references public.members (id) on delete cascade,
  prayed_at   timestamptz not null default now(),
  constraint person_prayers_not_self check (member_id <> prayed_by)
);
create index person_prayers_member_idx on public.person_prayers (member_id, prayed_at desc);

alter table public.person_prayers enable row level security;
revoke all on public.person_prayers from public, anon, authenticated;
grant select, delete on public.person_prayers to authenticated;
grant insert (member_id) on public.person_prayers to authenticated;
create policy person_prayers_select on public.person_prayers for select to authenticated
  using ((select public.is_member()));
create policy person_prayers_insert on public.person_prayers for insert to authenticated
  with check ((select public.is_member()) and prayed_by = (select auth.uid()));
create policy person_prayers_delete on public.person_prayers for delete to authenticated
  using ((select public.is_member()) and prayed_by = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- "Also praying for": extra families and brothers someone adds for one week
-- ---------------------------------------------------------------------------

create table public.week_extras (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null default auth.uid() references public.members (id) on delete cascade,
  week_of     date not null,
  family_id   uuid references public.families (id) on delete cascade,
  for_member  uuid references public.members (id) on delete cascade,
  created_at  timestamptz not null default now(),
  constraint week_extras_one check ((family_id is null) <> (for_member is null))
);
create unique index week_extras_once on public.week_extras (member_id, week_of, coalesce(family_id, for_member));

alter table public.week_extras enable row level security;
revoke all on public.week_extras from public, anon, authenticated;
grant select, delete on public.week_extras to authenticated;
grant insert (week_of, family_id, for_member) on public.week_extras to authenticated;
create policy week_extras_select on public.week_extras for select to authenticated
  using ((select public.is_member()) and member_id = (select auth.uid()));
create policy week_extras_insert on public.week_extras for insert to authenticated
  with check ((select public.is_member()) and member_id = (select auth.uid()));
create policy week_extras_delete on public.week_extras for delete to authenticated
  using ((select public.is_member()) and member_id = (select auth.uid()));
