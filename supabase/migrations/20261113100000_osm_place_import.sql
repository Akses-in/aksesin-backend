-- PBI-09: struktur data tempat hasil impor OpenStreetMap (Overpass).
-- Migration ini aman dijalankan pada dua bentuk tabel places yang mungkin ada:
-- bentuk dari 20261111090000_saved_places.sql dan bentuk dari pembuatan otomatis
-- saat server start (osm_id bertipe text). Semua langkah bersifat idempoten.

-- 1. osm_id lama bertipe text pada tabel hasil pembuatan otomatis. Ubah ke bigint.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'places'
      and column_name = 'osm_id' and data_type = 'text'
  ) then
    alter table public.places
      alter column osm_id type bigint
      using (case when osm_id ~ '^[0-9]+$' then osm_id::bigint end);
  end if;
end $$;

-- 2. Kolom baru. Baris lama otomatis menjadi data_source 'manual'.
alter table public.places
  add column if not exists osm_type text,
  add column if not exists osm_id bigint,
  add column if not exists accessibility_status text not null default 'unknown',
  add column if not exists accessibility_attributes jsonb not null default '{}'::jsonb,
  add column if not exists data_source text not null default 'manual',
  add column if not exists source_updated_at timestamptz,
  add column if not exists last_imported_at timestamptz,
  add column if not exists edited_by_admin boolean not null default false,
  add column if not exists edited_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'places_osm_type_check') then
    alter table public.places
      add constraint places_osm_type_check
      check (osm_type is null or osm_type in ('node', 'way', 'relation'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'places_accessibility_status_check') then
    alter table public.places
      add constraint places_accessibility_status_check
      check (accessibility_status in ('accessible', 'partial', 'unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'places_data_source_check') then
    alter table public.places
      add constraint places_data_source_check
      check (data_source in ('manual', 'osm'));
  end if;
end $$;

-- 3. Identitas sumber menggantikan unique (name, address). Banyak tempat OSM
-- bernama sama dengan alamat kosong, sehingga unique lama membuat impor gagal.
alter table public.places drop constraint if exists places_name_address_key;

create unique index if not exists places_osm_identity_idx
  on public.places (osm_type, osm_id)
  where osm_id is not null;
create index if not exists places_accessibility_status_idx
  on public.places (accessibility_status);
create index if not exists places_data_source_idx
  on public.places (data_source);

alter table public.places enable row level security;

-- 4. Tempat OSM yang dihapus admin tidak dimasukkan lagi oleh impor berikutnya.
create table if not exists public.place_import_exclusions (
  osm_type text not null check (osm_type in ('node', 'way', 'relation')),
  osm_id bigint not null,
  place_name text not null default '',
  reason text not null default 'deleted' check (char_length(reason) <= 80),
  excluded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (osm_type, osm_id)
);

-- 5. Riwayat job impor (PBI-09 butuh status 202/409 dan PBI-10 menampilkan riwayat).
create table if not exists public.place_import_jobs (
  id uuid primary key default gen_random_uuid(),
  triggered_by uuid references auth.users(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  area text not null default 'DKI Jakarta',
  started_at timestamptz,
  finished_at timestamptz,
  fetched_count integer not null default 0,
  created_count integer not null default 0,
  updated_count integer not null default 0,
  unchanged_count integer not null default 0,
  skipped_count integer not null default 0,
  skip_breakdown jsonb not null default '{}'::jsonb,
  error_message text check (error_message is null or char_length(error_message) <= 300),
  source_endpoint text check (source_endpoint is null or char_length(source_endpoint) <= 200),
  created_at timestamptz not null default now()
);

create index if not exists place_import_jobs_created_idx
  on public.place_import_jobs (created_at desc);

-- Maksimal satu job aktif. Menjamin 409 walau ada dua request bersamaan.
create unique index if not exists place_import_jobs_single_active_idx
  on public.place_import_jobs ((true))
  where status in ('queued', 'running');

-- 6. Tabel operasional: hanya diakses backend lewat koneksi database.
-- Otorisasi admin dicek di kode Express, jadi tidak ada grant ke anon/authenticated.
alter table public.place_import_exclusions enable row level security;
alter table public.place_import_jobs enable row level security;

revoke all on public.place_import_exclusions from public, anon, authenticated;
revoke all on public.place_import_jobs from public, anon, authenticated;
