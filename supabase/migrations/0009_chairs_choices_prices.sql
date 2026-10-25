-- Rendo M3.6: what real salons need (decided 25 Oct 2026).
--
-- 1. CHAIRS: a salon serves several clients at the same time (a long knotless takes ~6 h).
--    businesses.chairs = how many clients can be served at once. Each appointment sits on one chair,
--    and the no-overlap rule now applies PER CHAIR, so the database still makes double booking of a
--    chair impossible. The booking function picks the first free chair.
-- 2. STYLE + CHOICES: a style (a services row) has a base price/duration and up to 3 groups of choices
--    (Taille, Longueur, Mèches...). Each choice adds to the price and to the time.
--    Estimate = base price + chosen additions. The client picks exactly one choice per group.
-- 3. PRICES ON THE BOOKING: the estimate, the price mode and the chosen options are saved on the
--    appointment at booking time; agreed_price_xaf is set only when the owner and the client agree
--    on a different price (never by the bot on its own).
-- 4. ALIASES: the words clients actually type for a style ("knotless", "sans noeuds"), used by the
--    bot to understand typed requests.
--
-- Compatible with the bot already deployed: the booking function keeps its name and its first four
-- parameters; the new p_choice_ids parameter is optional.

-- ---------------------------------------------------------------------------
-- 1. chairs
-- ---------------------------------------------------------------------------
alter table public.businesses
  add column chairs smallint not null default 1 check (chairs between 1 and 20);

comment on column public.businesses.chairs is 'How many clients can be served at the same time (chairs / stations).';

alter table public.appointments
  add column chair smallint not null default 1 check (chair between 1 and 20);

-- Same rule as before, but per chair. Existing appointments are all on chair 1 and never overlap.
alter table public.appointments drop constraint appointments_no_overlap;
alter table public.appointments add constraint appointments_no_overlap exclude using gist (
  business_id with =,
  chair with =,
  tstzrange(starts_at, blocked_until, '[)') with &&
) where (status <> 'cancelled');

-- ---------------------------------------------------------------------------
-- 2. style choices
-- ---------------------------------------------------------------------------
alter table public.services
  add column aliases text[] not null default '{}'
    check (cardinality(aliases) <= 20 and char_length(array_to_string(aliases, '|')) <= 600);

comment on column public.services.aliases is 'Words clients type for this style (lowercase, e.g. knotless, sans noeuds).';

create table public.service_choice_groups (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  service_id  uuid not null,
  -- "Taille", "Longueur", "Mèches"
  name        text not null check (char_length(btrim(name)) between 1 and 24),
  name_en     text check (name_en is null or char_length(btrim(name_en)) between 1 and 24),
  sort_order  smallint not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (service_id, name),
  unique (business_id, id),
  foreign key (business_id, service_id) references public.services (business_id, id) on delete cascade
);
create trigger service_choice_groups_set_updated_at before update on public.service_choice_groups
  for each row execute function public.set_updated_at();

create table public.service_choices (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null,
  group_id             uuid not null,
  -- shown on a WhatsApp button: max 20 characters
  name                 text not null check (char_length(btrim(name)) between 1 and 20),
  name_en              text check (name_en is null or char_length(btrim(name_en)) between 1 and 20),
  -- may be negative (e.g. "Jumbo" cheaper than the base); the total is never below 0
  price_add_xaf        integer not null default 0 check (price_add_xaf between -1000000 and 1000000),
  duration_add_minutes smallint not null default 0 check (duration_add_minutes between -480 and 480),
  sort_order           smallint not null default 0,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (group_id, name),
  foreign key (business_id, group_id) references public.service_choice_groups (business_id, id) on delete cascade
);
create trigger service_choices_set_updated_at before update on public.service_choices
  for each row execute function public.set_updated_at();

create index service_choice_groups_service_idx on public.service_choice_groups (service_id);
create index service_choices_group_idx on public.service_choices (group_id);

alter table public.service_choice_groups enable row level security;
alter table public.service_choices enable row level security;
revoke all on table public.service_choice_groups, public.service_choices from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. prices saved on the booking
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column estimate_xaf     integer check (estimate_xaf >= 0),
  add column price_mode       text check (price_mode in ('fixed', 'from', 'on_site')),
  add column agreed_price_xaf integer check (agreed_price_xaf >= 0),
  -- snapshot of the chosen options: [{"group":"Taille","choice":"Medium","price_add":5000,"duration_add":60}]
  add column choices          jsonb not null default '[]'::jsonb
    check (jsonb_typeof(choices) = 'array' and octet_length(choices::text) <= 2000);

-- ---------------------------------------------------------------------------
-- 4. booking function v2 (same name, optional choices, chairs, price snapshot)
-- ---------------------------------------------------------------------------
drop function public.rendo_book_appointment(uuid, uuid, uuid, timestamptz);

create function public.rendo_book_appointment(
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

  -- Choices: exactly one active choice for every group of this style, nothing else.
  select count(*) into v_groups from public.service_choice_groups g where g.service_id = p_service_id;
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
