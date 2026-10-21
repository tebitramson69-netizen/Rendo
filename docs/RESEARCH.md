# Rendo — Verified technical facts (checked 13 Oct 2026)

Facts the booking-loop build depends on, checked against official docs before writing code.
"Not confirmed" means no official source was found — we design around it instead of trusting it.

## Meta / WhatsApp Cloud API

| Topic | Verified fact | Impact on Rendo |
|---|---|---|
| Webhook retries | Non-200 → Meta retries with decreasing frequency for up to **7 days**. Docs: *"retries can result in duplicate webhook notifications… handle deduplication."* | Deduplicate on `messages[].id` (wamid) in a `processed_webhook_events` table. |
| Ordering / timeout | **Not confirmed** by Meta. | Assume out-of-order delivery; return 200 quickly. |
| Sender identity (since Apr 2026) | Webhooks carry a business-scoped user ID: `contacts[].user_id` and `messages[].from_user_id` are always present. `wa_id` / `from` **can be missing** if the user adopted a WhatsApp username. | Key clients on `user_id`; keep the phone number nullable. Ask for a phone number only if `wa_id` is missing. |
| Payload | `value.metadata.phone_number_id` and `display_phone_number` present; `messages[].timestamp` is Unix seconds **as a string**. | Identify the business by `phone_number_id`; `Number(timestamp)`. |
| Reply buttons | Max **3**; title ≤ **20** chars, unique; id ≤ 256; body ≤ 1024; footer ≤ 60. | Greeting = 2–3 buttons. |
| List messages | Max **10 rows total**, ≤ 10 sections; row title ≤ **24**; description ≤ 72; button label ≤ 20; body ≤ 4096. | Dates and times are offered as lists of ≤ 10. |
| Incoming taps | `type:"interactive"` → `interactive.button_reply {id,title}` or `interactive.list_reply {id,title,description}`. Template quick-reply tap → `type:"button"` with `button.payload`. | Router handles both shapes. |
| 24-hour window | Outside 24h after the user's last message, **only approved templates** can be sent. | Reminders and owner alerts must be templates. |
| Templates | Categories: utility / marketing / authentication. Review ≤ **24h**. Meta can **re-categorize** utility → marketing. Rejected if a template **starts or ends with a variable**, has too many variables for its length, or skips numbering. Every variable needs a **sample value**. Utility templates allow quick-reply buttons (label ≤ 25). Language codes `fr`, `en`. | Write templates carefully, neutral wording, submit early. |
| Pricing (from 1 Oct 2026) | **Service (non-template) messages are now charged per message**, at the utility rate of the recipient's market. Utility templates inside the window are also charged. Cameroon = "Rest of Africa" rate group. A 1,000/month free allowance is reported by partners but **not confirmed** on Meta's pages. | Budget per message; re-check the rate card before quoting prices to clients. |
| Limits (unverified business) | 250 unique users / rolling 24h for business-initiated messages; **2 phone numbers** per portfolio; test number → max **5** recipients. | Enough for a pilot with 1–2 businesses. |
| Coexistence (same number in the WhatsApp Business app + API) | Requires being a **Tech Provider / Solution Partner** using Embedded Signup. Cameroon availability **not confirmed**. | Not possible for Rendo yet → pilot runs on a dedicated number. |
| Permanent token | Business settings → System users → Add (Admin) → Assign assets (app, full control) → Generate token, scopes `business_management`, `whatsapp_business_management`, `whatsapp_business_messaging`, expiry "Never". | Replaces the 24h token. Stored only as a Supabase secret. |
| API version | v26.0 is newest (Jul 2026); v25.0 supported until Jul 2028. | Keep one `GRAPH_VERSION` constant. |
| Mark as read | `POST /{PHONE_NUMBER_ID}/messages` `{"messaging_product":"whatsapp","status":"read","message_id":"<wamid>"}`; optional `typing_indicator`. | Nice-to-have, M3. |

## Supabase

