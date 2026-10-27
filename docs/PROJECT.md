# Rendo — Project handbook

The single document to understand, run and continue Rendo **without any outside help**.
Last updated: **27 Oct 2026** (milestone M3.7). Keep it up to date in the same commit as the change it describes.

Other docs: [`RESEARCH.md`](RESEARCH.md) (verified facts + why each decision was taken, with sources),
[`templates.md`](templates.md) (WhatsApp message templates, exact wording).

---

## 1. What Rendo is

A **WhatsApp booking assistant** for salons, barbers and clinics in Douala and Yaoundé.
A client writes to the business's WhatsApp number in French or English ("bonjour", "c'est combien les knotless
longues ? samedi matin"); Rendo answers instantly, explains what the salon does, gives real prices (as the salon
allows) and real free times, books the appointment, and alerts the owner on WhatsApp. Later: reminders (M4) and
owner commands (M5).

**Who pays:** the business (monthly). **Who uses it:** the business's clients, through WhatsApp only (no app).

**Principles that never change**
- Nothing is invented: prices come from the salon's catalogue, times from the real calendar, and "confirmé" is
  sent only after the database accepted the booking.
- The bot never discounts or bargains. A negotiated price is set by the owner and accepted by the client (M5).
- No medical/health information is stored. Message text is never stored nor logged.
- The client can always reach a person ("Parler à quelqu'un").
- No WhatsApp message to anyone who did not write first or opt in.

---

## 2. Status at a glance (27 Oct 2026)

| Area | State |
|---|---|
| Landing page + waitlist | Live (Netlify), `web/` |
| WhatsApp webhook (signature, dedupe, routing) | Live on the Meta **test number** |
| Booking conversation (fr/en, buttons, lists, typed requests) | Live |
| Catalogue: styles + questions (Taille/Longueur/Mèches), chairs, price display setting | Live (DB 0001–0012) |
| Owner alerts (templates) | New booking alert **delivered 27 Oct 2026**; cancellation + contact templates: check status in WhatsApp Manager |
| Reminders (M4) | **Not built** |
| Privacy clean-up jobs (delete old message ids / conversations) | **Not built** — promised in `web/privacy.html`, must be done in M4 |
| Owner commands, onboarding, catalogue editing (M5) | **Not built** |
| Real pilot salon (M6) | Not started |

Tests: **117 Deno tests** + **8 SQL test files** + 1 integration test (real Postgres + PostgREST).

---

## 3. Architecture

```
Client's WhatsApp
   │  (message / button tap)
   ▼
Meta WhatsApp Cloud API ──POST (signed X-Hub-Signature-256)──►  Supabase Edge Function  whatsapp-webhook
                                                                  index.ts   → reads secrets, wires real deps
                                                                  handler.ts → verify signature, extract messages,
                                                                               dedupe (claim wamid), run the bot,
                                                                               send replies + owner alerts
                                                                  _shared/bot.ts  → the conversation (pure logic)
                                                                  _shared/understand.ts → reads typed requests
                                                                  _shared/availability.ts → free slots
                                                                  _shared/supabase_repo.ts → database access
   ▲                                                                      │
   └──────────── replies (Graph API v25.0 /messages) ◄────────────────────┤
                                                                          ▼
                                                    Supabase Postgres (RLS on every table)
                                                    booking function rendo_book_appointment() = the only
                                                    way to create a booking; no-overlap per chair enforced
                                                    by an exclusion constraint
```

**Why this shape**
- `bot.ts` never touches the network or the database directly: it talks to a `Repo` interface.
  Tests use `tests/fake_repo.ts`; production uses `SupabaseRepo`. This is what makes 117 fast tests possible.
- Every button/list id carries the whole draft (`tm:<style>:<choices>:<startMs>`) and is **re-checked against
  fresh data**, so an old button tapped hours later can never book something wrong.
- The database has the last word: two clients tapping the same time at the same second → one booking per chair,
  the other gets fresh times.

---

## 4. Repository map

