-- Rendo M1: core booking schema.
--
-- Pilot rules (decided Oct 2026):
--   * one WhatsApp number = one business; a business serves ONE client at a time
--     (to support several staff later, the overlap constraint moves from business_id to a staff_id)
--   * slots of 30 min, 10 min buffer after each appointment, bookable up to 10 days ahead,
--     at least 120 min in advance; all of these are per-business settings
--   * times are stored as timestamptz (UTC); opening hours are LOCAL times in businesses.timezone
--   * no medical information is stored anywhere: only the service label chosen by the business
--
-- Security: every table has Row Level Security ON and NO policies, and anon/authenticated lose all
-- privileges, so the public API can neither read nor write. Only Edge Functions (secret key) can.

create extension if not exists btree_gist with schema extensions;

-- Keeps updated_at current. Empty search_path: the function cannot be hijacked by objects in other schemas.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- businesses
-- ---------------------------------------------------------------------------
create table public.businesses (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null check (char_length(btrim(name)) between 2 and 80),
  -- WhatsApp Cloud API phone number id this business answers on (not the phone number itself)
  phone_number_id      text not null unique check (phone_number_id ~ '^[0-9]{5,30}$'),
  -- owner's WhatsApp number, international format without "+" (as WhatsApp sends it), e.g. 237690000000
  owner_whatsapp       text not null check (owner_whatsapp ~ '^[1-9][0-9]{7,14}$'),
  timezone             text not null default 'Africa/Douala' check (timezone ~ '^[A-Za-z_]+(/[A-Za-z_]+)+$'),
  default_language     text not null default 'fr' check (default_language in ('fr', 'en')),
  slot_minutes         smallint not null default 30  check (slot_minutes between 5 and 240),
  buffer_minutes       smallint not null default 10  check (buffer_minutes between 0 and 120),
  booking_horizon_days smallint not null default 10  check (booking_horizon_days between 1 and 60),
  min_notice_minutes   smallint not null default 120 check (min_notice_minutes between 0 and 2880),
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger businesses_set_updated_at before update on public.businesses
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- services offered by a business (shown as a WhatsApp list: row titles max 24 characters)
-- ---------------------------------------------------------------------------
create table public.services (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete cascade,
  name             text not null check (char_length(btrim(name)) between 2 and 24),
  duration_minutes smallint not null check (duration_minutes between 5 and 480),
  price_xaf        integer check (price_xaf >= 0),
  active           boolean not null default true,
  sort_order       smallint not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (business_id, name),
  unique (business_id, id) -- target of the composite foreign key in appointments
);
create trigger services_set_updated_at before update on public.services
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- weekly opening hours, local time; several ranges per day allowed (e.g. 08:00-12:00 and 14:00-18:00)
-- ---------------------------------------------------------------------------
create table public.opening_hours (
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  weekday     smallint not null check (weekday between 1 and 7), -- ISO 8601: 1 = Monday ... 7 = Sunday
  opens_at    time not null,
  closes_at   time not null,
  check (closes_at > opens_at),
  -- ranges of the same day must not overlap (a fixed date turns times into comparable ranges)
  constraint opening_hours_no_overlap exclude using gist (
    business_id with =,
    weekday with =,
    tsrange(date '2000-01-01' + opens_at, date '2000-01-01' + closes_at, '[)') with &&
  )
);

-- ---------------------------------------------------------------------------
-- exceptional closures (public holiday, owner travelling, ...)
-- ---------------------------------------------------------------------------
create table public.closures (
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text check (char_length(reason) <= 100),
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index closures_business_time_idx on public.closures (business_id, starts_at);

-- ---------------------------------------------------------------------------
-- clients of a business, identified by WhatsApp user id and/or phone number
-- (since 2026 WhatsApp may hide the phone number of username users; user_id is then the only key)
-- ---------------------------------------------------------------------------
create table public.clients (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  wa_user_id   text check (char_length(wa_user_id) between 1 and 128),
  phone        text check (phone ~ '^[1-9][0-9]{7,14}$'),
  display_name text check (char_length(display_name) <= 60),
  language     text not null default 'fr' check (language in ('fr', 'en')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (wa_user_id is not null or phone is not null),
  unique (business_id, wa_user_id),
  unique (business_id, phone),
  unique (business_id, id) -- target of the composite foreign key in appointments
);
create trigger clients_set_updated_at before update on public.clients
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------
create table public.appointments (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses (id) on delete restrict,
  client_id     uuid not null,
  service_id    uuid not null,
  booking_code  text not null check (booking_code ~ '^R[0-9]{4}$'),
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  -- end of the appointment + the business's buffer at booking time; the slot stays blocked until then
  blocked_until timestamptz not null,
  status        text not null default 'confirmed'
                check (status in ('confirmed', 'cancelled', 'completed', 'no_show')),
  cancelled_at  timestamptz,
  cancelled_by  text check (cancelled_by in ('client', 'owner', 'system')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (ends_at > starts_at),
  check (blocked_until >= ends_at),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((cancelled_at is null) = (cancelled_by is null)),
  -- the client and the service must belong to the SAME business as the appointment
  foreign key (business_id, client_id) references public.clients (business_id, id) on delete restrict,
  foreign key (business_id, service_id) references public.services (business_id, id) on delete restrict,
  -- THE rule: one business never has two active appointments whose blocked times overlap.
  -- Two bookings for the same slot: one succeeds, the other fails with SQLSTATE 23P01 (exclusion_violation),
  -- or 40P01 (deadlock_detected) when both insert at the very same instant. Booking code must treat
  -- both as "slot just taken" (verified locally with two concurrent sessions, Oct 2026).
  constraint appointments_no_overlap exclude using gist (
    business_id with =,
    tstzrange(starts_at, blocked_until, '[)') with &&
  ) where (status <> 'cancelled')
);
create trigger appointments_set_updated_at before update on public.appointments
  for each row execute function public.set_updated_at();

-- A booking code identifies an upcoming appointment (the owner types "CANCEL R4821").
-- Unique only among confirmed appointments, so codes can be reused once an appointment is over.
create unique index appointments_active_code_uq
  on public.appointments (business_id, booking_code) where (status = 'confirmed');
create index appointments_client_idx on public.appointments (client_id, starts_at);
create index appointments_service_idx on public.appointments (service_id);

-- ---------------------------------------------------------------------------
-- lock everything down: no access through the public API
-- ---------------------------------------------------------------------------
alter table public.businesses    enable row level security;
alter table public.services      enable row level security;
alter table public.opening_hours enable row level security;
alter table public.closures      enable row level security;
alter table public.clients       enable row level security;
alter table public.appointments  enable row level security;

revoke all on table
  public.businesses, public.services, public.opening_hours,
  public.closures, public.clients, public.appointments
from anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;

comment on table public.appointments is
  'Bookings. appointments_no_overlap guarantees no double booking per business. No medical data.';
comment on table public.clients is
  'WhatsApp clients per business. Personal data: see the retention rules in web/privacy.html.';
