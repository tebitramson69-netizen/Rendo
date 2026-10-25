-- Rendo M3.6: checks for migration 0009 (chairs, style choices, prices saved on the booking).
-- Run the WHOLE file in Supabase -> SQL Editor. It ends with ROLLBACK, so it leaves no data behind.
-- Expected last line: ALL M3.6 CHAIRS AND CHOICES TESTS PASSED.

begin;

insert into public.businesses (id, name, phone_number_id, owner_whatsapp, buffer_minutes, chairs)
values ('00000000-0000-0000-0000-00000000aa01', 'Salon Test L', '900000000000021', '237690000021', 10, 2),
       ('00000000-0000-0000-0000-00000000aa02', 'Salon Test M', '900000000000022', '237690000022', 10, 1);

-- style "Knotless": base 15 000, 4 h; groups Taille (Jumbo +0 / Medium +5000 +60 min) and Mèches (Vos mèches +0 / Du salon +4000)
insert into public.services (id, business_id, category, name, duration_minutes, price_xaf, price_mode, aliases)
values ('00000000-0000-0000-0000-00000000ab01', '00000000-0000-0000-0000-00000000aa01', 'Tresses', 'Knotless', 240, 15000, 'from',
        array['knotless', 'sans noeuds']),
       ('00000000-0000-0000-0000-00000000ab02', '00000000-0000-0000-0000-00000000aa01', '', 'Coupe', 30, 3000, 'fixed', '{}'),
       ('00000000-0000-0000-0000-00000000ab03', '00000000-0000-0000-0000-00000000aa02', '', 'Coupe', 30, 3000, 'fixed', '{}');
