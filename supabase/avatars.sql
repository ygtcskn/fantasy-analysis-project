-- Profile photos for fantezianaliz.com, uploaded by src/web/core/profile.js.
-- Run once in Supabase -> SQL Editor -> New query -> Run, after profiles.sql and
-- match_discussions.sql. Safe to run again.
--
-- A public bucket: anyone can view a photo by its address, which is how the
-- site shows them. Uploading and deleting are limited to the signed-in visitor's
-- own folder, <their id>/, at most three files at a time so storage cannot be
-- filled. The page shrinks every photo to a 256-pixel square before upload, and
-- the bucket refuses anything that is not a small image anyway.
-- Moderation: delete the file in Supabase -> Storage -> avatars; the site then
-- shows the person's club crest instead.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 524288, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Counts a visitor's photos for the upload policy. Kept out of the public
-- schema, so the site's API cannot call it to look into other people's folders.
create schema if not exists private;
grant usage on schema private to authenticated;
create or replace function private.avatar_file_count(owner uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from storage.objects o
  where o.bucket_id = 'avatars' and (storage.foldername(o.name))[1] = owner::text;
$$;
revoke all on function private.avatar_file_count(uuid) from public;
grant execute on function private.avatar_file_count(uuid) to authenticated;

drop policy if exists "Avatars: owner lists own folder" on storage.objects;
create policy "Avatars: owner lists own folder" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Avatars: owner uploads to own folder" on storage.objects;
create policy "Avatars: owner uploads to own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and private.avatar_file_count((select auth.uid())) < 3);

drop policy if exists "Avatars: owner deletes own files" on storage.objects;
create policy "Avatars: owner deletes own files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
