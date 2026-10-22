-- Rendo M3: where the booking bot remembers each client's place in the conversation.
--
-- One row per client (a client belongs to exactly one business). The webhook loads it, the state
-- machine decides the next step, and the webhook saves it back. Nothing the client types is stored
-- here: `context` only holds ids and choices made with buttons/lists (service id, chosen day, slot).

create table public.conversations (
  client_id       uuid primary key,
  business_id     uuid not null,
  -- current step of the booking flow, e.g. 'idle', 'choosing_service', 'confirming'.
  -- The list of steps lives in the state machine code; the database only checks the format.
  state           text not null default 'idle' check (state ~ '^[a-z_]{1,40}$'),
  -- ids and choices for the current step; kept small on purpose (no free text from clients)
  context         jsonb not null default '{}'::jsonb
                  check (jsonb_typeof(context) = 'object' and octet_length(context::text) <= 4096),
  -- an unfinished flow is forgotten after this moment (the bot starts again from the welcome)
  expires_at      timestamptz,
  -- "talk to a person": the bot stays silent for this client until this moment
  paused_until    timestamptz,
  -- last message received from the client: free-form replies are only allowed by WhatsApp
  -- within 24 h of it; after that only approved templates can be sent
  last_inbound_at timestamptz,
  -- optimistic locking: a save only succeeds if nobody else saved in between
  -- (two quick taps from the same client run in two parallel function calls)
  version         integer not null default 0 check (version >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- the client must belong to the same business; deleting the client deletes the conversation
  foreign key (business_id, client_id) references public.clients (business_id, id) on delete cascade
);

create index conversations_business_idx on public.conversations (business_id);

create trigger conversations_set_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();

-- Only Edge Functions (secret key) may touch it: RLS on, no policies, no grants to the public roles.
alter table public.conversations enable row level security;
revoke all on table public.conversations from anon, authenticated;

comment on table public.conversations is
  'Booking-bot state per client (M3). Holds ids and button/list choices only, never message text.';
