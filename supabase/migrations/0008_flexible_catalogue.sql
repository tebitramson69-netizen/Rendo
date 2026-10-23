-- Rendo M3.5: a catalogue that fits salons AND clinics.
--
-- * Categories with variants: "Tresses" -> "Courtes" (3 h) / "Longues" (4 h). Each variant is a normal
--   service row with its OWN duration and price, so the calendar always blocks the right amount of time.
--   The bot shows categories first, then the variants of the chosen category.
-- * Price mode: 'fixed' (3 000 FCFA), 'from' (dès 15 000 FCFA: depends on style/length),
--   'on_site' (price confirmed at the salon / after the consultation, e.g. clinics).
-- * Optional English names and a short note shown before the client confirms
--   ("Prix selon la longueur. Apportez vos mèches.").
-- No medical information: names and notes are labels chosen by the business.

alter table public.services
  add column name_en     text check (name_en is null or char_length(btrim(name_en)) between 2 and 24),
  -- '' = no category (the service is shown directly)
  add column category    text not null default '' check (char_length(category) <= 24),
  add column category_en text check (category_en is null or char_length(btrim(category_en)) between 1 and 24),
  add column price_mode  text not null default 'fixed' check (price_mode in ('fixed', 'from', 'on_site')),
  add column note        text check (note is null or char_length(note) <= 150),
  add column note_en     text check (note_en is null or char_length(note_en) <= 150),
  -- "dès X FCFA" needs X
  add constraint services_from_needs_price check (price_mode <> 'from' or price_xaf is not null);

-- The same variant name may exist in two categories ("Courtes" braids and "Courtes" locks).
alter table public.services drop constraint services_business_id_name_key;
alter table public.services add constraint services_business_category_name_key unique (business_id, category, name);

comment on column public.services.category is 'Group shown first in the bot (e.g. Tresses); empty = shown directly.';
comment on column public.services.price_mode is
  'fixed: price_xaf shown as is (or nothing if null) | from: "dès price_xaf" | on_site: price confirmed on site';
