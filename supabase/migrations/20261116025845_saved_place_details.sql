alter table public.saved_places
  add column label text check (char_length(label) <= 100 and btrim(label) <> ''),
  add column note text check (char_length(note) <= 300 and btrim(note) <> '');

revoke all on public.saved_places from public, anon, authenticated;
grant select, insert, delete, update (label, note) on public.saved_places to authenticated;

create policy "Update own saved place details"
on public.saved_places for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
