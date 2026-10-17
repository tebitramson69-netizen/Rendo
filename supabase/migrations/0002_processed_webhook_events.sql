-- Rendo M0: remember which WhatsApp messages were already handled.
-- Meta retries webhooks and can deliver the same message more than once;
-- the primary key on wamid makes a second insert fail, so the bot never answers twice.

create table public.processed_webhook_events (
  wamid       text primary key,                     -- WhatsApp message id (messages[].id)
  received_at timestamptz not null default now()
);

create index processed_webhook_events_received_at_idx
  on public.processed_webhook_events (received_at); -- for cleaning up old rows later (M4)

-- Only Edge Functions (secret key) may touch this table.
-- RLS on + no policies = the public API can neither read nor write it.
alter table public.processed_webhook_events enable row level security;
revoke all on table public.processed_webhook_events from anon, authenticated;

comment on table public.processed_webhook_events is
  'Ids of WhatsApp messages already processed by whatsapp-webhook (deduplication). No message content is stored.';