```
web/index.html, web/privacy.html          Landing page + waitlist; bilingual privacy policy
docs/PROJECT.md                           This handbook
docs/RESEARCH.md                          Verified facts and decision reasons (with sources)
docs/templates.md                         WhatsApp templates (source of truth for their wording)
supabase/config.toml                      verify_jwt = false for the webhook (Meta can't send a JWT)
supabase/migrations/0001…0012             Database schema, in order (see §5)
supabase/seed/demo_business.sql           Demo salon "Rendo Démo" on the test number (OWNER_NUMBER placeholder!)
supabase/tests/*.sql                      SQL tests: run in SQL Editor, end with ROLLBACK, print "… PASSED"
supabase/functions/whatsapp-webhook/
  index.ts                                Entry point: secrets → createHandler(real deps)
  handler.ts                              HTTP handling, signature, dedupe, calls runBot, sends, logs
  deno.json                               Import map for the function
supabase/functions/_shared/
  bot.ts                                  The conversation (screens, tap ids, booking, cancel, handoff)
  understand.ts                           Built-in understanding of typed text (styles, choices, dates, intents)
  availability.ts                         Free-slot engine (time zone, buffer, notice, horizon, chairs)
  i18n.ts                                 Every text the client reads (fr + en) + date/price formatting
  outbound.ts                             WhatsApp message shapes + limits (buttons ≤3, list rows ≤10…)
  whatsapp.ts                             Signature check, payload extraction, Graph API send
  domain.ts                               Types + the Repo interface
  supabase_repo.ts, mappers.ts, db.ts     Database access (supabase-js pinned 2.118.0), row → type mapping
  env.ts, types.ts                        Secret reading; webhook payload types
supabase/functions/tests/                 Deno unit tests (run all with one command, §8)
supabase/functions/integration/           Test against a real Postgres + PostgREST (optional, §8)
```

---

## 5. Database

All tables: **RLS enabled, no public access** (`anon`/`authenticated` revoked). Only the Edge Function
(service role / secret key) reads and writes. Functions are `security invoker` with `set search_path = ''`.

| Table | Purpose | Key rules |
|---|---|---|
| `waitlist` | Landing-page signups | Insert-only policy for the public form |
| `processed_webhook_events` | WhatsApp message ids already handled (dedupe) | Primary key `wamid` |
| `businesses` | One row per salon/clinic | `phone_number_id` unique; `owner_whatsapp` digits only; `chairs` 1–20; `price_display` on_request/always/never; `contact_phone` optional public number |
| `services` | Styles/services | `category`+`name` unique per business; `price_mode` fixed/from/on_site; `aliases` (words clients type); duration 5–480 min (internal only, never shown) |
| `service_choice_groups` | Questions of a style (Taille, Longueur, Mèches) | Max **3** per style (trigger); unique name per style |
| `service_choices` | Answers (Jumbo, Medium…) with `price_add_xaf`, `duration_add_minutes` | Max **10 active** per question (trigger); name ≤20 chars (WhatsApp button) |
| `opening_hours` | Weekly ranges, local time | Several ranges per day allowed |
| `closures` | Days/periods closed | — |
| `clients` | Per business; keyed on WhatsApp user id (BSUID), phone optional | `language` fr/en |
| `appointments` | Bookings | Exclusion constraint: no overlap **per chair** (`starts_at` → `blocked_until` = end + buffer); `estimate_xaf`, `price_mode`, `choices` (snapshot), `agreed_price_xaf` (owner-set, M5) |
| `conversations` | One per client: current step + small context (≤4 KB) | Optimistic locking (`version`); expires 2 h after last step |

**Booking function** `rendo_book_appointment(business, client, service, starts_at, choice_ids[])`
validates everything (active business/service, client belongs to business, exactly one active answer per
question that has one, start in the future), computes duration and estimate, tries chair 1..N, and returns
`booked` / `slot_taken` / `invalid` (with a reason). EXECUTE is granted to `service_role` only.

**Migrations** (never edit an applied one; add a new file)

| # | What it does |
|---|---|
| 0001 | Waitlist table + insert-only RLS policy |
| 0002 | `processed_webhook_events` (dedupe) |
| 0003 | Core booking schema: businesses, services, opening_hours, closures, clients, appointments, no-double-booking constraint |
| 0004 | Waitlist input checks |
| 0005 | `conversations` (state, context, expiry, optimistic locking) |
| 0006 | `rendo_upsert_client`, `rendo_book_appointment` v1 |
| 0007 | Handoff: `businesses.contact_phone`, `conversations.handoff_requested_at` |
| 0008 | Flexible catalogue: categories, English names, price modes, notes |
| 0009 | Chairs, style questions/answers, aliases, prices saved on bookings, booking function v2 |
| 0010 | Questions with no active answer are skipped; limits 3 questions / 10 answers |
| 0011 | `businesses.price_display` (on_request default / always / never) |
| 0012 | Fix: the limits no longer block re-saving an existing question/answer (upsert) |

---

## 6. The conversation (bot.ts)

**Steps:** greeting → style → one answer per question → day → time → summary → confirmed.
A typed message can fill several steps at once; the bot asks **only what is missing**.

