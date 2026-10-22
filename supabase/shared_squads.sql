-- Kadrolar: the fantasy squads visitors share, one per visitor per matchweek,
-- shown to everyone by src/web/features/squads/squads.js.
-- Run once in Supabase -> SQL Editor -> New query -> Run, after profiles.sql.
-- Safe to run again.
--
-- Anyone can read. Only a signed-in visitor with a nickname can share, and only
-- as themselves: the database fills in the author from the session and the
-- profile, whatever the browser sends. Sharing again for the same week changes
-- that week's squad rather than adding a second one. Authors can delete their
-- own squads. Kadro Kur's "Kadroyu kaydet" saves only for the week whose
-- fantasy deadline is still ahead; the database knows no kickoffs, so that
-- deadline is the page's rule, not one enforced here. Moderation is the site owner deleting rows in Supabase -> Table
-- Editor.

create table if not exists public.shared_squads (
  id bigint generated always as identity primary key,
  -- The season as in fixtures.csv's folder name, and the matchweek's
  -- Sportmonks round ID (round_id in fixtures.csv).
  season text not null check (season ~ '^\d{4}-\d{4}$'),
  round_id bigint not null check (round_id > 0),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Copied from the author's profile, and kept in step with it below.
  author_nickname text not null,
  author_team_id bigint,
  -- Kadro Kur's formations.
  formation text not null check (formation in ('4-4-2', '4-3-3', '4-2-3-1', '3-4-3', '3-5-2', '5-3-2')),
  -- Sportmonks player IDs: the eleven from the goalkeeper forward, then the bench.
  starters bigint[] not null check (cardinality(starters) = 11),
  bench bigint[] not null default '{}' check (cardinality(bench) <= 4),
  -- The eleven's expected fantasy points when shared, summed from the published
  -- projections as Kadro Kur shows it, and how many of the eleven had one; a
  -- total from fewer than 11 is partial. Empty when no projection was current.
  expected_points numeric(6, 2) check (expected_points between 0 and 300),
  projected_starters smallint not null default 0 check (projected_starters between 0 and 11),
  -- When this squad was shared, or last changed.
  shared_at timestamptz not null default now(),
  constraint shared_squads_one_per_week unique (season, round_id, user_id)
);
-- For a table created before this column existed.
alter table public.shared_squads add column if not exists
  projected_starters smallint not null default 0 check (projected_starters between 0 and 11);
create index if not exists shared_squads_week on public.shared_squads (season, round_id, shared_at desc);
create index if not exists shared_squads_author on public.shared_squads (user_id, shared_at desc);

-- A new squad belongs to the signed-in visitor, named by their profile; no
-- nickname, no squad. A change keeps the author and the week, and moves the
-- share time only when the squad itself changed (not when a renamed profile
-- updates the author's name). The errors' messages are what the page reads.
create or replace function public.shared_squad_author() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  -- Named apart from the columns, so no query can mistake one for the other.
  v_nickname text;
  v_team bigint;
begin
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
    new.season := old.season;
    new.round_id := old.round_id;
    new.shared_at := case
      when (new.formation, new.starters, new.bench, new.expected_points, new.projected_starters)
        is distinct from (old.formation, old.starters, old.bench, old.expected_points, old.projected_starters) then now()
      else old.shared_at end;
    return new;
  end if;
  new.user_id := auth.uid();
  new.shared_at := now();
  if new.user_id is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;
  select p.nickname, p.favorite_team_id into v_nickname, v_team
    from public.profiles p where p.id = new.user_id;
  if v_nickname is null then
    raise exception 'nickname_required';
  end if;
  new.author_nickname := v_nickname;
  new.author_team_id := v_team;
  return new;
end;
$$;

drop trigger if exists shared_squads_author on public.shared_squads;
create trigger shared_squads_author before insert or update on public.shared_squads
  for each row execute function public.shared_squad_author();

-- A changed nickname or club shows on the author's earlier squads too. A
-- cleared nickname leaves the squads signed with the last one.
create or replace function public.shared_squads_follow_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.nickname is distinct from old.nickname or new.favorite_team_id is distinct from old.favorite_team_id then
    update public.shared_squads
      set author_nickname = coalesce(new.nickname, author_nickname), author_team_id = new.favorite_team_id
      where user_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_shared_squads on public.profiles;
create trigger profiles_shared_squads after update on public.profiles
  for each row execute function public.shared_squads_follow_profile();

alter table public.shared_squads enable row level security;

drop policy if exists "Shared squads: anyone reads" on public.shared_squads;
create policy "Shared squads: anyone reads" on public.shared_squads
  for select to anon, authenticated using (true);
drop policy if exists "Shared squads: author shares" on public.shared_squads;
create policy "Shared squads: author shares" on public.shared_squads
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Shared squads: author changes" on public.shared_squads;
create policy "Shared squads: author changes" on public.shared_squads
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Shared squads: author deletes" on public.shared_squads;
create policy "Shared squads: author deletes" on public.shared_squads
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Reading is open; writing names only the columns a visitor may choose. The
-- author, time and ID are filled in by the database, and a shared squad stays
-- in its week.
revoke all on public.shared_squads from anon, authenticated;
grant select on public.shared_squads to anon, authenticated;
grant insert (season, round_id, formation, starters, bench, expected_points, projected_starters) on public.shared_squads to authenticated;
grant update (formation, starters, bench, expected_points, projected_starters) on public.shared_squads to authenticated;
grant delete on public.shared_squads to authenticated;
