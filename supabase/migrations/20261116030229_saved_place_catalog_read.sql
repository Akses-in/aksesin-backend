revoke all on public.places from public, anon, authenticated;
grant select (id, name, category, address) on public.places to authenticated;

drop policy if exists "Read places" on public.places;
create policy "Read places"
on public.places for select to authenticated
using (true);
