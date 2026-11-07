alter table aksesin_private.whatsapp_challenges
  add column purpose text not null default 'registration';

update aksesin_private.whatsapp_challenges
set purpose = 'phone_change'
where account_id is not null;

alter table aksesin_private.whatsapp_challenges
  add constraint whatsapp_challenge_flow_check
    check (
      (purpose = 'registration' and account_id is null) or
      (purpose in ('phone_change', 'login') and account_id is not null)
    );
