-- Rendo M3.6: checks for migration 0010 (questions without active answers, 3 questions / 10 answers limits).
-- Run the WHOLE file in Supabase -> SQL Editor. It ends with ROLLBACK, so it leaves no data behind.
-- Expected last line: ALL M3.6 CHOICE RULES TESTS PASSED.

begin;

insert into public.businesses (id, name, phone_number_id, owner_whatsapp, chairs)
values ('00000000-0000-0000-0000-00000000ba01', 'Salon Test R', '900000000000031', '237690000041', 1);
insert into public.services (id, business_id, category, name, duration_minutes, price_xaf, price_mode)
values ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000ba01', 'Tresses', 'Knotless', 240, 15000, 'from');
insert into public.service_choice_groups (id, business_id, service_id, name, sort_order)
values ('00000000-0000-0000-0000-00000000bc01', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bb01', 'Taille', 1),
       ('00000000-0000-0000-0000-00000000bc02', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bb01', 'Longueur', 2);
insert into public.service_choices (id, business_id, group_id, name, price_add_xaf, duration_add_minutes)
values ('00000000-0000-0000-0000-00000000bd01', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bc01', 'Medium', 5000, 60),
       ('00000000-0000-0000-0000-00000000bd02', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bc02', 'Dos', 3000, 60);
insert into public.clients (id, business_id, phone)
values ('00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000ba01', '237690000042');

do $$
declare
  biz  constant uuid := '00000000-0000-0000-0000-00000000ba01';
  knot constant uuid := '00000000-0000-0000-0000-00000000bb01';
  taille constant uuid := '00000000-0000-0000-0000-00000000bc01';
  medium constant uuid := '00000000-0000-0000-0000-00000000bd01';
  dos constant uuid := '00000000-0000-0000-0000-00000000bd02';
  cli constant uuid := '00000000-0000-0000-0000-00000000be01';
  t0 timestamptz := date_trunc('hour', now()) + interval '2 days';
  r jsonb;
begin
  -- R1. every question with an active answer must still be answered
  r := public.rendo_book_appointment(biz, cli, knot, t0, array[medium]);
  if r->>'reason' is distinct from 'choices_invalid' then raise exception 'R1 FAILED: %', r; end if;

  -- R2. all answers of 'Longueur' switched off -> the question is skipped, booking works without it
  update public.service_choices set active = false where id = dos;
  r := public.rendo_book_appointment(biz, cli, knot, t0, array[medium]);
  if r->>'status' <> 'booked' or (r->>'estimate_xaf')::int <> 20000 then raise exception 'R2 FAILED: %', r; end if;
  -- ... and the switched-off answer itself is refused
  r := public.rendo_book_appointment(biz, cli, knot, t0 + interval '1 day', array[medium, dos]);
  if r->>'reason' is distinct from 'choices_invalid' then raise exception 'R2 FAILED (inactive answer): %', r; end if;

  -- R3. at most 3 questions per style
  insert into public.service_choice_groups (business_id, service_id, name) values (biz, knot, 'Mèches');
  begin
    insert into public.service_choice_groups (business_id, service_id, name) values (biz, knot, 'Couleur');
    raise exception 'R3 FAILED: a 4th question was accepted';
  exception when check_violation then null;
  end;

  -- R4. at most 10 ACTIVE answers per question (switched-off ones don't count)
  insert into public.service_choices (business_id, group_id, name)
  select biz, taille, 'Taille ' || i from generate_series(2, 10) as i;   -- 'Medium' + 9 = 10 active
  begin
    insert into public.service_choices (business_id, group_id, name) values (biz, taille, 'Taille 11');
    raise exception 'R4 FAILED: an 11th active answer was accepted';
  exception when check_violation then null;
  end;
  insert into public.service_choices (business_id, group_id, name, active) values (biz, taille, 'Ancienne', false);
  begin
    update public.service_choices set active = true where group_id = taille and name = 'Ancienne';
    raise exception 'R4 FAILED: switching on an 11th answer was accepted';
  exception when check_violation then null;
  end;
  update public.service_choices set active = false where id = medium;
  update public.service_choices set active = true where group_id = taille and name = 'Ancienne';  -- back to 10: allowed

  -- R5. privileges unchanged: only service_role may book
  if has_function_privilege('anon', 'public.rendo_book_appointment(uuid, uuid, uuid, timestamptz, uuid[])', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rendo_book_appointment(uuid, uuid, uuid, timestamptz, uuid[])', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.rendo_book_appointment(uuid, uuid, uuid, timestamptz, uuid[])', 'EXECUTE') then
    raise exception 'R5 FAILED: privileges';
  end if;
end $$;

select 'ALL M3.6 CHOICE RULES TESTS PASSED' as result;

rollback;
