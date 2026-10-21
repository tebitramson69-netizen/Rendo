-- Rendo M1: replace the "always true" insert policy on the public waitlist with real input checks.
-- Fixes Security Advisor warning "RLS Policy Always True" and stops junk/oversized rows via the public key.
--
-- Constraints are added NOT VALID: they apply to every new row but don't fail on rows already stored.

alter table public.waitlist
  add constraint waitlist_full_name_len
    check (char_length(btrim(full_name)) between 2 and 100) not valid,
  add constraint waitlist_whatsapp_chars
    check (whatsapp ~ '^[+0-9 ().-]{8,25}$') not valid,
  add constraint waitlist_whatsapp_digits
    check (char_length(regexp_replace(whatsapp, '[^0-9]', '', 'g')) between 8 and 15) not valid,
  add constraint waitlist_business_name_len
    check (business_name is null or char_length(business_name) <= 100) not valid,
  add constraint waitlist_city_len
    check (city is null or char_length(city) <= 60) not valid,
  add constraint waitlist_business_type_len
    check (business_type is null or char_length(business_type) <= 40) not valid;

drop policy if exists "public can join" on public.waitlist;

create policy "public can join"
  on public.waitlist
  for insert
  to anon
  with check (
    char_length(btrim(full_name)) between 2 and 100
    and char_length(regexp_replace(whatsapp, '[^0-9]', '', 'g')) between 8 and 15
  );

-- Least privilege: the public key only ever needs INSERT (the form sends "Prefer: return=minimal").
-- Supabase grants ALL on new public tables by default; TRUNCATE in particular is not covered by RLS.
revoke all on table public.waitlist from anon, authenticated;
grant insert on table public.waitlist to anon;
