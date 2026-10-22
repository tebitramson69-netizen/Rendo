-- Rendo M3: checks for migration 0005 (conversations).
-- Run the WHOLE file in Supabase -> SQL Editor. It ends with ROLLBACK, so it leaves no data behind.
-- Expected last line: ALL M3 CONVERSATION TESTS PASSED. Any failure stops with an error explaining which check.

begin;

-- two test businesses, one client each (fake ids and numbers)
insert into public.businesses (id, name, phone_number_id, owner_whatsapp)
values ('00000000-0000-0000-0000-0000000000d1', 'Studio Test C', '900000000000003', '237690000003'),
       ('00000000-0000-0000-0000-0000000000d2', 'Studio Test D', '900000000000004', '237690000004');
insert into public.clients (id, business_id, wa_user_id, phone)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 'BSUID.TEST.C', '237690000020'),
       ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d2', 'BSUID.TEST.D', '237690000021');

do $$
declare
  v_state text; v_version int; v_ctx jsonb; n int;
begin
  -- 1. defaults
  insert into public.conversations (client_id, business_id)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1');
  select state, version, context into v_state, v_version, v_ctx
    from public.conversations where client_id = '00000000-0000-0000-0000-0000000000e1';
  if v_state <> 'idle' or v_version <> 0 or v_ctx <> '{}'::jsonb then
    raise exception 'T1 defaults wrong: state=%, version=%, context=%', v_state, v_version, v_ctx;
  end if;

  -- 2. one conversation per client
  begin
    insert into public.conversations (client_id, business_id)
    values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1');
    raise exception 'T2 FAILED: second conversation for the same client was accepted';
  exception when unique_violation then null;
  end;

  -- 3. client of business D cannot be attached to business C
  begin
    insert into public.conversations (client_id, business_id)
    values ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d1');
    raise exception 'T3 FAILED: cross-business conversation was accepted';
  exception when foreign_key_violation then null;
  end;

  -- 4. bad state format
  begin
    update public.conversations set state = 'Choosing Service!' where client_id = '00000000-0000-0000-0000-0000000000e1';
    raise exception 'T4 FAILED: invalid state accepted';
  exception when check_violation then null;
  end;

  -- 5. context must be a JSON object
  begin
    update public.conversations set context = '[1,2]' where client_id = '00000000-0000-0000-0000-0000000000e1';
    raise exception 'T5 FAILED: non-object context accepted';
  exception when check_violation then null;
  end;

  -- 6. context size cap (4 KB)
  begin
    update public.conversations set context = jsonb_build_object('x', repeat('a', 5000))
     where client_id = '00000000-0000-0000-0000-0000000000e1';
    raise exception 'T6 FAILED: oversized context accepted';
  exception when check_violation then null;
  end;

  -- 7. optimistic locking pattern: a save with a stale version changes nothing
  update public.conversations set state = 'choosing_service', version = version + 1
   where client_id = '00000000-0000-0000-0000-0000000000e1' and version = 0;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'T7 FAILED: first save did not apply'; end if;
  update public.conversations set state = 'confirming', version = version + 1
   where client_id = '00000000-0000-0000-0000-0000000000e1' and version = 0; -- stale
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'T7 FAILED: stale save was applied'; end if;

  -- 8. updated_at trigger is installed (inside one transaction now() never changes, so check the trigger itself)
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.conversations'::regclass
                    and tgname = 'conversations_set_updated_at' and not tgisinternal) then
    raise exception 'T8 FAILED: updated_at trigger missing';
  end if;

  -- 9. deleting the client deletes its conversation
  delete from public.clients where id = '00000000-0000-0000-0000-0000000000e1';
  select count(*) into n from public.conversations where client_id = '00000000-0000-0000-0000-0000000000e1';
  if n <> 0 then raise exception 'T9 FAILED: conversation survived client deletion'; end if;

  -- 10. RLS on and no privileges for the public roles
  if not (select relrowsecurity from pg_class where oid = 'public.conversations'::regclass) then
    raise exception 'T10 FAILED: RLS is off';
  end if;
  if has_table_privilege('anon', 'public.conversations', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     or has_table_privilege('authenticated', 'public.conversations', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') then
    raise exception 'T10 FAILED: anon/authenticated still have privileges';
  end if;
end $$;

select 'ALL M3 CONVERSATION TESTS PASSED' as result;

rollback;
