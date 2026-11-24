-- Iron Sharpens Iron: prayer core (first release)
--
-- Who can do what:
--   * Nobody can sign up unless their email is on public.invites.
--   * Only signed-in members whose invite still exists can read or write
--     prayers, families, updates and "I prayed" marks. Removing an invite
--     takes that person's access away straight away.
--   * The public (anon) key can read nothing.
--   * Admins (role = 'admin' on their invite) manage the invite list.
--
-- Apply once in the Supabase dashboard: SQL Editor, paste this file, Run.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.invites (
  email       text primary key
              check (email = lower(btrim(email)) and email like '_%@_%'),
  name        text not null check (length(btrim(name)) between 1 and 80),
  role        text not null default 'member' check (role in ('member', 'admin')),
  invited_at  timestamptz not null default now()
);

create table public.members (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null unique,
  display_name  text not null check (length(btrim(display_name)) between 1 and 80),
  created_at    timestamptz not null default now()
);

create table public.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 80),
  created_by  uuid default auth.uid() references public.members (id) on delete set null,
  created_at  timestamptz not null default now()
);
create unique index families_name_key on public.families (lower(btrim(name)));

create table public.requests (
  id             uuid primary key default gen_random_uuid(),
  list           text not null check (list in ('lifegroup', 'brothers')),
  family_id      uuid references public.families (id) on delete restrict,
  for_member     uuid references public.members (id) on delete set null,
  for_name       text check (for_name is null or length(btrim(for_name)) between 1 and 80),
  body           text not null check (length(btrim(body)) between 1 and 2000),
  sheet_date     date,
  status         text not null default 'active' check (status in ('active', 'answered')),
  answered_at    timestamptz,
  answered_note  text check (answered_note is null or length(answered_note) <= 2000),
  answered_by    uuid references public.members (id) on delete set null,
  created_by     uuid default auth.uid() references public.members (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint requests_owner check (
    (list = 'lifegroup' and family_id is not null)
    or (list = 'brothers' and family_id is null and (for_member is not null or for_name is not null))
  )
);
create index requests_list_status_idx on public.requests (list, status);
create index requests_family_idx on public.requests (family_id);

create table public.request_updates (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.requests (id) on delete cascade,
  body        text not null check (length(btrim(body)) between 1 and 2000),
  created_by  uuid default auth.uid() references public.members (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index request_updates_request_idx on public.request_updates (request_id, created_at desc);

create table public.prayers (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.requests (id) on delete cascade,
  member_id   uuid not null default auth.uid() references public.members (id) on delete cascade,
  prayed_at   timestamptz not null default now()
);
create index prayers_request_idx on public.prayers (request_id, prayed_at desc);

-- ---------------------------------------------------------------------------
-- Helpers used by the access rules
-- ---------------------------------------------------------------------------

create function public.is_member() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.members m
    join public.invites i on i.email = m.email
    where m.id = auth.uid()
  );
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.members m
    join public.invites i on i.email = m.email
    where m.id = auth.uid() and i.role = 'admin'
  );
$$;

create function public.my_email() returns text
language sql stable security definer set search_path = ''
as $$
  select m.email from public.members m where m.id = auth.uid();
$$;

revoke all on function public.my_email() from public, anon;
grant execute on function public.my_email() to authenticated;
revoke all on function public.is_member() from public, anon;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_member() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Invite-only sign-up
-- ---------------------------------------------------------------------------

-- Refuse to create an account for any email that is not on the invite list.
create function public.enforce_invite() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.email is null
     or not exists (select 1 from public.invites i where i.email = lower(new.email)) then
    raise exception 'This email is not on the invite list.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Give every new account a member row, named from its invite.
create function public.create_member() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.members (id, email, display_name)
  select new.id, i.email, i.name
  from public.invites i
  where i.email = lower(new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.enforce_invite() from public, anon, authenticated;
revoke all on function public.create_member() from public, anon, authenticated;

create trigger enforce_invite
  before insert on auth.users
  for each row execute function public.enforce_invite();

create trigger create_member
  after insert on auth.users
  for each row execute function public.create_member();

-- If someone already had an account before being invited, give them their
-- member row as soon as the invite is added.
create function public.member_from_invite() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.members (id, email, display_name)
  select u.id, new.email, new.name
  from auth.users u
  where lower(u.email) = new.email
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.member_from_invite() from public, anon, authenticated;

create trigger member_from_invite
  after insert on public.invites
  for each row execute function public.member_from_invite();

-- ---------------------------------------------------------------------------
-- Answered: who and when are set by the database, not the browser
-- ---------------------------------------------------------------------------

create function public.stamp_request_status() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.status = 'answered' then
    if tg_op = 'INSERT' or old.status is distinct from 'answered' then
      new.answered_at := now();
      new.answered_by := auth.uid();
    else
      new.answered_at := old.answered_at;
      new.answered_by := old.answered_by;
    end if;
  else
    new.answered_at := null;
    new.answered_by := null;
    new.answered_note := null;
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_request_status() from public, anon, authenticated;

-- Keep the brother's name on his request, so the request still reads right
-- (and can still be saved) if his account is ever removed.
create function public.fill_for_name() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.for_member is not null then
    select m.display_name into new.for_name from public.members m where m.id = new.for_member;
  end if;
  return new;
end;
$$;

revoke all on function public.fill_for_name() from public, anon, authenticated;

create trigger fill_for_name
  before insert or update of for_member on public.requests
  for each row execute function public.fill_for_name();

create trigger stamp_request_status
  before insert or update on public.requests
  for each row execute function public.stamp_request_status();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.invites         enable row level security;
alter table public.members         enable row level security;
alter table public.families        enable row level security;
alter table public.requests        enable row level security;
alter table public.request_updates enable row level security;
alter table public.prayers         enable row level security;

-- Start from nothing, then grant only what the site needs. The anon key
-- gets no access to any table.
revoke all on public.invites, public.members, public.families, public.requests,
  public.request_updates, public.prayers from public, anon, authenticated;

-- invites: admins only
grant select, insert, delete on public.invites to authenticated;
grant update (name, role) on public.invites to authenticated;
create policy invites_admin_select on public.invites for select to authenticated using ((select public.is_admin()));
create policy invites_admin_insert on public.invites for insert to authenticated with check ((select public.is_admin()));
-- An admin can't remove or demote their own invite, so the group always keeps an admin.
create policy invites_admin_update on public.invites for update to authenticated
  using ((select public.is_admin()) and email <> (select public.my_email()))
  with check ((select public.is_admin()));
create policy invites_admin_delete on public.invites for delete to authenticated
  using ((select public.is_admin()) and email <> (select public.my_email()));

-- members: everyone in the group sees names (not emails); you can rename yourself
grant select (id, display_name, created_at) on public.members to authenticated;
grant update (display_name) on public.members to authenticated;
create policy members_select on public.members for select to authenticated using ((select public.is_member()));
create policy members_update_self on public.members for update to authenticated
  using (id = (select auth.uid()) and (select public.is_member()))
  with check (id = (select auth.uid()) and (select public.is_member()));

-- families
grant select on public.families to authenticated;
grant insert (name) on public.families to authenticated;
grant delete on public.families to authenticated;
create policy families_select on public.families for select to authenticated using ((select public.is_member()));
create policy families_insert on public.families for insert to authenticated
  with check ((select public.is_member()) and created_by = (select auth.uid()));
create policy families_delete on public.families for delete to authenticated using ((select public.is_admin()));

-- requests: every member can add, update and answer; delete is for whoever
-- added it, or an admin
grant select on public.requests to authenticated;
grant insert (list, family_id, for_member, for_name, body, sheet_date)
  on public.requests to authenticated;
-- Members can mark a request answered (or not yet) but not rewrite someone
-- else's words.
grant update (status, answered_note) on public.requests to authenticated;
grant delete on public.requests to authenticated;
create policy requests_select on public.requests for select to authenticated using ((select public.is_member()));
create policy requests_insert on public.requests for insert to authenticated
  with check ((select public.is_member()) and created_by = (select auth.uid()));
create policy requests_update on public.requests for update to authenticated
  using ((select public.is_member())) with check ((select public.is_member()));
create policy requests_delete on public.requests for delete to authenticated
  using ((select public.is_member()) and (created_by = (select auth.uid()) or (select public.is_admin())));

-- request_updates
grant select on public.request_updates to authenticated;
grant insert (request_id, body) on public.request_updates to authenticated;
grant delete on public.request_updates to authenticated;
create policy request_updates_select on public.request_updates for select to authenticated using ((select public.is_member()));
create policy request_updates_insert on public.request_updates for insert to authenticated
  with check ((select public.is_member()) and created_by = (select auth.uid()));
create policy request_updates_delete on public.request_updates for delete to authenticated
  using ((select public.is_member()) and (created_by = (select auth.uid()) or (select public.is_admin())));

-- prayers ("I prayed"): you can only mark or undo your own
grant select on public.prayers to authenticated;
grant insert (request_id) on public.prayers to authenticated;
grant delete on public.prayers to authenticated;
create policy prayers_select on public.prayers for select to authenticated using ((select public.is_member()));
create policy prayers_insert on public.prayers for insert to authenticated
  with check ((select public.is_member()) and member_id = (select auth.uid()));
create policy prayers_delete on public.prayers for delete to authenticated
  using ((select public.is_member()) and member_id = (select auth.uid()));

