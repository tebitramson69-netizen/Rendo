-- Rendo M3: checks for migration 0006 (rendo_upsert_client, rendo_book_appointment).
-- Run the WHOLE file in Supabase -> SQL Editor. It ends with ROLLBACK, so it leaves no data behind.
-- Expected last line: ALL M3 BOOKING FUNCTION TESTS PASSED. Any failure stops with an error naming the check.

begin;

-- two test businesses (fake ids/numbers); business F has a 10-minute buffer
insert into public.businesses (id, name, phone_number_id, owner_whatsapp, buffer_minutes)
values ('00000000-0000-0000-0000-0000000000f1', 'Studio Test F', '900000000000005', '237690000005', 10),
       ('00000000-0000-0000-0000-0000000000f2', 'Studio Test G', '900000000000006', '237690000006', 10);
insert into public.services (id, business_id, name, duration_minutes)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'Coupe test', 30),
       ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000f2', 'Coupe test', 30),
       ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000f1', 'Ancien service', 30);
update public.services set active = false where id = '00000000-0000-0000-0000-0000000000a3';

do $$
declare
  c1 public.clients; c2 public.clients; c3 public.clients; cg public.clients;
  r jsonb; a public.appointments;
  t0 timestamptz := date_trunc('hour', now()) + interval '2 days';
  biz constant uuid := '00000000-0000-0000-0000-0000000000f1';
  svc constant uuid := '00000000-0000-0000-0000-0000000000a1';
begin
  -- U1. creates a client, name trimmed and capped at 60 characters
  c1 := public.rendo_upsert_client(biz, 'BSUID.TEST.F1', '237690000030', '  ' || repeat('N', 80) || '  ');
  if c1.id is null or c1.wa_user_id <> 'BSUID.TEST.F1' or char_length(c1.display_name) <> 60 then
    raise exception 'U1 FAILED: %', row_to_json(c1);
  end if;

  -- U2. same person again -> same row, no duplicate; new profile name is kept
  c2 := public.rendo_upsert_client(biz, 'BSUID.TEST.F1', '237690000030', 'Marie');
  if c2.id <> c1.id or c2.display_name <> 'Marie' then raise exception 'U2 FAILED: %', row_to_json(c2); end if;

  -- U3. phone-only client later seen with a user id -> the user id is added to the same row
  c3 := public.rendo_upsert_client(biz, null, '237690000031', null);
  c2 := public.rendo_upsert_client(biz, 'BSUID.TEST.F3', '237690000031', null);
  if c2.id <> c3.id or c2.wa_user_id <> 'BSUID.TEST.F3' then raise exception 'U3 FAILED: %', row_to_json(c2); end if;

  -- U4. empty name does not erase a known name
  c2 := public.rendo_upsert_client(biz, 'BSUID.TEST.F1', null, '   ');
  if c2.display_name <> 'Marie' then raise exception 'U4 FAILED: name erased'; end if;

  -- U5. no identifier at all -> error
  begin
    perform public.rendo_upsert_client(biz, null, null, 'X');
    raise exception 'U5 FAILED: accepted a client without id or phone';
  exception when invalid_parameter_value then null;
  end;

  -- U6. same person in another business -> a separate client row
  cg := public.rendo_upsert_client('00000000-0000-0000-0000-0000000000f2', 'BSUID.TEST.F1', '237690000030', 'Marie');
  if cg.id = c1.id then raise exception 'U6 FAILED: client shared between businesses'; end if;

  -- B1. booking works: code format, end = start + 30 min, blocked until end + 10 min buffer
  r := public.rendo_book_appointment(biz, c1.id, svc, t0);
  if r->>'status' <> 'booked' or (r->>'booking_code') !~ '^R[0-9]{4}$' then raise exception 'B1 FAILED: %', r; end if;
  select * into a from public.appointments where id = (r->>'appointment_id')::uuid;
  if a.ends_at <> t0 + interval '30 minutes' or a.blocked_until <> t0 + interval '40 minutes'
     or a.status <> 'confirmed' then
    raise exception 'B1 FAILED: times/status wrong %', row_to_json(a);
  end if;

  -- B2. overlapping booking (inside the buffer) -> slot_taken, not an error
  r := public.rendo_book_appointment(biz, c3.id, svc, t0 + interval '35 minutes');
  if r->>'status' <> 'slot_taken' then raise exception 'B2 FAILED: %', r; end if;

  -- B3. right after the buffer -> booked
  r := public.rendo_book_appointment(biz, c3.id, svc, t0 + interval '40 minutes');
  if r->>'status' <> 'booked' then raise exception 'B3 FAILED: %', r; end if;

  -- B4. time in the past -> invalid
  r := public.rendo_book_appointment(biz, c1.id, svc, now() - interval '1 minute');
  if r->>'reason' is distinct from 'starts_in_past' then raise exception 'B4 FAILED: %', r; end if;

  -- B5. service of another business -> invalid
  r := public.rendo_book_appointment(biz, c1.id, '00000000-0000-0000-0000-0000000000a2', t0 + interval '1 day');
  if r->>'reason' is distinct from 'service_unavailable' then raise exception 'B5 FAILED: %', r; end if;

  -- B6. inactive service -> invalid
  r := public.rendo_book_appointment(biz, c1.id, '00000000-0000-0000-0000-0000000000a3', t0 + interval '1 day');
  if r->>'reason' is distinct from 'service_unavailable' then raise exception 'B6 FAILED: %', r; end if;

  -- B7. client of another business -> invalid (composite foreign key)
  r := public.rendo_book_appointment(biz, cg.id, svc, t0 + interval '1 day');
  if r->>'reason' is distinct from 'client_not_in_business' then raise exception 'B7 FAILED: %', r; end if;

  -- B8. cancelled appointment frees its slot
  update public.appointments set status = 'cancelled', cancelled_at = now(), cancelled_by = 'client'
   where id = a.id;
  r := public.rendo_book_appointment(biz, c1.id, svc, t0);
  if r->>'status' <> 'booked' then raise exception 'B8 FAILED: %', r; end if;

  -- B9. inactive business -> invalid
  update public.businesses set active = false where id = biz;
  r := public.rendo_book_appointment(biz, c1.id, svc, t0 + interval '2 days');
  if r->>'reason' is distinct from 'business_inactive' then raise exception 'B9 FAILED: %', r; end if;

  -- P1. only the secret key (service_role) may call the functions
  if has_function_privilege('anon', 'public.rendo_upsert_client(uuid, text, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rendo_upsert_client(uuid, text, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.rendo_book_appointment(uuid, uuid, uuid, timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rendo_book_appointment(uuid, uuid, uuid, timestamptz)', 'EXECUTE')
  then
    raise exception 'P1 FAILED: anon/authenticated can call the booking functions';
  end if;
  if not has_function_privilege('service_role', 'public.rendo_book_appointment(uuid, uuid, uuid, timestamptz)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.rendo_upsert_client(uuid, text, text, text)', 'EXECUTE') then
    raise exception 'P1 FAILED: service_role cannot call the booking functions';
  end if;
end $$;

select 'ALL M3 BOOKING FUNCTION TESTS PASSED' as result;

rollback;
