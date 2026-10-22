-- Rendo M3: checks for migration 0007 (handoff columns).
-- Run the WHOLE file in Supabase -> SQL Editor. It ends with ROLLBACK, so it leaves no data behind.
-- Expected last line: ALL M3 HANDOFF TESTS PASSED.

begin;

do $$
begin
  -- H1. columns exist with the right types
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'businesses' and column_name = 'contact_phone') is distinct from 'text' then
    raise exception 'H1 FAILED: businesses.contact_phone missing';
  end if;
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'conversations' and column_name = 'handoff_requested_at')
     is distinct from 'timestamp with time zone' then
    raise exception 'H1 FAILED: conversations.handoff_requested_at missing';
  end if;

  -- H2. contact_phone is optional and must be digits in international format
  insert into public.businesses (id, name, phone_number_id, owner_whatsapp)
  values ('00000000-0000-0000-0000-0000000000a9', 'Studio Test H', '900000000000009', '237690000009');
  update public.businesses set contact_phone = '237690000019' where id = '00000000-0000-0000-0000-0000000000a9';
  begin
    update public.businesses set contact_phone = '+237 690 00 00 19' where id = '00000000-0000-0000-0000-0000000000a9';
    raise exception 'H2 FAILED: badly formatted contact_phone accepted';
  exception when check_violation then null;
  end;

  -- H3. still invisible to the public API
  if has_column_privilege('anon', 'public.businesses', 'contact_phone', 'SELECT') then
    raise exception 'H3 FAILED: anon can read contact_phone';
  end if;
end $$;

select 'ALL M3 HANDOFF TESTS PASSED' as result;

rollback;
