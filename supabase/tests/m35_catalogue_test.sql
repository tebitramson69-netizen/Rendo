-- Rendo M3.5: checks for migration 0008 (flexible catalogue).
-- Run the WHOLE file in Supabase -> SQL Editor. It ends with ROLLBACK, so it leaves no data behind.
-- Expected last line: ALL M3.5 CATALOGUE TESTS PASSED.

begin;

insert into public.businesses (id, name, phone_number_id, owner_whatsapp)
values ('00000000-0000-0000-0000-0000000000c9', 'Studio Test K', '900000000000019', '237690000019');

do $$
declare biz constant uuid := '00000000-0000-0000-0000-0000000000c9';
begin
  -- K1. defaults: no category, fixed price mode
  insert into public.services (business_id, name, duration_minutes, price_xaf) values (biz, 'Coupe', 30, 3000);
  if (select category || '|' || price_mode from public.services where business_id = biz and name = 'Coupe') <> '|fixed' then
    raise exception 'K1 FAILED: wrong defaults';
  end if;

  -- K2. same variant name in two categories is allowed, twice in one category is not
  insert into public.services (business_id, category, name, duration_minutes, price_xaf, price_mode)
  values (biz, 'Tresses', 'Courtes', 180, 10000, 'fixed'),
         (biz, 'Locks', 'Courtes', 120, 8000, 'from');
  begin
    insert into public.services (business_id, category, name, duration_minutes) values (biz, 'Tresses', 'Courtes', 60);
    raise exception 'K2 FAILED: duplicate variant accepted';
  exception when unique_violation then null;
  end;

  -- K3. "from" needs a price; unknown price mode refused
  begin
    insert into public.services (business_id, name, duration_minutes, price_mode) values (biz, 'Soin', 60, 'from');
    raise exception 'K3 FAILED: from without price accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.services (business_id, name, duration_minutes, price_mode) values (biz, 'Soin', 60, 'free');
    raise exception 'K3 FAILED: unknown price mode accepted';
  exception when check_violation then null;
  end;

  -- K4. on_site works without a price (clinics)
  insert into public.services (business_id, name, duration_minutes, price_mode) values (biz, 'Consultation', 30, 'on_site');

  -- K5. length limits (WhatsApp list titles are 24 characters)
  begin
    insert into public.services (business_id, name, name_en, duration_minutes) values (biz, 'Brushing', repeat('x', 25), 30);
    raise exception 'K5 FAILED: name_en longer than 24 accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.services (business_id, category, name, duration_minutes) values (biz, repeat('c', 25), 'X1', 30);
    raise exception 'K5 FAILED: category longer than 24 accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.services (business_id, name, note, duration_minutes) values (biz, 'Brushing', repeat('n', 151), 30);
    raise exception 'K5 FAILED: note longer than 150 accepted';
  exception when check_violation then null;
  end;

  -- K6. still closed to the public API
  if has_table_privilege('anon', 'public.services', 'SELECT') then
    raise exception 'K6 FAILED: anon can read services';
  end if;
end $$;

select 'ALL M3.5 CATALOGUE TESTS PASSED' as result;

rollback;
