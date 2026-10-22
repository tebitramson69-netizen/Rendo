-- Rendo M3: two database functions the booking bot calls (through supabase-js .rpc()).
--
-- Why functions instead of plain inserts from TypeScript:
--   * find-or-create a client needs several statements and must survive two messages arriving at once;
--   * a booking must compute its end time, generate a free booking code and turn a double-booking
--     error into a clear answer, all in ONE transaction.
--
-- Security: SECURITY INVOKER (they run with the caller's rights), empty search_path, and EXECUTE is
-- removed from PUBLIC/anon/authenticated: only the Edge Functions' secret key (service_role) can call them.

-- ---------------------------------------------------------------------------
-- Find the client by WhatsApp user id or phone number, create it if needed, fill in missing ids.
-- ---------------------------------------------------------------------------
create or replace function public.rendo_upsert_client(
  p_business_id  uuid,
  p_wa_user_id   text,
  p_phone        text,
  p_display_name text
)
returns public.clients
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_client public.clients;
  v_name   text := nullif(left(btrim(coalesce(p_display_name, '')), 60), '');
begin
  if p_wa_user_id is null and p_phone is null then
    raise exception 'rendo_upsert_client: wa_user_id or phone is required' using errcode = '22023';
  end if;

  for attempt in 1..3 loop
    -- 1) existing client? The user id is the stable key; the phone number may be hidden or change.
    select * into v_client from public.clients c
     where c.business_id = p_business_id
       and ((p_wa_user_id is not null and c.wa_user_id = p_wa_user_id)
         or (p_phone is not null and c.phone = p_phone))
     order by (p_wa_user_id is not null and c.wa_user_id = p_wa_user_id) desc
     limit 1
     for update;

    if found then
      -- fill in what we did not know yet, without stealing an id that belongs to another client row
      update public.clients c set
        wa_user_id   = coalesce(c.wa_user_id, case when not exists (
                         select 1 from public.clients o where o.business_id = p_business_id
                            and o.wa_user_id = p_wa_user_id) then p_wa_user_id end),
        phone        = coalesce(c.phone, case when not exists (
                         select 1 from public.clients o where o.business_id = p_business_id
                            and o.phone = p_phone) then p_phone end),
        display_name = coalesce(v_name, c.display_name)
       where c.id = v_client.id
      returning * into v_client;
      return v_client;
    end if;

    -- 2) new client. If another message from the same person created it a moment ago, loop and find it.
    begin
      insert into public.clients (business_id, wa_user_id, phone, display_name)
      values (p_business_id, p_wa_user_id, p_phone, v_name)
      returning * into v_client;
      return v_client;
    exception when unique_violation then
      null; -- retry the lookup
    end;
  end loop;

  raise exception 'rendo_upsert_client: could not find or create the client' using errcode = '40001';
end;
$$;

-- ---------------------------------------------------------------------------
-- Book a slot. Returns a JSON object:
--   {"status":"booked", "appointment_id":..., "booking_code":"R4821", "starts_at":..., "ends_at":...}
--   {"status":"slot_taken"}   another booking got there first (overlap) — offer other times
--   {"status":"invalid", "reason":...}   bad input (inactive service, time in the past, ...)
-- Opening hours / notice are checked by the availability engine before offering the slot; the
-- database guarantees the one rule that must never break: no overlapping active appointments.
-- ---------------------------------------------------------------------------
create or replace function public.rendo_book_appointment(
  p_business_id uuid,
  p_client_id   uuid,
  p_service_id  uuid,
  p_starts_at   timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_duration smallint;
  v_buffer   smallint;
  v_ends_at  timestamptz;
  v_code     text;
  v_id       uuid;
  v_constraint text;
begin
  select b.buffer_minutes into v_buffer
    from public.businesses b where b.id = p_business_id and b.active;
  if not found then
    return jsonb_build_object('status', 'invalid', 'reason', 'business_inactive');
  end if;

  select s.duration_minutes into v_duration
    from public.services s where s.id = p_service_id and s.business_id = p_business_id and s.active;
  if not found then
    return jsonb_build_object('status', 'invalid', 'reason', 'service_unavailable');
  end if;

  if p_starts_at is null or p_starts_at <= now() then
    return jsonb_build_object('status', 'invalid', 'reason', 'starts_in_past');
  end if;

  v_ends_at := p_starts_at + make_interval(mins => v_duration);

  -- Booking codes only need to be unique among CONFIRMED appointments of this business (they are
  -- typed by the owner, who is already identified by their number), so a short random code is fine.
  for attempt in 1..20 loop
    v_code := 'R' || lpad(floor(random() * 10000)::int::text, 4, '0');
    begin
      insert into public.appointments
        (business_id, client_id, service_id, booking_code, starts_at, ends_at, blocked_until)
      values
        (p_business_id, p_client_id, p_service_id, v_code, p_starts_at, v_ends_at,
         v_ends_at + make_interval(mins => v_buffer))
      returning id into v_id;

      return jsonb_build_object(
        'status', 'booked', 'appointment_id', v_id, 'booking_code', v_code,
        'starts_at', p_starts_at, 'ends_at', v_ends_at);
    exception
      when exclusion_violation or deadlock_detected then
        -- two clients chose the same slot: the other one won
        return jsonb_build_object('status', 'slot_taken');
      when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint <> 'appointments_active_code_uq' then
          raise;
        end if;
        -- code already used by another confirmed appointment: draw another one
      when foreign_key_violation then
        return jsonb_build_object('status', 'invalid', 'reason', 'client_not_in_business');
    end;
  end loop;

  raise exception 'rendo_book_appointment: no free booking code after 20 attempts' using errcode = '54000';
end;
$$;

revoke all on function public.rendo_upsert_client(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.rendo_book_appointment(uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.rendo_upsert_client(uuid, text, text, text) to service_role;
grant execute on function public.rendo_book_appointment(uuid, uuid, uuid, timestamptz) to service_role;