| Client writes / taps | Bot does |
|---|---|
| "bonjour" (first time, or after 2 h) | Greets by first name, **says in one sentence what the salon does** ("Chez nous : coiffure (coupe, brushing), tresses (knotless, box braids, nattes collées)…"), invites a free request, 3 buttons |
| "vous faites quoi ?" / "what services do you offer?" | Same sentence + "Qu'est-ce qui vous ferait plaisir ?" |
| "knotless longues avec mes mèches samedi matin" | Recognises style + Longueur=Dos + Mèches=Vos mèches + Saturday morning; asks the missing question (Taille), then shows Saturday-morning times |
| "c'est combien les knotless ?" | Price (as the salon allows, §6.1), then the next question |
| "tresses" (several styles) | List of the matching styles |
| "vous faites la pédicure ?" (not offered) | Says honestly it isn't offered + the real list |
| "ANNULER" / "mes rendez-vous" | Lists upcoming appointments → cancel / keep |
| "déplacer mon rendez-vous" | Explains: cancel, then book a new time |
| "parler à quelqu'un" | Owner alerted (max once per 6 h per client) + public number if set |
| "EN" / "FR" | Switches language and stays on the same step; the choice is remembered |
| Something not understood | Repeats the current step; after 3 in a row offers a person |

### 6.1 Prices and durations (decided 27 Oct 2026)
- **Durations are never shown to clients** (no "≈ 5 h", no "Fin vers 14h30"). They are used internally so the
  chair is blocked for the right time.
- **Prices follow the salon setting `businesses.price_display`:**
  - `on_request` (default): no prices in lists or option buttons; the price is given when the client asks
    ("combien", "prix", "how much"…), stays visible for the rest of that booking, and is **always** in the summary
    before "Confirmer" ("à partir de 17 000 FCFA") so nobody is surprised at the salon.
  - `always`: prices in every list and option.
  - `never`: no amount ever; "Le prix se fixe au salon, selon le modèle" and "Prix : à convenir au salon".
  - In every case the estimate is saved on the booking for the owner.
- "dès" / "à partir de" = base price + chosen additions; the final price is confirmed at the salon.

### 6.2 Limits and protections
- Max 3 upcoming appointments per client; a repeated "Confirmer" is not a second booking.
- Max 3 questions per style; max 10 answers per question; max 10 rows per list (pages after that).
- Flow forgotten after 2 h of silence. Language auto-set to English only for a brand-new client writing clearly in English.
- Old buttons (sent before an update) still work; forged or stale ids never book.

