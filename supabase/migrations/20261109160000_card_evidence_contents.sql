create table aksesin_private.card_evidence_contents (
  evidence_id uuid primary key references public.card_evidence(id) on delete cascade,
  content bytea not null check (octet_length(content) between 1 and 5242880)
);

alter table aksesin_private.card_evidence_contents enable row level security;
revoke all on aksesin_private.card_evidence_contents from public, anon, authenticated;

revoke insert, delete on public.card_evidence from authenticated;
drop policy if exists "Insert own card evidence" on public.card_evidence;
drop policy if exists "Delete own card evidence" on public.card_evidence;
