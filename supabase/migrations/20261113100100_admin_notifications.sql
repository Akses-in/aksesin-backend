-- PBI-10: notifikasi admin untuk hasil impor OSM.
-- Bergantung pada place_import_jobs dari 20261113100000_osm_place_import.sql.

create table if not exists public.admin_notifications (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('osm_import_succeeded', 'osm_import_failed')),
  job_id uuid references public.place_import_jobs(id) on delete set null,
  title text not null check (char_length(title) between 1 and 160),
  message text not null check (char_length(message) between 1 and 500),
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

-- Satu job hanya boleh menghasilkan satu notifikasi per jenis.
create unique index if not exists admin_notifications_job_type_idx
  on public.admin_notifications (job_id, type)
  where job_id is not null;

create index if not exists admin_notifications_created_idx
  on public.admin_notifications (created_at desc);

alter table public.admin_notifications enable row level security;

revoke all on public.admin_notifications from public, anon, authenticated;