insert into public.service_choice_groups (id, business_id, service_id, name, sort_order)
values ('00000000-0000-0000-0000-00000000ac01', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000ab01', 'Taille', 1),
       ('00000000-0000-0000-0000-00000000ac02', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000ab01', 'Mèches', 2);
insert into public.service_choices (id, business_id, group_id, name, price_add_xaf, duration_add_minutes, active)
values ('00000000-0000-0000-0000-00000000ad01', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000ac01', 'Jumbo', 0, 0, true),
       ('00000000-0000-0000-0000-00000000ad02', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000ac01', 'Medium', 5000, 60, true),
       ('00000000-0000-0000-0000-00000000ad03', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000ac02', 'Vos mèches', 0, 0, true),
       ('00000000-0000-0000-0000-00000000ad04', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000ac02', 'Du salon', 4000, 0, true),
       ('00000000-0000-0000-0000-00000000ad05', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000ac02', 'Ancienne', 1000, 0, false);
insert into public.clients (id, business_id, phone)
values ('00000000-0000-0000-0000-00000000ae01', '00000000-0000-0000-0000-00000000aa01', '237690000031'),
       ('00000000-0000-0000-0000-00000000ae02', '00000000-0000-0000-0000-00000000aa01', '237690000032'),
       ('00000000-0000-0000-0000-00000000ae03', '00000000-0000-0000-0000-00000000aa01', '237690000033'),
       ('00000000-0000-0000-0000-00000000ae04', '00000000-0000-0000-0000-00000000aa02', '237690000034'),
       ('00000000-0000-0000-0000-00000000ae05', '00000000-0000-0000-0000-00000000aa02', '237690000035');

do $$
declare
  biz  constant uuid := '00000000-0000-0000-0000-00000000aa01';
  knot constant uuid := '00000000-0000-0000-0000-00000000ab01';
  coupe constant uuid := '00000000-0000-0000-0000-00000000ab02';
  jumbo constant uuid := '00000000-0000-0000-0000-00000000ad01';
  medium constant uuid := '00000000-0000-0000-0000-00000000ad02';
  vos constant uuid := '00000000-0000-0000-0000-00000000ad03';
  salon constant uuid := '00000000-0000-0000-0000-00000000ad04';
  ancienne constant uuid := '00000000-0000-0000-0000-00000000ad05';
  t0 timestamptz := date_trunc('hour', now()) + interval '2 days';
  r jsonb; a public.appointments;
begin
  -- C1. estimate = base + additions, duration = base + additions, options saved on the booking
  r := public.rendo_book_appointment(biz, '00000000-0000-0000-0000-00000000ae01', knot, t0, array[medium, salon]);
  if r->>'status' <> 'booked' or (r->>'estimate_xaf')::int <> 24000 or (r->>'duration_minutes')::int <> 300
     or r->>'price_mode' <> 'from' or (r->>'chair')::int <> 1 then
    raise exception 'C1 FAILED: %', r;
  end if;
  select * into a from public.appointments where id = (r->>'appointment_id')::uuid;
  if a.ends_at <> t0 + interval '5 hours' or a.blocked_until <> t0 + interval '5 hours 10 minutes'
     or a.estimate_xaf <> 24000 or a.agreed_price_xaf is not null
     or jsonb_array_length(a.choices) <> 2 or a.choices->0->>'choice' <> 'Medium' or a.choices->1->>'choice' <> 'Du salon' then
    raise exception 'C1 FAILED: stored %', row_to_json(a);
  end if;

  -- C2. same time, second client -> chair 2 (the salon has 2 chairs)
  r := public.rendo_book_appointment(biz, '00000000-0000-0000-0000-00000000ae02', coupe, t0 + interval '1 hour');
  if r->>'status' <> 'booked' or (r->>'chair')::int <> 2 then raise exception 'C2 FAILED: %', r; end if;

  -- C3. third client at an overlapping time -> both chairs busy -> slot_taken
  r := public.rendo_book_appointment(biz, '00000000-0000-0000-0000-00000000ae03', coupe, t0 + interval '1 hour');
  if r->>'status' <> 'slot_taken' then raise exception 'C3 FAILED: %', r; end if;

  -- C4. chair 2 frees up after the haircut + buffer -> booked again on chair 2
  r := public.rendo_book_appointment(biz, '00000000-0000-0000-0000-00000000ae03', coupe, t0 + interval '1 hour 40 minutes');
  if r->>'status' <> 'booked' or (r->>'chair')::int <> 2 then raise exception 'C4 FAILED: %', r; end if;

  -- C5. a one-chair salon behaves exactly as before
  r := public.rendo_book_appointment('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000ae04',
                                     '00000000-0000-0000-0000-00000000ab03', t0);
  if r->>'status' <> 'booked' then raise exception 'C5 FAILED: %', r; end if;
  r := public.rendo_book_appointment('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000ae05',
                                     '00000000-0000-0000-0000-00000000ab03', t0 + interval '15 minutes');
  if r->>'status' <> 'slot_taken' then raise exception 'C5 FAILED: second booking %', r; end if;

  -- C6. invalid choices are refused: missing group, two in one group, inactive, duplicate, foreign, none at all
  r := public.rendo_book_appointment(biz, '00000000-0000-0000-0000-00000000ae03', knot, t0 + interval '1 day', array[medium]);
  if r->>'reason' is distinct from 'choices_invalid' then raise exception 'C6 FAILED (missing group): %', r; end if;
  r := public.rendo_book_appointment(biz, '00000000-0000-0000-0000-00000000ae03', knot, t0 + interval '1 day', array[jumbo, medium, vos]);
  if r->>'reason' is distinct from 'choices_invalid' then raise exception 'C6 FAILED (same group twice): %', r; end if;
  r := public.rendo_book_appointment(biz, '00000000-0000-0000-0000-00000000ae03', knot, t0 + interval '1 day', array[jumbo, ancienne]);
  if r->>'reason' is distinct from 'choices_invalid' then raise exception 'C6 FAILED (inactive): %', r; end if;
  r := public.rendo_book_appointment(biz, '00000000-0000-0000-0000-00000000ae03', knot, t0 + interval '1 day', array[jumbo, vos, vos]);
  if r->>'reason' is distinct from 'choices_invalid' then raise exception 'C6 FAILED (duplicate): %', r; end if;
  r := public.rendo_book_appointment(biz, '00000000-0000-0000-0000-00000000ae03', coupe, t0 + interval '1 day', array[jumbo]);
  if r->>'reason' is distinct from 'choices_invalid' then raise exception 'C6 FAILED (choice of another style): %', r; end if;
  r := public.rendo_book_appointment(biz, '00000000-0000-0000-0000-00000000ae03', knot, t0 + interval '1 day');
  if r->>'reason' is distinct from 'choices_invalid' then raise exception 'C6 FAILED (no choice for a style with groups): %', r; end if;

  -- C7. the old 4-argument call (the bot deployed before this migration) still books a style without choices
  r := public.rendo_book_appointment(biz, '00000000-0000-0000-0000-00000000ae03', coupe, t0 + interval '3 days');
  if r->>'status' <> 'booked' or (r->>'estimate_xaf')::int <> 3000 then raise exception 'C7 FAILED: %', r; end if;

  -- C8. a negative addition never makes the estimate negative; on_site has no estimate
  update public.service_choices set price_add_xaf = -20000 where id = jumbo;
  r := public.rendo_book_appointment(biz, '00000000-0000-0000-0000-00000000ae03', knot, t0 + interval '4 days', array[jumbo, vos]);
  if (r->>'estimate_xaf')::int <> 0 then raise exception 'C8 FAILED: %', r; end if;
  update public.services set price_mode = 'on_site', price_xaf = null where id = knot;
  r := public.rendo_book_appointment(biz, '00000000-0000-0000-0000-00000000ae03', knot, t0 + interval '5 days', array[jumbo, vos]);
  if r->>'estimate_xaf' is not null then raise exception 'C8 FAILED (on_site): %', r; end if;

  -- C9. limits and isolation
  begin
    insert into public.service_choices (business_id, group_id, name) values (biz, '00000000-0000-0000-0000-00000000ac01', repeat('x', 21));
    raise exception 'C9 FAILED: choice name longer than 20 accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.service_choices (business_id, group_id, name)
    values ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000ac01', 'Autre');
    raise exception 'C9 FAILED: choice attached to another business''s group';
  exception when foreign_key_violation then null;
  end;
  begin
    update public.businesses set chairs = 0 where id = biz;
    raise exception 'C9 FAILED: 0 chairs accepted';
  exception when check_violation then null;
  end;

  -- C10. new tables closed to the public API; only service_role may call the function
  if has_table_privilege('anon', 'public.service_choice_groups', 'SELECT')
     or has_table_privilege('anon', 'public.service_choices', 'SELECT')
     or not (select relrowsecurity from pg_class where oid = 'public.service_choices'::regclass)
     or has_function_privilege('anon', 'public.rendo_book_appointment(uuid, uuid, uuid, timestamptz, uuid[])', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rendo_book_appointment(uuid, uuid, uuid, timestamptz, uuid[])', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.rendo_book_appointment(uuid, uuid, uuid, timestamptz, uuid[])', 'EXECUTE') then
    raise exception 'C10 FAILED: privileges';
  end if;
end $$;

select 'ALL M3.6 CHAIRS AND CHOICES TESTS PASSED' as result;

rollback;
