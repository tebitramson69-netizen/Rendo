-- Rendo demo business for testing with the Meta TEST number.
-- Run in Supabase -> SQL Editor. Safe to run again: it updates instead of duplicating.
--
-- BEFORE RUNNING: replace OWNER_NUMBER below with your own WhatsApp number, international format,
-- digits only, no "+" or spaces (e.g. 2376XXXXXXXX). It must be a number on the test number's
-- allowed-recipient list, because the owner alerts will be sent there.
-- If you forget, the insert fails on purpose (the owner_whatsapp format check rejects it).
-- AFTER RUNNING: put OWNER_NUMBER back before committing (never commit your real number).
-- Requires migrations up to 0009 (chairs, style choices).
--
-- Demo salon (M3.6 model): prices depend on the STYLE and the client's CHOICES, not on time.
--   * Each braid style has a base price ("dès" = from) and questions (Taille, Longueur, Mèches).
--     Each answer adds to the price and to the time. Example, Knotless:
--     15 000 base + Medium 5 000 + Dos 3 000 + Du salon 4 000 = dès 27 000 FCFA, about 6 h.
--   * Aliases = words clients type for a style ("sans noeuds"), so "knotless longues" is understood.
--   * 2 chairs: two clients can be served at the same time.
--   * Braiders work through lunch: continuous opening hours.
-- Demo figures only: replace them with a real salon's price board before the pilot.

begin;

insert into public.businesses
  (name, phone_number_id, owner_whatsapp, timezone, default_language,
   slot_minutes, buffer_minutes, booking_horizon_days, min_notice_minutes, chairs)
values
  ('Rendo Démo', '1392005827320537', 'OWNER_NUMBER', 'Africa/Douala', 'fr', 30, 10, 10, 120, 2)
on conflict (phone_number_id) do update
  set name = excluded.name,
      owner_whatsapp = excluded.owner_whatsapp,
      timezone = excluded.timezone,
      default_language = excluded.default_language,
      slot_minutes = excluded.slot_minutes,
      buffer_minutes = excluded.buffer_minutes,
      booking_horizon_days = excluded.booking_horizon_days,
      min_notice_minutes = excluded.min_notice_minutes,
      chairs = excluded.chairs;

-- 1. Styles and services. Names max 24 characters (WhatsApp list rows).
--    The longest combination must fit inside ONE opening range (Knotless Small + Dos = 7 h).
insert into public.services
  (business_id, category, category_en, name, name_en, duration_minutes, price_xaf, price_mode,
   note, note_en, aliases, sort_order)
select b.id, s.category, s.category_en, s.name, s.name_en, s.minutes, s.price, s.mode,
       s.note, s.note_en, s.aliases, s.sort
from public.businesses b
cross join (values
  ('Coiffure', 'Hair', 'Coupe', 'Haircut', 30, 3000, 'fixed', null, null,
     array['coupe', 'couper', 'haircut']::text[], 1),
  ('Coiffure', 'Hair', 'Brushing', 'Blow-dry', 30, 2500, 'fixed', null, null,
     array['brushing', 'blow dry']::text[], 2),
  ('Tresses', 'Braids', 'Knotless', 'Knotless', 240, 15000, 'from',
     'Prix final selon le modèle, confirmé au salon.',
     'Final price depends on the style, confirmed at the salon.',
     array['knotless', 'sans noeuds', 'sans noeud', 'knotless braids']::text[], 3),
  ('Tresses', 'Braids', 'Box braids', 'Box braids', 180, 12000, 'from',
     'Prix final selon le modèle, confirmé au salon.',
     'Final price depends on the style, confirmed at the salon.',
     array['box braids', 'box', 'boxbraids']::text[], 4),
  ('Tresses', 'Braids', 'Nattes collées', 'Cornrows', 90, 5000, 'from', null, null,
     array['nattes', 'nattes collees', 'cornrows', 'cornrow']::text[], 5),
  ('', null, 'Manucure', 'Manicure', 45, 4000, 'fixed', null, null,
     array['manucure', 'ongles', 'manicure', 'nails']::text[], 6),
  ('', null, 'Conseil beauté', 'Beauty advice', 30, null, 'on_site',
     'Le prix est fixé sur place selon vos besoins.', 'The price is set at the salon depending on your needs.',
     array['conseil', 'advice']::text[], 7)
) as s(category, category_en, name, name_en, minutes, price, mode, note, note_en, aliases, sort)
where b.phone_number_id = '1392005827320537'
on conflict (business_id, category, name) do update
  set category_en = excluded.category_en,
      name_en = excluded.name_en,
      duration_minutes = excluded.duration_minutes,
      price_xaf = excluded.price_xaf,
      price_mode = excluded.price_mode,
      note = excluded.note,
      note_en = excluded.note_en,
      aliases = excluded.aliases,
      sort_order = excluded.sort_order,
      active = true;

