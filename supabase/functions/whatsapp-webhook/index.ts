// Rendo — WhatsApp webhook (Task 2: receive a message, reply automatically)
// Runs as a Supabase Edge Function (Deno + TypeScript).
//
// Secrets this function needs (set them in Supabase → Edge Functions → Secrets):
//   WHATSAPP_VERIFY_TOKEN     any random string; must match the one you type in Meta's webhook settings
//   META_APP_SECRET           Meta app → App settings → Basic → App secret
//   WHATSAPP_TOKEN            access token from WhatsApp → API Setup (temporary one expires after ~24h)
//   WHATSAPP_PHONE_NUMBER_ID  "Phone number ID" shown under the test number in API Setup

const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "";
const APP_SECRET = Deno.env.get("META_APP_SECRET") ?? "";
const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";
const PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const GRAPH_URL = "https://graph.facebook.com/v25.0";

// Only the parts of Meta's webhook payload that Rendo uses.
interface IncomingMessage {
  id: string;
  from: string;
  type: string;
  text?: { body?: string };
}
interface WebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ profile?: { name?: string } }>;
        messages?: IncomingMessage[];
      };
    }>;
  }>;
}

const encoder = new TextEncoder();

// --- Security: prove the request really comes from Meta -----------------------
// Meta signs every POST body with your App Secret (HMAC-SHA256) and sends the
// result in the X-Hub-Signature-256 header. Anyone can find this URL, so we
// reject any request whose signature doesn't match.
async function isFromMeta(rawBody: ArrayBuffer, header: string | null): Promise<boolean> {
  if (!APP_SECRET || !header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const expected = "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  // Constant-time comparison, so an attacker can't guess the signature byte by byte.
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

// --- Sending a WhatsApp text message -----------------------------------------
async function sendText(to: string, body: string): Promise<void> {
  try {
    const res = await fetch(`${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body },
      }),
    });
    if (!res.ok) {
      // Most common cause: the temporary access token expired (error code 190).
      console.error("WhatsApp send failed", res.status, await res.text());
    }
  } catch (err) {
    // Network problem reaching Meta: log it, but still answer Meta's webhook with 200.
    console.error("WhatsApp send error", err);
  }
}

// --- What Rendo says back (Task 2: a simple bilingual welcome) --------------
function buildReply(name: string, text: string): string {
  const firstName = name.trim().split(" ")[0] || "";
  const hello = firstName ? `Bonjour ${firstName} 👋` : "Bonjour 👋";
  const echo = text ? `\n\nVous avez écrit : « ${text.slice(0, 200)} »` : "";
  return (
    `${hello}\nIci Rendo, l'assistant de rendez-vous.` +
    echo +
    `\n\nBientôt, je pourrai vous donner nos horaires et nos prix, et réserver un créneau pour vous.` +
    `\n\n— Hello! This is Rendo, the booking assistant. Booking is coming soon.`
  );
}

// --- The webhook itself -------------------------------------------------------
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // 1) Verification handshake: Meta calls GET once when you click "Verify and save".
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // 2) Every incoming event: read the raw body first (the signature is computed on it).
  const raw = await req.arrayBuffer();
  if (!(await isFromMeta(raw, req.headers.get("x-hub-signature-256")))) {
    console.warn("Rejected a request with a missing or invalid signature");
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // 3) Meta groups events: entry[] → changes[] → value. New messages are in value.messages.
  //    Delivery/read receipts arrive in value.statuses — we ignore those on purpose,
  //    otherwise Rendo would reply to its own "delivered" notices forever.
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const name = value.contacts?.[0]?.profile?.name ?? "";
      for (const msg of value.messages ?? []) {
        const text = msg.type === "text" ? (msg.text?.body ?? "") : "";
        // Privacy: log the message type, never the content (clinic messages can be sensitive).
        console.log(`Incoming ${msg.type} message, id ${msg.id}`);
        await sendText(msg.from, buildReply(name, text));
      }
    }
  }

  // 4) Always answer 200 quickly, or Meta will keep retrying the same event.
  return new Response("OK", { status: 200 });
});
