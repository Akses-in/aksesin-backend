create schema if not exists aksesin_private;
revoke all on schema aksesin_private from public, anon, authenticated;

create table aksesin_private.whatsapp_challenges (
  phone text primary key check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  challenge_id uuid not null,
  full_name text not null check (char_length(full_name) between 1 and 100),
  otp_hash text not null check (char_length(otp_hash) = 64),
  expires_at timestamptz not null,
  last_sent_at timestamptz not null,
  window_started_at timestamptz not null,
  sent_count integer not null check (sent_count between 1 and 5),
  attempts integer not null default 0 check (attempts between 0 and 5)
);

alter table aksesin_private.whatsapp_challenges enable row level security;
revoke all on aksesin_private.whatsapp_challenges from public, anon, authenticated;
