alter table aksesin_private.whatsapp_challenges
  add column account_id uuid references auth.users(id) on delete cascade,
  alter column full_name drop not null,
  add constraint whatsapp_challenge_purpose_check
    check ((account_id is null) = (full_name is not null));

create index whatsapp_challenge_account_idx
  on aksesin_private.whatsapp_challenges (account_id)
  where account_id is not null;
