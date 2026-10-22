-- Rendo demo business for testing M3 with the Meta TEST number.
-- Run in Supabase -> SQL Editor. Safe to run again: it updates instead of duplicating.
--
-- BEFORE RUNNING: replace OWNER_NUMBER below with your own WhatsApp number, international format,
-- digits only, no "+" or spaces (e.g. 2376XXXXXXXX). It must be a number on the test number's
-- allowed-recipient list, because the owner alerts will be sent there.
-- If you forget, the insert fails on purpose (the owner_whatsapp format check rejects it).

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

-- Services (names max 24 characters: WhatsApp list rows)
insert into public.services (business_id, name, duration_minutes, price_xaf, sort_order)
select b.id, s.name, s.minutes, s.price, s.sort
from public.businesses b
cross join (values
  ('Coupe', 30, 3000, 1),
  ('Brushing', 30, 2500, 2),
  ('Manucure', 45, 4000, 3),
  ('Tresses', 120, 10000, 4)
) as s(name, minutes, price, sort)
where b.phone_number_id = '1392005827320537'
on conflict (business_id, name) do update
  set duration_minutes = excluded.duration_minutes,
      price_xaf = excluded.price_xaf,
      sort_order = excluded.sort_order,
      active = true;

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

-- Check: one business, 4 services, 11 opening ranges
select b.name,
       (select count(*) from public.services s where s.business_id = b.id) as services,
       (select count(*) from public.opening_hours h where h.business_id = b.id) as opening_ranges
from public.businesses b
where b.phone_number_id = '1392005827320537';