### 6.3 Understanding (understand.ts)
Deterministic, no AI yet: style names + owner aliases (typo-tolerant), answer meanings ("mes mèches" = the
client's own hair, "longues" = Dos), French/English days ("samedi", "demain", "31/10"), times ("14h", "2pm"),
parts of day, intents. It only recognises what exists in the catalogue. Designed so an AI extractor can be
plugged in later behind the same interface (replies stay templated → prices/times still never invented).

---

## 7. Security and privacy rules (keep them)

- Secrets only in **Supabase secrets**: `WHATSAPP_VERIFY_TOKEN`, `META_APP_SECRET`, `WHATSAPP_TOKEN`,
  `WHATSAPP_PHONE_NUMBER_ID` (+ auto-injected `SUPABASE_URL`, `SUPABASE_SECRET_KEYS`). Never in the repo,
  never in screenshots or chat.
- Every webhook POST is verified (HMAC-SHA256, constant-time compare); missing secrets → every request fails closed.
- Logs contain message **types and ids only**, never message text or phone numbers.
- The seed file keeps `OWNER_NUMBER`; the real number is typed only in the SQL Editor, never committed.
- Deploy only with the CLI (never edit the function in the dashboard).
- Cameroon Law No. 2024/017 (personal data): data hosted by Supabase in London = cross-border transfer —
  check the authorisation requirement before the paid pilot. Privacy-policy promises to implement in M4:
  message ids deleted after 30 days, conversations after 24 h of inactivity, appointments anonymised after 12 months.
- Meta: from 1 Oct 2026 service messages are charged per message (beyond the free allowance) and a payment
  method is required on the WABA — budget it before the pilot.

---

## 8. How to work (Windows, PowerShell, in `C:\Users\Fujitsu\Desktop\rendo`)

| Task | Command / action |
|---|---|
| Run all Deno tests | `deno test supabase/functions/tests/` → expect `ok | 117 passed` |
| Apply new migrations | `supabase db push` then `supabase migration list` (Local = Remote) |
| SQL tests | Supabase → SQL Editor → paste a whole `supabase/tests/*.sql` → Ctrl+A → Run → "… PASSED" |
| Deploy the bot | `supabase functions deploy whatsapp-webhook --use-api` |
| Load/refresh the demo salon | Paste `supabase/seed/demo_business.sql` in SQL Editor, replace `OWNER_NUMBER` **in the editor only**, Run. Safe to re-run |
| Commit | `git add docs supabase` → `git status` → `git commit -m "…"` → `git push` |

**Order when a change touches the database:** tests → `db push` → SQL tests → deploy → seed (if changed) → commit → phone test.
(Deploying code that reads a new column before `db push` breaks the live bot.)

**Adding a database change:** new file `supabase/migrations/00NN_short_name.sql` + a test file in
`supabase/tests/` that ends with `rollback;` + update §5 of this handbook.

**Integration test (optional, needs a local Postgres 16 + PostgREST):** set `RENDO_IT_REST_URL` and
`RENDO_IT_JWT` (service_role JWT signed with PostgREST's secret), then
`deno test --allow-net --allow-env supabase/functions/integration/supabase_repo.integration.ts`.

**Meta / WhatsApp setup**
- Test number `phone_number_id` 1392005827320537, WABA 1767371018729362, Graph API v25.0. The test number can
  only message the (max 5) recipients added in the Meta app.
- App is Live; WABA subscribed to the app (`POST {WABA_ID}/subscribed_apps`); see RESEARCH.md "M0 go-live".
- Templates: see `templates.md`. Messages outside the 24 h window must be approved templates.

---

## 9. Roadmap

| Milestone | Content | State |
|---|---|---|
| M0 | Webhook live, signature, dedupe | ✅ |
| M1 | Booking schema, no double booking | ✅ |
| M2 | Availability engine | ✅ |
| M3 | Conversation, booking, cancel, handoff, owner alerts | ✅ |
| M3.5 | Flexible catalogue (categories, price modes, English) | ✅ |
| M3.6 | Chairs, style + questions, typed requests | ✅ |
| M3.7 | Natural greeting, no durations, price display setting, demo prices | ✅ (27 Oct 2026) |
| **M4** | **Reminders** (template `rendo_rappel_rendez_vous` ~24 h before, Confirm/Cancel quick replies, STOP keyword, opt-in line) via pg_cron → Edge Function; **privacy clean-up jobs** (§7) | Next |
| M5 | Owner commands on WhatsApp (TODAY, CANCEL R####, PRIX R#### amount → client accepts), owner onboarding, catalogue editing (styles, questions, prices, price_display, hours, chairs) | — |
| M6 | Pilot with 1–3 real salons (real price boards, real number, payment method on WABA, legal check) | — |

**Known gaps / risks (open)**
- One webhook serves one phone number (multi-salon routing by `phone_number_id` is in the schema but the
  secret holds a single id) — decide before the second salon.
- Reschedule = cancel + rebook (no one-step move yet).
- Understanding is keyword-based: heavy autocorrect ("same-day Martin" for "samedi matin") is missed; the bot
  then simply asks. An AI extractor is the planned improvement.
- Demo prices are placeholders; need 1–2 real salon price boards and 3 salon interviews.
- Old token to revoke; stray Netlify project to delete.

**How to pick up the next task without help**
1. Read §2 and §9, then the M4 notes in RESEARCH.md (pg_cron + pg_net facts).
2. Write the test first (copy the style of `tests/bot_flow.test.ts` or a `supabase/tests/*.sql` file).
3. Implement, run `deno test`, follow the order in §8, update this handbook, commit.

---

## 10. Glossary

| Term | Meaning |
|---|---|
| WABA | WhatsApp Business Account (owns numbers and templates) |
| phone_number_id | Meta's id of the business number; identifies which salon a message is for |
| BSUID / user_id | WhatsApp's business-scoped user id; present even when the client hides her number |
| wamid | WhatsApp message id; used to ignore duplicate deliveries |
| Template | Pre-approved message; required outside the 24 h window (reminders, owner alerts) |
| 24 h window | After a client's last message, the business may reply freely for 24 h |
| RLS | Row Level Security: Postgres blocks every row unless a policy allows it |
| Exclusion constraint | Database rule that makes two overlapping bookings on one chair impossible |
| Draft | The booking being built: style + answers (+ day/time) |
| Seed | SQL that creates the demo salon and its catalogue |
| on_request / always / never | The salon's price display setting (§6.1) |
