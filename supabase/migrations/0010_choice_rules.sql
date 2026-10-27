-- Rendo M3.6 fix: keep the database and the bot in agreement about which questions a style has.
--
-- Found while testing the new conversation (before any style with questions was used in production):
-- 1. A question whose answers are ALL switched off (e.g. the owner stops offering every "Longueur")
--    cannot be answered. The bot skips it, but rendo_book_appointment still required an answer,
--    so every booking of that style failed. Now the function only counts questions that have at
--    least one active answer.
-- 2. The bot asks at most 3 questions per style (a WhatsApp tap id carries at most 3 answers) and
--    shows at most 10 answers per question (a WhatsApp list has 10 rows). These limits are now
--    enforced by the database, so a catalogue the bot can't fully show can't be saved.
--
-- Same function name and parameters as 0009: the deployed bot keeps working unchanged.

-- ---------------------------------------------------------------------------
-- 1. limits: max 3 questions per style, max 10 active answers per question
-- ---------------------------------------------------------------------------
create function public.rendo_check_choice_group_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- lock the style so two inserts at the same time can't both pass the count
  perform 1 from public.services s where s.id = new.service_id for update;
  if (select count(*) from public.service_choice_groups g
       where g.service_id = new.service_id and g.id <> new.id) >= 3 then
    raise exception 'a style can have at most 3 questions (service %)', new.service_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger service_choice_groups_limit before insert or update of service_id on public.service_choice_groups
  for each row execute function public.rendo_check_choice_group_limit();

create function public.rendo_check_choice_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not new.active then
    return new;
  end if;
  perform 1 from public.service_choice_groups g where g.id = new.group_id for update;
  if (select count(*) from public.service_choices c
       where c.group_id = new.group_id and c.active and c.id <> new.id) >= 10 then
    raise exception 'a question can have at most 10 active answers (group %)', new.group_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger service_choices_limit before insert or update of active, group_id on public.service_choices
  for each row execute function public.rendo_check_choice_limit();

revoke all on function public.rendo_check_choice_group_limit(), public.rendo_check_choice_limit()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. booking function: only questions with at least one active answer must be answered
-- ---------------------------------------------------------------------------
create or replace function public.rendo_book_appointment(
  p_business_id uuid,
  p_client_id   uuid,
  p_service_id  uuid,
  p_starts_at   timestamptz,
  p_choice_ids  uuid[] default '{}'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_chairs      smallint;
  v_buffer      smallint;
  v_duration    integer;
  v_price       integer;
  v_mode        text;
  v_groups      integer;
  v_found       integer;
  v_found_grps  integer;
  v_price_add   integer;
  v_dur_add     integer;
  v_snapshot    jsonb;
  v_estimate    integer;
  v_ends_at     timestamptz;
  v_code        text;
  v_id          uuid;
  v_constraint  text;
  v_wanted      uuid[] := coalesce(p_choice_ids, '{}');
begin
  select b.chairs, b.buffer_minutes into v_chairs, v_buffer
    from public.businesses b where b.id = p_business_id and b.active;
  if not found then
    return jsonb_build_object('status', 'invalid', 'reason', 'business_inactive');
  end if;

  select s.duration_minutes, s.price_xaf, s.price_mode into v_duration, v_price, v_mode
    from public.services s where s.id = p_service_id and s.business_id = p_business_id and s.active;
  if not found then
    return jsonb_build_object('status', 'invalid', 'reason', 'service_unavailable');
  end if;

  if p_starts_at is null or p_starts_at <= now() then
    return jsonb_build_object('status', 'invalid', 'reason', 'starts_in_past');
  end if;

  -- Choices: exactly one active choice for every group of this style that has an active choice,
  -- nothing else.
  select count(*) into v_groups from public.service_choice_groups g
   where g.service_id = p_service_id
     and exists (select 1 from public.service_choices c where c.group_id = g.id and c.active);
  select count(*), count(distinct c.group_id),
         coalesce(sum(c.price_add_xaf), 0), coalesce(sum(c.duration_add_minutes), 0),
         coalesce(jsonb_agg(jsonb_build_object(
           'group', g.name, 'group_en', g.name_en, 'choice', c.name, 'choice_en', c.name_en,
           'price_add', c.price_add_xaf, 'duration_add', c.duration_add_minutes) order by g.sort_order, g.name), '[]'::jsonb)
    into v_found, v_found_grps, v_price_add, v_dur_add, v_snapshot
    from public.service_choices c
    join public.service_choice_groups g on g.id = c.group_id
   where c.id = any(v_wanted) and c.active and g.service_id = p_service_id;
  if v_found <> cardinality(v_wanted)                       -- unknown, inactive, duplicate or foreign choice
     or v_found_grps <> v_found                             -- two choices in the same group
     or v_found <> v_groups then                            -- a group left unanswered
    return jsonb_build_object('status', 'invalid', 'reason', 'choices_invalid');
  end if;

  v_duration := v_duration + v_dur_add;
  if v_duration < 5 then
    return jsonb_build_object('status', 'invalid', 'reason', 'choices_invalid');
  end if;
  v_estimate := case when v_price is null or v_mode = 'on_site' then null
                     else greatest(v_price + v_price_add, 0) end;
  v_ends_at := p_starts_at + make_interval(mins => v_duration);

  -- First free chair. Two clients choosing the same time: the database decides per chair
  -- (23P01 exclusion_violation / 40P01 deadlock_detected = this chair was just taken -> next chair).
  <<chairs>>
  for v_chair in 1..v_chairs loop
    for attempt in 1..20 loop
      v_code := 'R' || lpad(floor(random() * 10000)::int::text, 4, '0');
      begin
        insert into public.appointments
          (business_id, client_id, service_id, booking_code, starts_at, ends_at, blocked_until, chair,
           estimate_xaf, price_mode, choices)
        values
          (p_business_id, p_client_id, p_service_id, v_code, p_starts_at, v_ends_at,
           v_ends_at + make_interval(mins => v_buffer), v_chair, v_estimate, v_mode, v_snapshot)
        returning id into v_id;

        return jsonb_build_object(
          'status', 'booked', 'appointment_id', v_id, 'booking_code', v_code,
          'starts_at', p_starts_at, 'ends_at', v_ends_at, 'chair', v_chair,
          'duration_minutes', v_duration, 'estimate_xaf', v_estimate, 'price_mode', v_mode);
      exception
        when exclusion_violation or deadlock_detected then
          continue chairs;
        when unique_violation then
          get stacked diagnostics v_constraint = constraint_name;
          if v_constraint <> 'appointments_active_code_uq' then
            raise;
          end if;
          -- booking code already used by a confirmed appointment: draw another one
        when foreign_key_violation then
          return jsonb_build_object('status', 'invalid', 'reason', 'client_not_in_business');
      end;
    end loop;
    raise exception 'rendo_book_appointment: no free booking code after 20 attempts' using errcode = '54000';
  end loop;

  return jsonb_build_object('status', 'slot_taken');
end;
$$;

revoke all on function public.rendo_book_appointment(uuid, uuid, uuid, timestamptz, uuid[]) from public, anon, authenticated;
grant execute on function public.rendo_book_appointment(uuid, uuid, uuid, timestamptz, uuid[]) to service_role;