-- Services from an older version of this seed (e.g. 'Courtes' / 'Longues') are switched off,
-- not deleted: past appointments keep pointing at them.
update public.services s set active = false
from public.businesses b
where s.business_id = b.id and b.phone_number_id = '1392005827320537'
  and (s.category, s.name) not in (('Coiffure', 'Coupe'), ('Coiffure', 'Brushing'), ('Tresses', 'Knotless'),
                                   ('Tresses', 'Box braids'), ('Tresses', 'Nattes collées'),
                                   ('', 'Manucure'), ('', 'Conseil beauté'));

-- 2. Questions asked for each style (max 3 per style; group names max 24 characters).
insert into public.service_choice_groups (business_id, service_id, name, name_en, sort_order)
select s.business_id, s.id, g.name, g.name_en, g.sort
from public.services s
join public.businesses b on b.id = s.business_id and b.phone_number_id = '1392005827320537'
join (values
  ('Knotless',       'Taille',   'Size',   1),
  ('Knotless',       'Longueur', 'Length', 2),
  ('Knotless',       'Mèches',   'Hair',   3),
  ('Box braids',     'Taille',   'Size',   1),
  ('Box braids',     'Mèches',   'Hair',   2),
  ('Nattes collées', 'Modèle',   'Design', 1)
) as g(style, name, name_en, sort) on s.category = 'Tresses' and s.name = g.style
on conflict (service_id, name) do update
  set name_en = excluded.name_en,
      sort_order = excluded.sort_order;

-- Questions from an older run that are no longer in the list above are removed
-- (a booking keeps its own copy of the chosen options, so nothing is lost).
delete from public.service_choice_groups g
using public.services s, public.businesses b
where g.service_id = s.id and s.business_id = b.id and b.phone_number_id = '1392005827320537'
  and (s.name, g.name) not in (('Knotless', 'Taille'), ('Knotless', 'Longueur'), ('Knotless', 'Mèches'),
                               ('Box braids', 'Taille'), ('Box braids', 'Mèches'), ('Nattes collées', 'Modèle'));

-- 3. Answers: what each one ADDS to the base price (FCFA) and to the time (minutes).
--    Choice names max 20 characters (WhatsApp buttons), written from the salon's side:
--    "Vos mèches" = the client brings her own hair; "Du salon" = the salon sells the hair.
insert into public.service_choices
  (business_id, group_id, name, name_en, price_add_xaf, duration_add_minutes, sort_order, active)
