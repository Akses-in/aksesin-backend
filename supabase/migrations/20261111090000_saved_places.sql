create table public.places (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  category text not null default '' check (char_length(category) <= 80),
  address text not null default '' check (char_length(address) <= 300),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  created_at timestamptz not null default now(),
  unique (name, address)
);

create table public.saved_places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, place_id)
);

create index saved_places_user_created_idx on public.saved_places (user_id, created_at desc);
create index places_name_idx on public.places (name);

alter table public.places enable row level security;
alter table public.saved_places enable row level security;

revoke all on public.places from public, anon, authenticated;
revoke all on public.saved_places from public, anon, authenticated;

grant select on public.places to authenticated;
grant select, insert, delete on public.saved_places to authenticated;

create policy "Read places"
on public.places for select to authenticated
using (true);

create policy "Read own saved places"
on public.saved_places for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Insert own saved place"
on public.saved_places for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Delete own saved place"
on public.saved_places for delete to authenticated
using ((select auth.uid()) = user_id);

-- Starter rows so the picker works before the locations PBI fills this table.
-- `on conflict do nothing` lets that importer add its own rows without clashing.
insert into public.places (name, category, address) values
  ('Stasiun MRT Bundaran HI', 'transportasi', 'Jalan M.H. Thamrin, Jakarta Pusat'),
  ('Halte TransJakarta Sarinah', 'transportasi', 'Jalan M.H. Thamrin, Jakarta Pusat'),
  ('Perpustakaan Nasional Republik Indonesia', 'layanan publik', 'Jalan Medan Merdeka Selatan, Jakarta Pusat'),
  ('Taman Suropati', 'taman', 'Jalan Taman Suropati, Jakarta Pusat'),
  ('Grand Indonesia', 'perbelanjaan', 'Jalan M.H. Thamrin, Jakarta Pusat'),
  ('RSUPN Dr. Cipto Mangunkusumo', 'kesehatan', 'Jalan Diponegoro, Jakarta Pusat')
on conflict (name, address) do nothing;
