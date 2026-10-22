-- Rendo M3: "Parler à quelqu'un" (talk to a person).
--
-- With the WhatsApp Cloud API, the owner cannot read or answer the bot's chats from his WhatsApp app
-- (that needs "coexistence", which requires onboarding through a Meta Tech Provider — later).
-- So the handoff works the other way round:
--   1. the bot alerts the owner with an approved template (client name + number),
--   2. the owner contacts the client directly from his own phone,
--   3. the client is told so, and also gets the business's PUBLIC number if one is set.
-- The owner's private alert number (owner_whatsapp) is never shown to clients.

alter table public.businesses
  add column contact_phone text check (contact_phone ~ '^[1-9][0-9]{7,14}$');

comment on column public.businesses.contact_phone is
  'Public number shown to clients who ask for a person (international format, no +). '
  'Optional; owner_whatsapp stays private (alerts only).';

-- When the client last asked for a person: the owner is alerted at most once per period (no spam).
alter table public.conversations
  add column handoff_requested_at timestamptz;
