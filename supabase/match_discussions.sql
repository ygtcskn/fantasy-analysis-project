-- Maç Tribünü: topics under each match and replies under each topic, read and
-- written by src/web/features/social/social.js.
-- Run once in Supabase -> SQL Editor -> New query -> Run, after profiles.sql.
-- Safe to run again.
--
-- Anyone can read. Only a signed-in visitor with a nickname can post, and only
-- as themselves: the database fills in the author from the session and the
-- profile, whatever the browser sends. Authors can delete their own posts
-- (deleting a topic deletes its replies); nobody can edit. Moderation is the
-- site owner deleting rows in Supabase -> Table Editor.

create table if not exists public.match_topics (
  id bigint generated always as identity primary key,
  -- Sportmonks fixture ID and the season it belongs to, as in fixtures.csv.
  fixture_id bigint not null check (fixture_id > 0),
  season text not null check (season ~ '^\d{4}-\d{4}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Copied from the author's profile, and kept in step with it below.
  author_nickname text not null,
  author_team_id bigint,
  title text not null check (char_length(btrim(title)) between 3 and 120),
  body text not null check (char_length(btrim(body)) between 1 and 3000),
  created_at timestamptz not null default now()
);
create index if not exists match_topics_fixture on public.match_topics (season, fixture_id, created_at desc);
create index if not exists match_topics_author on public.match_topics (user_id, created_at desc);

create table if not exists public.match_replies (
  id bigint generated always as identity primary key,
  topic_id bigint not null references public.match_topics (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  author_nickname text not null,
  author_team_id bigint,
  body text not null check (char_length(btrim(body)) between 1 and 3000),
  created_at timestamptz not null default now()
);
create index if not exists match_replies_topic on public.match_replies (topic_id, created_at);
create index if not exists match_replies_author on public.match_replies (user_id, created_at desc);

-- The author's profile photo (profiles.avatar_path), copied like the nickname.
-- Added after the tables first shipped, so added here rather than above.
alter table public.match_topics add column if not exists author_avatar_path text;
alter table public.match_replies add column if not exists author_avatar_path text;

-- Every new post: the author is the signed-in visitor, named by their profile.
-- No nickname, no post. At most five posts a minute per person, topics and
-- replies together, against spam. The errors' messages are what the page reads.
create or replace function public.match_post_author() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  -- Named apart from the columns, so no query can mistake one for the other.
  v_nickname text;
  v_team bigint;
  v_avatar text;
  v_recent integer;
begin
  new.user_id := auth.uid();
  new.created_at := now();
  if new.user_id is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;
  select p.nickname, p.favorite_team_id, p.avatar_path into v_nickname, v_team, v_avatar
    from public.profiles p where p.id = new.user_id;
  if v_nickname is null then
    raise exception 'nickname_required';
  end if;
  select count(*) into v_recent from (
    select 1 from public.match_topics t where t.user_id = new.user_id and t.created_at > now() - interval '1 minute'
    union all
    select 1 from public.match_replies r where r.user_id = new.user_id and r.created_at > now() - interval '1 minute'
  ) as posts;
  if v_recent >= 5 then
    raise exception 'rate_limited';
  end if;
  new.author_nickname := v_nickname;
  new.author_team_id := v_team;
  new.author_avatar_path := v_avatar;
  return new;
end;
$$;

drop trigger if exists match_topics_author on public.match_topics;
create trigger match_topics_author before insert on public.match_topics
  for each row execute function public.match_post_author();
drop trigger if exists match_replies_author on public.match_replies;
create trigger match_replies_author before insert on public.match_replies
  for each row execute function public.match_post_author();

-- A changed nickname, club or photo shows on the author's earlier posts too. A
-- cleared nickname leaves the posts signed with the last one.
create or replace function public.match_posts_follow_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.nickname is distinct from old.nickname or new.favorite_team_id is distinct from old.favorite_team_id
      or new.avatar_path is distinct from old.avatar_path then
    update public.match_topics
      set author_nickname = coalesce(new.nickname, author_nickname), author_team_id = new.favorite_team_id,
          author_avatar_path = new.avatar_path
      where user_id = new.id;
    update public.match_replies
      set author_nickname = coalesce(new.nickname, author_nickname), author_team_id = new.favorite_team_id,
          author_avatar_path = new.avatar_path
      where user_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_match_posts on public.profiles;
create trigger profiles_match_posts after update on public.profiles
  for each row execute function public.match_posts_follow_profile();

alter table public.match_topics enable row level security;
alter table public.match_replies enable row level security;

drop policy if exists "Match topics: anyone reads" on public.match_topics;
create policy "Match topics: anyone reads" on public.match_topics
  for select to anon, authenticated using (true);
drop policy if exists "Match topics: author posts" on public.match_topics;
create policy "Match topics: author posts" on public.match_topics
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Match topics: author deletes" on public.match_topics;
create policy "Match topics: author deletes" on public.match_topics
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Match replies: anyone reads" on public.match_replies;
create policy "Match replies: anyone reads" on public.match_replies
  for select to anon, authenticated using (true);
drop policy if exists "Match replies: author posts" on public.match_replies;
create policy "Match replies: author posts" on public.match_replies
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Match replies: author deletes" on public.match_replies;
create policy "Match replies: author deletes" on public.match_replies
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Reading is open; writing names only the columns a visitor may choose. The
-- author, time and ID are filled in by the database.
revoke all on public.match_topics, public.match_replies from anon, authenticated;
grant select on public.match_topics, public.match_replies to anon, authenticated;
grant insert (fixture_id, season, title, body) on public.match_topics to authenticated;
grant insert (topic_id, body) on public.match_replies to authenticated;
grant delete on public.match_topics, public.match_replies to authenticated;
