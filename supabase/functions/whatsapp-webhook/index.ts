// Rendo — WhatsApp webhook (M0: hardened receive + reply).
// Runs as a Supabase Edge Function (Deno + TypeScript). Deploy with the CLI only:
//   supabase functions deploy whatsapp-webhook --use-api
//
// Secrets (Supabase → Edge Functions → Secrets):
//   WHATSAPP_VERIFY_TOKEN     must match the verify token typed in Meta's webhook settings
//   META_APP_SECRET           Meta app → App settings → Basic → App secret
//   WHATSAPP_TOKEN            permanent System User token
//   WHATSAPP_PHONE_NUMBER_ID  the business number Rendo answers for
//
// The request logic lives in handler.ts (tested); this file only wires in the real services.
import { readEnv } from "../_shared/env.ts";
import { sendText } from "../_shared/whatsapp.ts";
import { adminClient, claimMessage } from "../_shared/db.ts";
import { createHandler, type SecretName } from "./handler.ts";

const env = readEnv<SecretName>([
  "WHATSAPP_VERIFY_TOKEN",
  "META_APP_SECRET",
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
]);
if (!env.ok) console.error("Missing secrets:", env.missing.join(", "));

Deno.serve(createHandler({
  env,
  // The database client is created on first use, so status-only webhooks never touch it.
  claim: (wamid) => claimMessage(adminClient(), wamid),
  send: (to, body) =>
    env.ok
      ? sendText(
        { token: env.values.WHATSAPP_TOKEN, phoneNumberId: env.values.WHATSAPP_PHONE_NUMBER_ID },
        to,
        body,
      )
      : Promise.resolve({ ok: false, status: 0 }),
}));
