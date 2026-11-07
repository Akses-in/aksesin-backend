create table public.accessibility_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  disability_status text check (disability_status in ('disabled', 'not_disabled', 'undisclosed')),
  needs text[] not null default '{}'
    check (cardinality(needs) <= 6 and array_position(needs, null) is null and
           needs <@ array['step_free', 'priority_seating', 'audio', 'visual', 'companion', 'other']::text[]),
  notes text not null default '' check (char_length(notes) <= 300),
  onboarding_skipped boolean not null default false,
  check (not onboarding_skipped or (disability_status is null and cardinality(needs) = 0 and notes = ''))
);

alter table public.accessibility_preferences enable row level security;

revoke all on public.accessibility_preferences from public, anon, authenticated;
grant select, insert, update on public.accessibility_preferences to authenticated;

create policy "Read own accessibility preferences"
on public.accessibility_preferences for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Insert own accessibility preferences"
on public.accessibility_preferences for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Update own accessibility preferences"
on public.accessibility_preferences for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
