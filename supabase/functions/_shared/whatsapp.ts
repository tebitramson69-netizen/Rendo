// WhatsApp Cloud API helpers shared by Rendo's Edge Functions.
// Pure functions (no database, no network) are kept separate so they can be unit-tested.

export const GRAPH_VERSION = "v25.0"; // supported until July 2028; v26.0 is also available

// ---------------------------------------------------------------------------
// Webhook payload types — only the fields Rendo uses.
// Since April 2026 `from` / `wa_id` can be missing (WhatsApp usernames);
// `from_user_id` / `user_id` (business-scoped user ID) are always present.
// ---------------------------------------------------------------------------
export interface WebhookMessage {
  id: string;
  from?: string;
  from_user_id?: string;
  timestamp: string; // Unix seconds, as a string
  type: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: { payload?: string; text?: string };
}

export interface WebhookValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; user_id?: string; profile?: { name?: string } }>;
  messages?: WebhookMessage[];
  statuses?: unknown[];
}

export interface WebhookPayload {
  object?: string;
  entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: WebhookValue }> }>;
}

/** A message Rendo should act on. */
export interface InboundMessage {
  wamid: string;
  phone?: string; // sender's WhatsApp number, if WhatsApp provided it
  userId?: string; // business-scoped user ID
  type: "text" | "interactive" | "button";
  timestamp: number;
  profileName: string;
}

export type SkipReason =
  | "not_whatsapp"
  | "wrong_phone_number_id"
  | "unsupported_type"
  | "too_old"
  | "malformed";

export interface ExtractResult {
  accepted: InboundMessage[];
  skipped: Array<{ reason: SkipReason; wamid?: string; detail?: string }>;
  statusCount: number;
}

const SUPPORTED_TYPES = new Set(["text", "interactive", "button"]);

/**
 * Pulls the messages Rendo should answer out of a webhook payload.
 * Skips: other phone numbers, unsupported types (reactions, stickers...), and stale retries.
 */
export function extractInbound(
  payload: WebhookPayload,
  expectedPhoneNumberId: string,
  nowSeconds: number,
  maxAgeSeconds: number,
): ExtractResult {
  const result: ExtractResult = { accepted: [], skipped: [], statusCount: 0 };
  if (payload?.object !== "whatsapp_business_account" || !Array.isArray(payload.entry ?? [])) {
    result.skipped.push({ reason: "not_whatsapp" });
    return result;
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      result.statusCount += value.statuses?.length ?? 0;
      if (!value.messages?.length) continue;

      const phoneNumberId = value.metadata?.phone_number_id;
      if (phoneNumberId !== expectedPhoneNumberId) {
        for (const m of value.messages) {
          result.skipped.push({ reason: "wrong_phone_number_id", wamid: m.id, detail: phoneNumberId });
        }
        continue;
      }

      for (const m of value.messages) {
        const ts = Number(m?.timestamp);
        if (!m?.id || !m.type || !m.timestamp || !Number.isFinite(ts)) {
          result.skipped.push({ reason: "malformed", wamid: m?.id });
          continue;
        }
        if (!SUPPORTED_TYPES.has(m.type)) {
          result.skipped.push({ reason: "unsupported_type", wamid: m.id, detail: m.type });
          continue;
        }
        if (nowSeconds - ts > maxAgeSeconds) {
          result.skipped.push({ reason: "too_old", wamid: m.id });
          continue;
        }
        const contact = findContact(value.contacts, m);
        result.accepted.push({
          wamid: m.id,
          phone: m.from ?? contact?.wa_id,
          userId: m.from_user_id ?? contact?.user_id,
          type: m.type as InboundMessage["type"],
          timestamp: ts,
          profileName: contact?.profile?.name ?? "",
        });
      }
    }
  }
  return result;
}

type Contact = NonNullable<WebhookValue["contacts"]>[number];

/**
 * The contact entry belonging to this message's sender. A batch can hold messages from
 * several people, so match on the number or user id; fall back to the only contact if there is one.
 */
function findContact(contacts: WebhookValue["contacts"], m: WebhookMessage): Contact | undefined {
  if (!contacts?.length) return undefined;
  const match = contacts.find((c) =>
    (m.from && c.wa_id === m.from) || (m.from_user_id && c.user_id === m.from_user_id)
  );
  return match ?? (contacts.length === 1 ? contacts[0] : undefined);
}

// ---------------------------------------------------------------------------
// Security: verify that a request really comes from Meta.
// Meta signs the raw body with the App Secret (HMAC-SHA256) and sends
// "sha256=<hex>" in the X-Hub-Signature-256 header.
// ---------------------------------------------------------------------------
const encoder = new TextEncoder();

export async function verifyMetaSignature(
  rawBody: ArrayBuffer,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!appSecret || !header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const expected = "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, header.toLowerCase());
}

/** Constant-time string comparison (the length of a SHA-256 signature is public anyway). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Message text
// ---------------------------------------------------------------------------

/** First name from the WhatsApp profile, cleaned so it can't break the message. */
export function firstName(profileName: string): string {
  const first = profileName.trim().split(/\s+/)[0] ?? "";
  // Keep letters (any language), marks, apostrophes and hyphens only; cap the length.
  return first.replace(/[^\p{L}\p{M}'-]/gu, "").slice(0, 30);
}

/** Temporary M0 reply, replaced by the booking flow in M3. Never echoes the client's text. */
export function buildWelcome(profileName: string): string {
  const name = firstName(profileName);
  const hello = name ? `Bonjour ${name} 👋` : "Bonjour 👋";
  return (
    `${hello}\nIci Rendo, l'assistant de rendez-vous. ` +
    `La prise de rendez-vous sur WhatsApp arrive très bientôt.\n\n` +
    `Hello! This is Rendo, the booking assistant. WhatsApp booking is coming soon.`
  );
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
export interface SendConfig {
  token: string;
  phoneNumberId: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

// Give up on the Graph API after this long so a slow Meta response can't hold the webhook open.
const SEND_TIMEOUT_MS = 10_000;

export interface SendResult {
  ok: boolean;
  status: number; // 0 = network error
  messageId?: string;
  errorCode?: number;
}

export async function sendText(cfg: SendConfig, to: string, body: string): Promise<SendResult> {
  const doFetch = cfg.fetchFn ?? fetch;
  try {
    const res = await doFetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${cfg.phoneNumberId}/messages`,
      {
        method: "POST",
        signal: AbortSignal.timeout(cfg.timeoutMs ?? SEND_TIMEOUT_MS),
        headers: { "Authorization": `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { preview_url: false, body },
        }),
      },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Only the numeric error code is kept: Meta's error text can contain the recipient's number.
      return { ok: false, status: res.status, errorCode: json?.error?.code };
    }
    return { ok: true, status: res.status, messageId: json?.messages?.[0]?.id };
  } catch {
    return { ok: false, status: 0 }; // network error or timeout
  }
}
