-- A tiny stand-in for the parts of Supabase the migration relies on, so the
-- access rules can be tested in a real Postgres (PGlite) without a Supabase
-- project. Like Supabase, every new table in public is granted to anon and
-- authenticated by default; the migration has to take that away itself.
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
