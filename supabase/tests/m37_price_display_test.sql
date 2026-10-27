-- Rendo M3.7: checks for migration 0011 (businesses.price_display).
-- Run the WHOLE file in Supabase -> SQL Editor. It ends with ROLLBACK, so it leaves no data behind.
-- Expected last line: ALL M3.7 PRICE DISPLAY TESTS PASSED.

begin;

insert into public.businesses (id, name, phone_number_id, owner_whatsapp)
values ('00000000-0000-0000-0000-00000000ca01', 'Salon Test P', '900000000000041', '237690000051');

do $$
declare v text;
begin
  -- P1. a new salon gets 'on_request' (prices only when the client asks, and in the summary)
  select price_display into v from public.businesses where id = '00000000-0000-0000-0000-00000000ca01';
  if v is distinct from 'on_request' then raise exception 'P1 FAILED: default is %', v; end if;

  -- P2. the three allowed values
  update public.businesses set price_display = 'always' where id = '00000000-0000-0000-0000-00000000ca01';
  update public.businesses set price_display = 'never' where id = '00000000-0000-0000-0000-00000000ca01';

  -- P3. anything else is refused, and so is null
  begin
    update public.businesses set price_display = 'sometimes' where id = '00000000-0000-0000-0000-00000000ca01';
    raise exception 'P3 FAILED: unknown value accepted';
  exception when check_violation then null;
  end;
  begin
    update public.businesses set price_display = null where id = '00000000-0000-0000-0000-00000000ca01';
    raise exception 'P3 FAILED: null accepted';
  exception when not_null_violation then null;
  end;

  -- P4. every existing salon has a valid value (the column was added with a default)
  if exists (select 1 from public.businesses where price_display not in ('on_request', 'always', 'never')) then
    raise exception 'P4 FAILED: invalid value on an existing salon';
  end if;
end $$;

select 'ALL M3.7 PRICE DISPLAY TESTS PASSED' as result;

rollback;