| Topic | Verified fact | Impact on Rendo |
|---|---|---|
| CLI on Windows | Install via **Scoop** or per-project `npx supabase`. `npm install -g supabase` is **not supported**. | Use Scoop. |
| Docker | Not needed to deploy: CLI falls back to API bundling (`--use-api`, 5 MB limit). `link`, `db push`, `migration list/repair` don't need Docker (they ask for the DB password). `db pull`, `db diff`, `supabase start` do. | No Docker dependency for our workflow. |
| Migrations | Filename pattern `<digits>_name.sql` → `0001_waitlist.sql` is valid. Mark the manually-created table as applied: `supabase migration repair --status applied 0001`. | No rename needed. |
| verify_jwt | `[functions.whatsapp-webhook] verify_jwt = false` in config.toml is respected; without the block, every deploy defaults back to `true`. | Keep the config block; always deploy via CLI. |
| Secrets | `supabase secrets set NAME=value`; names can't start with `SUPABASE_`. Auto-injected: `SUPABASE_URL`, `SUPABASE_DB_URL`, `SUPABASE_SECRET_KEYS`, `SUPABASE_PUBLISHABLE_KEYS` (+ legacy keys). | Admin client: `createClient(url, JSON.parse(SUPABASE_SECRET_KEYS).default)`. |
| Imports | `npm:@supabase/supabase-js@2`; one `deno.json` per function. | Per-function `deno.json`. |
| Scheduling | pg_cron + pg_net + Vault (`cron.schedule` → `net.http_post`). pg_net is **async** (SQL never sees the response); responses kept 6h in `net._http_response`; **default timeout 2000 ms**. | Cron only triggers; the Edge Function sends and records results. Set a longer timeout. |
| btree_gist | Available on hosted Supabase: `create extension if not exists btree_gist with schema extensions;` | Enables the no-double-booking constraint. |
| Function limits | CPU **2 s** per request (I/O not counted), wall clock 150 s (Free), memory 256 MB. `EdgeRuntime.waitUntil` available. | Fine for our workload. |
| Dashboard editor | No version control; recommended only for quick tests. | Repo + CLI is the source of truth. |
| Testing | Deno: `irm https://deno.land/install.ps1 \| iex` (PowerShell); `deno test`. | Unit tests for the availability engine. |

## Corrections to earlier advice
- Earlier I said Meta's docs showed no pricing change. **Wrong**: service messages are charged from 1 Oct 2026.
- Earlier I said Coexistence was "available worldwide" as if Rendo could use it. **Misleading**: it requires Tech Provider status.
- My Step 0 plan assumed `wa_id` is always present. **Outdated**: since Apr 2026 it can be missing; key on `user_id`.

## M0 go-live debugging (17–18 Oct 2026): why real messages got no reply

Meta's dashboard **Test** button reached the function from day one, but real WhatsApp messages produced no reply. There were three independent causes; all three had to be fixed.

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | No log line at all for real messages | App was in **Development mode** ("some webhooks will not be sent if your app is in Dev mode"). | Added privacy policy URL, data-deletion URL, icon and category, then **Publish** (app is Live since 17 Oct 2026). |
| 2 | Still no log line after publishing | The WABA (`1767371018729362`) was subscribed only to Meta's own *"WA DevX Webhook Events 1P App"*, not to Rendo. The Test button bypasses this link. | Graph API Explorer, user token with `whatsapp_business_management`: `GET {WABA_ID}/subscribed_apps` to check, `POST {WABA_ID}/subscribed_apps` to subscribe. Rendo now listed. |
| 3 | Log showed `skip wrong_phone_number_id … 1392005827320537` | The `WHATSAPP_PHONE_NUMBER_ID` secret held a different value (its digest never matched SHA-256 of the real id). | `supabase secrets set WHATSAPP_PHONE_NUMBER_ID=1392005827320537`. The mismatch log now prints `configured=...<last 4>` so this is visible immediately next time. |

Other lessons:
- Run every `supabase` / `deno` command from the project folder (`cd $HOME\Desktop\rendo`); from elsewhere `deploy` fails with "Entrypoint path does not exist".
- The **test number** only replies to the (max 5) recipients added in *Step 1. Try it out*; others fail with error `131030`.
- Messages the function answered with HTTP 200 (including skipped ones) are **not retried** by Meta; send a fresh message after fixing config.
- A secret's digest in `supabase secrets list` is SHA-256 of the value. Compare it with `sha256(expected)` to verify a secret without revealing it.

## M1 schema notes (21 Oct 2026)

- Double booking is prevented in the database by an exclusion constraint (`appointments_no_overlap`, btree_gist,
  `tstzrange(starts_at, blocked_until) &&`, ignoring cancelled rows). `blocked_until` = end + buffer at booking time.
- Tested with two concurrent sessions booking the same slot: exactly one row survives. The loser gets either
  `23P01` (exclusion_violation) or `40P01` (deadlock_detected) when both insert at the same instant. M3 must treat
  **both** codes as "slot just taken" and offer another slot.
- Test suite `supabase/tests/m1_schema_test.sql` runs inside a transaction and rolls back (safe on production).
  Mutation-tested: removing the overlap constraint, the waitlist checks, or the access lock each makes it fail.
- Waitlist: public key now has INSERT only (Supabase grants ALL by default, and RLS does not cover TRUNCATE).
