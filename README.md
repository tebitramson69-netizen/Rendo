# Rendo

**WhatsApp booking assistant for clinics, dental offices and beauty studios in Cameroon.**
Rendo answers every client message instantly, books the appointment, and sends a reminder so clients show up.

🔗 Live landing page: https://rendo-cm.netlify.app
📍 Status: pilot in progress (Douala & Yaoundé)

![Rendo landing page](docs/screenshots/rendo-landing-desktop.png)

## The problem
Small clinics and salons in Cameroon take most bookings over WhatsApp. When the owner is busy with a client or the business is closed, messages go unanswered and clients book elsewhere. Booked clients also miss appointments; studies of appointment reminders report missed-appointment reductions of around 40%.

## How it works
```
Client's WhatsApp → Meta WhatsApp Cloud API → Supabase Edge Function (webhook)
                                                    ↓
                                     Supabase Postgres (businesses, appointments)
                                                    ↓
                               pg_cron → reminder messages → Client's WhatsApp
```

## Tech stack
| Layer | Technology |
|---|---|
| Landing page | HTML, CSS, vanilla JavaScript (Netlify) |
| Database | Supabase Postgres with Row Level Security |
| Backend | Supabase Edge Functions (Deno, TypeScript) |
| Messaging | WhatsApp Cloud API (Meta Graph API v25.0) |
| Scheduling | pg_cron + pg_net (planned) |

## Security decisions
- **Row Level Security** on every table. The landing page's Supabase key is a *publishable* key, safe to be public, because RLS only allows inserting a signup, never reading the list.
- **Webhook signature check.** Every request is verified with HMAC-SHA256 (`X-Hub-Signature-256`) using the Meta app secret, with a constant-time comparison.
- **Secrets** live in Supabase's secret store, never in this repository.
- **Privacy.** The webhook logs message types only, never message content. Rendo stores booking details only, never medical information (Cameroon Law No. 2024/017 on personal data protection).

## Project structure
```
web/index.html                                 Landing page + waitlist form
supabase/migrations/0001_waitlist.sql          Waitlist table + RLS policy
supabase/functions/whatsapp-webhook/index.ts   WhatsApp webhook (receive + auto-reply)
supabase/config.toml                           Function settings (JWT off; signature checked in code)
```

## Roadmap
- [x] Market research and positioning
- [x] Landing page and waitlist (live)
- [x] WhatsApp Cloud API test number
- [ ] Webhook auto-reply (in progress)
- [ ] Booking flow with WhatsApp buttons
- [ ] Automatic reminders (pg_cron)
- [ ] Owner dashboard (Supabase Auth)
- [ ] First pilot businesses

## Author
**Tebit Ramson Titih**, software engineering student, Cameroon.
