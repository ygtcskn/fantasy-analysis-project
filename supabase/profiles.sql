-- Visitor profiles for fantezianaliz.com, read and written by src/web/core/profile.js.
-- Run once in Supabase -> SQL Editor -> New query -> Run. Safe to run again.
--
-- One row per signed-in visitor, keyed by their Supabase account. Row-level
-- security lets each visitor read and change only their own row; nobody can
-- list other people's profiles. Nicknames are unique whatever the letter case,
-- which the database enforces without anyone having to read other rows.
-- Deleting an account deletes its profile.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nickname text,
  -- Sportmonks team ID, as in teams.csv; the site's cross-provider key.
  favorite_team_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_nickname_format
    check (nickname is null or nickname ~ '^[A-Za-z0-9ÇĞİÖŞÜçğıöşü_.-]{3,24}$'),
  constraint profiles_favorite_team_id_positive
    check (favorite_team_id is null or favorite_team_id > 0)
);

create unique index if not exists profiles_nickname_unique on public.profiles (lower(nickname));

-- updated_at follows every change; created_at cannot be rewritten by a visitor.
create or replace function public.profiles_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.profiles_touch();

alter table public.profiles enable row level security;

drop policy if exists "Profiles: read own" on public.profiles;
create policy "Profiles: read own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

drop policy if exists "Profiles: create own" on public.profiles;
create policy "Profiles: create own" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);

drop policy if exists "Profiles: update own" on public.profiles;
create policy "Profiles: update own" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- Signed-out visitors get nothing; signed-in ones may read, create and change
-- (never delete) rows, and the policies above narrow that to their own.
revoke all on public.profiles from anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
