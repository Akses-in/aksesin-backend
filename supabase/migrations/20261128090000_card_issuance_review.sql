-- PBI-19: Digital Card Verification & Issuance Management
-- PBI-20: Card Application Search & Review History View
--
-- Kartu yang diterbitkan disimpan pada baris pengajuan yang sama (digital_cards) agar status
-- pengajuan dan status kartu selalu berubah dalam satu transaksi. Constraint di bawah menjamin
-- keduanya tidak pernah keluar sinkron walaupun ada penulisan di luar backend.

alter table public.digital_cards
  add column if not exists card_number text,
  add column if not exists qr_token text,
  add column if not exists issued_at timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists revoked_at timestamptz;

-- Backfill kartu yang sudah verified/dicabut sebelum fitur penerbitan ada.
-- Token QR: 32 byte acak dari dua UUID v4, dienkode base64url.
update public.digital_cards
set card_number = 'DAC-' || to_char(coalesce(verified_at, updated_at), 'YYYY') || '-'
      || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
    qr_token = rtrim(translate(encode(decode(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex'
    ), 'base64'), '+/', '-_'), '='),
    issued_at = coalesce(verified_at, updated_at),
    expires_at = coalesce(verified_at, updated_at) + interval '12 months'
where status in ('verified', 'dicabut') and card_number is null;

update public.digital_cards
set revoked_at = updated_at
where status = 'dicabut' and revoked_at is null;

create unique index if not exists digital_cards_card_number_idx
  on public.digital_cards (card_number) where card_number is not null;
create unique index if not exists digital_cards_qr_token_idx
  on public.digital_cards (qr_token) where qr_token is not null;
create index if not exists digital_cards_status_submitted_idx
  on public.digital_cards (status, submitted_at);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'digital_cards_issuance_complete') then
    alter table public.digital_cards
      add constraint digital_cards_issuance_complete check (
        (card_number is null and qr_token is null and issued_at is null and expires_at is null)
        or (
          card_number ~ '^DAC-[0-9]{4}-[0-9A-Z]{8}$'
          and char_length(qr_token) between 32 and 128
          and issued_at is not null
          and expires_at > issued_at
        )
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'digital_cards_issuance_matches_status') then
    alter table public.digital_cards
      add constraint digital_cards_issuance_matches_status check (
        (status in ('verified', 'dicabut')) = (card_number is not null)
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'digital_cards_revocation_matches_status') then
    alter table public.digital_cards
      add constraint digital_cards_revocation_matches_status check (
        (status = 'dicabut') = (revoked_at is not null)
      );
  end if;
end $$;

-- Pemilik tetap dapat memperbarui data pengajuannya, tetapi tidak dapat menulis kolom penerbitan.
revoke update on public.digital_cards from authenticated;
grant update (full_name, disability_category, needs, notes, status, updated_at, cancelled_at)
  on public.digital_cards to authenticated;

-- Riwayat peninjauan / audit trail
alter table public.card_verifications
  add column if not exists action text not null default 'status_changed',
  add column if not exists actor_name text not null default '',
  add column if not exists actor_role text not null default 'system',
  add column if not exists metadata jsonb not null default '{}'::jsonb;

update public.card_verifications v
set action = case
      when v.previous_status is null then 'submitted'
      when v.new_status = 'dibatalkan' then 'cancelled'
      when v.previous_status = 'perbaikan' and v.new_status = 'pending' then 'resubmitted'
      when v.new_status = 'verified' then 'issued'
      when v.new_status = 'dicabut' then 'revoked'
      else 'status_changed'
    end,
    actor_role = case
      when v.actor_id is null then 'system'
      when v.actor_id = c.user_id then 'user'
      else 'admin'
    end
from public.digital_cards c
where c.id = v.card_id;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'card_verifications_action_check') then
    alter table public.card_verifications
      add constraint card_verifications_action_check check (
        action in ('submitted', 'resubmitted', 'status_changed', 'issued', 'renewed', 'revoked', 'cancelled')
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'card_verifications_actor_role_check') then
    alter table public.card_verifications
      add constraint card_verifications_actor_role_check check (actor_role in ('user', 'admin', 'system'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'card_verifications_actor_name_check') then
    alter table public.card_verifications
      add constraint card_verifications_actor_name_check check (char_length(actor_name) <= 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'card_verifications_metadata_check') then
    alter table public.card_verifications
      add constraint card_verifications_metadata_check check (jsonb_typeof(metadata) = 'object');
  end if;
end $$;
