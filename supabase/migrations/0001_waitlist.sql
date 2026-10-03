-- Waitlist for the Rendo landing page.
-- Row Level Security: the public can only INSERT a signup; nobody can read the list from the web.
create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  full_name text not null,
  business_name text,
  whatsapp text not null,
  city text,
  business_type text
);

alter table public.waitlist enable row level security;

grant insert on table public.waitlist to anon;

create policy "public can join"
  on public.waitlist
  for insert
  to anon
  with check (true);