select g.business_id, g.id, c.name, c.name_en, c.price_add, c.minutes_add, c.sort, true
from public.service_choice_groups g
join public.services s on s.id = g.service_id
join public.businesses b on b.id = s.business_id and b.phone_number_id = '1392005827320537'
join (values
  ('Knotless',       'Taille',   'Jumbo',       'Jumbo',         0,   0, 1),
  ('Knotless',       'Taille',   'Medium',      'Medium',     5000,  60, 2),
  ('Knotless',       'Taille',   'Small',       'Small',     10000, 120, 3),
  ('Knotless',       'Longueur', 'Épaules',     'Shoulder',      0,   0, 1),
  ('Knotless',       'Longueur', 'Dos',         'Back',       3000,  60, 2),
  ('Knotless',       'Mèches',   'Vos mèches',  'Your own hair', 0,   0, 1),
  ('Knotless',       'Mèches',   'Du salon',    'Salon hair', 4000,   0, 2),
  ('Box braids',     'Taille',   'Medium',      'Medium',        0,   0, 1),
  ('Box braids',     'Taille',   'Small',       'Small',      6000,  90, 2),
  ('Box braids',     'Mèches',   'Vos mèches',  'Your own hair', 0,   0, 1),
  ('Box braids',     'Mèches',   'Du salon',    'Salon hair', 3000,   0, 2),
  ('Nattes collées', 'Modèle',   'Simple',      'Simple',        0,   0, 1),
  ('Nattes collées', 'Modèle',   'Avec motifs', 'Patterned',  2000,  30, 2)
) as c(style, grp, name, name_en, price_add, minutes_add, sort) on s.name = c.style and g.name = c.grp
on conflict (group_id, name) do update
  set name_en = excluded.name_en,
      price_add_xaf = excluded.price_add_xaf,
      duration_add_minutes = excluded.duration_add_minutes,
      sort_order = excluded.sort_order,
      active = true;

-- Answers from an older run that are no longer in the list above are switched off.
update public.service_choices c set active = false
from public.service_choice_groups g, public.services s, public.businesses b
where c.group_id = g.id and g.service_id = s.id and s.business_id = b.id
  and b.phone_number_id = '1392005827320537'
  and (s.name, g.name, c.name) not in (
    ('Knotless', 'Taille', 'Jumbo'), ('Knotless', 'Taille', 'Medium'), ('Knotless', 'Taille', 'Small'),
    ('Knotless', 'Longueur', 'Épaules'), ('Knotless', 'Longueur', 'Dos'),
    ('Knotless', 'Mèches', 'Vos mèches'), ('Knotless', 'Mèches', 'Du salon'),
    ('Box braids', 'Taille', 'Medium'), ('Box braids', 'Taille', 'Small'),
    ('Box braids', 'Mèches', 'Vos mèches'), ('Box braids', 'Mèches', 'Du salon'),
    ('Nattes collées', 'Modèle', 'Simple'), ('Nattes collées', 'Modèle', 'Avec motifs'));

-- 4. Opening hours (local time, Africa/Douala): Mon-Fri 08:00-18:00, Sat 09:00-17:00, continuous
delete from public.opening_hours
where business_id = (select id from public.businesses where phone_number_id = '1392005827320537');

insert into public.opening_hours (business_id, weekday, opens_at, closes_at)
select b.id, h.weekday, h.opens_at::time, h.closes_at::time
from public.businesses b
cross join (values
  (1, '08:00', '18:00'), (2, '08:00', '18:00'), (3, '08:00', '18:00'),
  (4, '08:00', '18:00'), (5, '08:00', '18:00'), (6, '09:00', '17:00')
) as h(weekday, opens_at, closes_at)
where b.phone_number_id = '1392005827320537';

commit;

-- Check. Expected: Rendo Démo | 2 | 7 | 6 | 13 | 6
select b.name,
       b.chairs,
       (select count(*) from public.services s where s.business_id = b.id and s.active) as active_services,
       (select count(*) from public.service_choice_groups g where g.business_id = b.id) as questions,
       (select count(*) from public.service_choices c where c.business_id = b.id and c.active) as answers,
       (select count(*) from public.opening_hours h where h.business_id = b.id) as opening_ranges
from public.businesses b
where b.phone_number_id = '1392005827320537';
