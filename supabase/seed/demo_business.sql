-- Rendo demo business for testing with the Meta TEST number.
-- Run in Supabase -> SQL Editor. Safe to run again: it updates instead of duplicating.
--
-- BEFORE RUNNING: replace OWNER_NUMBER below with your own WhatsApp number, international format,
-- digits only, no "+" or spaces (e.g. 2376XXXXXXXX). It must be a number on the test number's
-- allowed-recipient list, because the owner alerts will be sent there.
-- If you forget, the insert fails on purpose (the owner_whatsapp format check rejects it).
-- Requires migrations up to 0008 (flexible catalogue).

begin;

insert into public.businesses
  (name, phone_number_id, owner_whatsapp, timezone, default_language,
   slot_minutes, buffer_minutes, booking_horizon_days, min_notice_minutes)
values
  ('Rendo Démo', '1392005827320537', 'OWNER_NUMBER', 'Africa/Douala', 'fr', 30, 10, 10, 120)
on conflict (phone_number_id) do update
  set name = excluded.name,
      owner_whatsapp = excluded.owner_whatsapp,
      timezone = excluded.timezone,
      default_language = excluded.default_language,
      slot_minutes = excluded.slot_minutes,
      buffer_minutes = excluded.buffer_minutes,
      booking_horizon_days = excluded.booking_horizon_days,
      min_notice_minutes = excluded.min_notice_minutes;

-- Catalogue: shows every catalogue feature (categories with variants, price modes, notes, English names).
-- Names max 24 characters (WhatsApp list rows). Long services must fit inside ONE opening range.
insert into public.services
  (business_id, category, category_en, name, name_en, duration_minutes, price_xaf, price_mode, note, note_en, sort_order)
select b.id, s.category, s.category_en, s.name, s.name_en, s.minutes, s.price, s.mode, s.note, s.note_en, s.sort
from public.businesses b
cross join (values
  ('Coiffure', 'Hair',  'Coupe',        'Haircut',        30,   3000, 'fixed', null, null, 1),
  ('Coiffure', 'Hair',  'Brushing',     'Blow-dry',       30,   2500, 'fixed', null, null, 2),
  ('Tresses',  'Braids', 'Courtes',     'Short',         180,  10000, 'from',
     'Prix selon le modèle, mèches non comprises : en vente au salon, ou apportez les vôtres.',
     'Price depends on the style. Hair extensions not included: sold at the salon, or bring your own.', 3),
  ('Tresses',  'Braids', 'Longues',     'Long',          240,  18000, 'from',
     'Prix selon la longueur, mèches non comprises : en vente au salon, ou apportez les vôtres.',
     'Price depends on the length. Hair extensions not included: sold at the salon, or bring your own.', 4),
  ('',         null,     'Manucure',    'Manicure',       45,   4000, 'fixed', null, null, 5),
  ('',         null,     'Conseil beauté', 'Beauty advice', 30,  null, 'on_site',
     'Le prix est fixé sur place selon vos besoins.', 'The price is set at the salon depending on your needs.', 6)
) as s(category, category_en, name, name_en, minutes, price, mode, note, note_en, sort)
where b.phone_number_id = '1392005827320537'
on conflict (business_id, category, name) do update
  set category_en = excluded.category_en,
      name_en = excluded.name_en,
      duration_minutes = excluded.duration_minutes,
      price_xaf = excluded.price_xaf,
      price_mode = excluded.price_mode,
      note = excluded.note,
      note_en = excluded.note_en,
      sort_order = excluded.sort_order,
      active = true;

-- Services from an older version of this seed are switched off (not deleted: appointments keep them).
update public.services s set active = false
from public.businesses b
where s.business_id = b.id and b.phone_number_id = '1392005827320537'
  and (s.category, s.name) not in (('Coiffure', 'Coupe'), ('Coiffure', 'Brushing'), ('Tresses', 'Courtes'),
                                   ('Tresses', 'Longues'), ('', 'Manucure'), ('', 'Conseil beauté'));

-- Opening hours (local time, Africa/Douala): Mon-Fri 08:00-12:00 and 14:00-18:00, Sat 09:00-13:00
delete from public.opening_hours
where business_id = (select id from public.businesses where phone_number_id = '1392005827320537');

insert into public.opening_hours (business_id, weekday, opens_at, closes_at)
select b.id, h.weekday, h.opens_at::time, h.closes_at::time
from public.businesses b
cross join (values
  (1, '08:00', '12:00'), (1, '14:00', '18:00'),
  (2, '08:00', '12:00'), (2, '14:00', '18:00'),
  (3, '08:00', '12:00'), (3, '14:00', '18:00'),
  (4, '08:00', '12:00'), (4, '14:00', '18:00'),
  (5, '08:00', '12:00'), (5, '14:00', '18:00'),
  (6, '09:00', '13:00')
) as h(weekday, opens_at, closes_at)
where b.phone_number_id = '1392005827320537';

commit;

-- Check: one business, 6 active services, 11 opening ranges
select b.name,
       (select count(*) from public.services s where s.business_id = b.id and s.active) as active_services,
       (select count(*) from public.opening_hours h where h.business_id = b.id) as opening_ranges
from public.businesses b
where b.phone_number_id = '1392005827320537';
