-- PBI-17: Digital Accessibility Card Application
-- PBI-18: Card Application Status Notification

create table public.digital_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  full_name text not null check (char_length(full_name) between 1 and 100),
  disability_category text not null check (
    disability_category in (
      'fisik',
      'sensorik_netra',
      'sensorik_runguwicara',
      'intelektual',
      'mental',
      'ganda_lainnya'
    )
  ),
  needs text[] not null default '{}' check (
    cardinality(needs) <= 6
    and array_position(needs, null) is null
    and needs <@ array['step_free', 'priority_seating', 'audio', 'visual', 'companion', 'other']::text[]
  ),
  notes text not null default '' check (char_length(notes) <= 500),
  consent_given boolean not null check (consent_given = true),
  consent_at timestamptz not null default now(),
  status text not null default 'pending' check (
    status in (
      'pending',
      'diproses',
      'perbaikan',
      'verified',
      'rejected',
      'dicabut',
      'dibatalkan'
    )
  ),
  reviewer_note text not null default '' check (char_length(reviewer_note) <= 500),
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_at timestamptz,
  cancelled_at timestamptz
);

create unique index digital_cards_one_active_per_user_idx
  on public.digital_cards (user_id)
  where status in ('pending', 'diproses', 'perbaikan', 'verified');

create index digital_cards_user_updated_idx
  on public.digital_cards (user_id, updated_at desc);

create table public.card_evidence (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.digital_cards(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  document_type text not null check (
    document_type in ('surat_keterangan', 'kartu_komunitas', 'dokumen_pendukung_lain')
  ),
  file_name text not null check (char_length(file_name) between 1 and 255),
  mime_type text not null check (
    mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
  ),
  file_size integer not null check (file_size between 1 and 5242880),
  file_path text not null check (char_length(file_path) >= 1),
  uploaded_at timestamptz not null default now()
);

create index card_evidence_card_idx on public.card_evidence (card_id);

create table public.card_verifications (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.digital_cards(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  previous_status text,
  new_status text not null check (
    new_status in (
      'pending',
      'diproses',
      'perbaikan',
      'verified',
      'rejected',
      'dicabut',
      'dibatalkan'
    )
  ),
  reason text not null default '' check (char_length(reason) <= 500),
  created_at timestamptz not null default now()
);

create index card_verifications_card_idx on public.card_verifications (card_id, created_at desc);

create table public.card_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid not null references public.digital_cards(id) on delete cascade,
  status text not null check (
    status in (
      'pending',
      'diproses',
      'perbaikan',
      'verified',
      'rejected',
      'dicabut',
      'dibatalkan'
    )
  ),
  title text not null check (char_length(title) between 1 and 160),
  message text not null check (char_length(message) between 1 and 500),
  deep_link text not null default '/kartu-aksesibilitas',
  dedup_key text not null unique,
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index card_notifications_user_created_idx
  on public.card_notifications (user_id, created_at desc);

-- Row Level Security (RLS)
alter table public.digital_cards enable row level security;
alter table public.card_evidence enable row level security;
alter table public.card_verifications enable row level security;
alter table public.card_notifications enable row level security;

revoke all on public.digital_cards from public, anon, authenticated;
revoke all on public.card_evidence from public, anon, authenticated;
revoke all on public.card_verifications from public, anon, authenticated;
revoke all on public.card_notifications from public, anon, authenticated;

grant select, insert, update on public.digital_cards to authenticated;
grant select, insert, delete on public.card_evidence to authenticated;
grant select on public.card_verifications to authenticated;
grant select, update on public.card_notifications to authenticated;

-- Policies for digital_cards (owner-only access; updates restricted to editable/cancellable states)
create policy "Read own digital cards"
  on public.digital_cards for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Insert own digital card"
  on public.digital_cards for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and consent_given = true
    and status = 'pending'
  );

create policy "Update own digital card before verification finishes"
  on public.digital_cards for update to authenticated
  using (
    (select auth.uid()) = user_id
    and status in ('pending', 'diproses', 'perbaikan')
  )
  with check (
    (select auth.uid()) = user_id
    and status in ('pending', 'perbaikan', 'dibatalkan')
  );

-- Policies for card_evidence (owner-only access)
create policy "Read own card evidence"
  on public.card_evidence for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Insert own card evidence"
  on public.card_evidence for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Delete own card evidence"
  on public.card_evidence for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Policies for card_verifications (owner can read history of their own card)
create policy "Read own card verification history"
  on public.card_verifications for select to authenticated
  using (
    exists (
      select 1 from public.digital_cards c
      where c.id = card_verifications.card_id
        and c.user_id = (select auth.uid())
    )
  );

-- Policies for card_notifications (owner-only access)
create policy "Read own card notifications"
  on public.card_notifications for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Mark own card notifications as read"
  on public.card_notifications for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

