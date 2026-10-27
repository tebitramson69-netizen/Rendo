-- Rendo M3.7: each salon decides when the bot talks about prices (decided 27 Oct 2026).
--
-- Why: in Cameroon the same style costs very different amounts from one salon to another, and many
-- salons agree the final price with the client. A list of prices in the very first message can put
-- clients off; no price at all leaves them unsure and they may not come. So the owner chooses:
--   on_request (default): the bot gives prices when the client asks ("c'est combien ?") and always in
--                         the summary before "Confirmer", so nobody is surprised at the salon.
--   always:               prices are shown in every list and option, as before.
--   never:                the bot never quotes an amount; it says the price is agreed at the salon.
-- The estimate is still saved on every booking (appointments.estimate_xaf) for the owner.

alter table public.businesses
  add column price_display text not null default 'on_request'
    check (price_display in ('on_request', 'always', 'never'));

comment on column public.businesses.price_display is
  'When the bot shows prices to clients: on_request (default), always, never.';
