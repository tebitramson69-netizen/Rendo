-- Rendo M1 schema test. Safe to run on the real database: everything happens inside one
-- transaction that is ROLLED BACK at the end, so no test data is left behind.
--
-- Run it in Supabase -> SQL Editor (paste the whole file, click Run).
-- Success = the last result shows 'ALL M1 TESTS PASSED'. Any failure stops with 'TEST FAILED: ...'.

begin;

-- ---------- test data ----------
insert into public.businesses (id, name, phone_number_id, owner_whatsapp)
values ('00000000-0000-0000-0000-0000000000b1', 'Studio Test A', '900000000000001', '237690000001'),
       ('00000000-0000-0000-0000-0000000000b2', 'Studio Test B', '900000000000002', '237690000002');

insert into public.services (id, business_id, name, duration_minutes, price_xaf)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Coupe', 30, 5000),
       ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', 'Coupe', 30, 5000);

insert into public.clients (id, business_id, wa_user_id, phone, display_name)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'BSUID.TEST.1', '237690000010', 'Marie');

-- helper: book for business A, client c1, service s1; times in Douala local (UTC+1)
create function pg_temp.book(p_code text, p_start text, p_minutes int, p_buffer int default 10)
returns uuid language sql as $$
  insert into public.appointments
    (business_id, client_id, service_id, booking_code, starts_at, ends_at, blocked_until)
  values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000a1', p_code,
          (p_start || ' Africa/Douala')::timestamptz,
          (p_start || ' Africa/Douala')::timestamptz + make_interval(mins => p_minutes),
          (p_start || ' Africa/Douala')::timestamptz + make_interval(mins => p_minutes + p_buffer))
  returning id;
$$;

-- ---------- 1. a normal booking works ----------
select pg_temp.book('R0001', '2026-11-02 10:00', 30);  -- 10:00-10:30, blocked until 10:40

-- ---------- 2. overlap inside the buffer is refused ----------
do $$ begin
  perform pg_temp.book('R0002', '2026-11-02 10:30', 30);
  raise exception 'TEST FAILED: booking at 10:30 should overlap the 10:40 buffer';
exception when exclusion_violation then null;
end $$;

-- ---------- 3. a booking starting exactly when the buffer ends is accepted ----------
select pg_temp.book('R0003', '2026-11-02 10:40', 30);

-- ---------- 4. a cancelled appointment frees its slot ----------
update public.appointments
   set status = 'cancelled', cancelled_at = now(), cancelled_by = 'client'
 where booking_code = 'R0001';
select pg_temp.book('R0004', '2026-11-02 10:00', 30);

-- ---------- 5. cancelled needs cancelled_at/by (and vice versa) ----------
do $$ begin
  update public.appointments set status = 'cancelled' where booking_code = 'R0003';
  raise exception 'TEST FAILED: cancelled without cancelled_at was accepted';
exception when check_violation then null;
end $$;

-- ---------- 6. two CONFIRMED appointments cannot share a booking code ----------
do $$ begin
  perform pg_temp.book('R0003', '2026-11-03 09:00', 30);
  raise exception 'TEST FAILED: duplicate active booking code accepted';
exception when unique_violation then null;
end $$;

-- ...but a code can be reused once the old appointment is completed
update public.appointments set status = 'completed' where booking_code = 'R0003';
select pg_temp.book('R0003', '2026-11-03 09:00', 30);

-- ---------- 7. a service from ANOTHER business cannot be used ----------
do $$ begin
  insert into public.appointments
    (business_id, client_id, service_id, booking_code, starts_at, ends_at, blocked_until)
  values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000a2', 'R0009',
          '2026-11-04 09:00+01', '2026-11-04 09:30+01', '2026-11-04 09:40+01');
  raise exception 'TEST FAILED: cross-business service accepted';
exception when foreign_key_violation then null;
end $$;

-- ---------- 8. the same time is fine for a DIFFERENT business ----------
insert into public.clients (id, business_id, phone) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b2', '237690000010');
insert into public.appointments
  (business_id, client_id, service_id, booking_code, starts_at, ends_at, blocked_until)
values ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000c2',
        '00000000-0000-0000-0000-0000000000a2', 'R0004',
        '2026-11-02 10:00+01', '2026-11-02 10:30+01', '2026-11-02 10:40+01');

-- ---------- 9. opening hours: two ranges per day OK, overlapping ranges refused ----------
insert into public.opening_hours (business_id, weekday, opens_at, closes_at) values
  ('00000000-0000-0000-0000-0000000000b1', 1, '08:00', '12:00'),
  ('00000000-0000-0000-0000-0000000000b1', 1, '14:00', '18:00');
do $$ begin
  insert into public.opening_hours (business_id, weekday, opens_at, closes_at)
  values ('00000000-0000-0000-0000-0000000000b1', 1, '11:00', '15:00');
  raise exception 'TEST FAILED: overlapping opening hours accepted';
exception when exclusion_violation then null;
end $$;
do $$ begin
  insert into public.opening_hours (business_id, weekday, opens_at, closes_at)
  values ('00000000-0000-0000-0000-0000000000b1', 2, '18:00', '08:00');
  raise exception 'TEST FAILED: closing before opening accepted';
exception when check_violation then null;
end $$;

-- ---------- 10. input rules ----------
do $$ begin
  insert into public.services (business_id, name, duration_minutes)
  values ('00000000-0000-0000-0000-0000000000b1', 'A very long service name!', 30);  -- 25 chars
  raise exception 'TEST FAILED: service name over 24 characters accepted';
exception when check_violation then null;
end $$;
do $$ begin
  insert into public.clients (business_id) values ('00000000-0000-0000-0000-0000000000b1');
  raise exception 'TEST FAILED: client without user id and phone accepted';
exception when check_violation then null;
end $$;

-- ---------- 11. the public API role cannot touch booking data ----------
set local role anon;
do $$ begin
  perform 1 from public.appointments limit 1;
  raise exception 'TEST FAILED: anon can read appointments';
exception when insufficient_privilege then null;
end $$;

-- ---------- 12. waitlist: valid signup accepted, junk refused ----------
insert into public.waitlist (full_name, whatsapp, city) values ('Test User', '+237 6 90 00 00 00', 'Douala');
do $$ begin
  insert into public.waitlist (full_name, whatsapp) values ('x', '123');
  raise exception 'TEST FAILED: junk waitlist row accepted';
exception when insufficient_privilege or check_violation then null;
end $$;
reset role;

select 'ALL M1 TESTS PASSED' as result;

rollback;
