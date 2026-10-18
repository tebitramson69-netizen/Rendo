// Request handling for the WhatsApp webhook, kept apart from Deno.serve so it can be tested
// with fake dependencies (no network, no database).
import type { EnvResult } from "../_shared/env.ts";
import type { ClaimResult } from "../_shared/types.ts";
import {
  buildWelcome,
  extractInbound,
  type SendResult,
  timingSafeEqual,
  verifyMetaSignature,
  type WebhookPayload,
} from "../_shared/whatsapp.ts";

// Meta retries failed deliveries for up to 7 days. Don't answer messages older than this.
export const MAX_MESSAGE_AGE_SECONDS = 2 * 60 * 60;

export type SecretName =
  | "WHATSAPP_VERIFY_TOKEN"
  | "META_APP_SECRET"
  | "WHATSAPP_TOKEN"
  | "WHATSAPP_PHONE_NUMBER_ID";

export interface HandlerDeps {
  env: EnvResult<SecretName>;
  /** Records a message id; "duplicate" if it was already handled. */
  claim: (wamid: string) => Promise<ClaimResult>;
  /** Sends a WhatsApp text message. */
  send: (to: string, body: string) => Promise<SendResult>;
  nowSeconds?: () => number;
}

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  return async (req: Request): Promise<Response> => {
    if (!deps.env.ok) return new Response("Server not configured", { status: 500 });
    const cfg = deps.env.values;

    // 1) Verification handshake: Meta calls GET once when you click "Verify and save".
    if (req.method === "GET") {
      const url = new URL(req.url);
      const ok = url.searchParams.get("hub.mode") === "subscribe" &&
        timingSafeEqual(url.searchParams.get("hub.verify_token") ?? "", cfg.WHATSAPP_VERIFY_TOKEN);
      return ok
        ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 })
        : new Response("Forbidden", { status: 403 });
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    // 2) Prove the request comes from Meta (signature is computed on the raw bytes).
    const raw = await req.arrayBuffer();
    if (!(await verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), cfg.META_APP_SECRET))) {
      console.warn("Rejected request: missing or invalid signature");
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    // 3) Keep only messages Rendo should answer.
    const { accepted, skipped, statusCount } = extractInbound(
      payload,
      cfg.WHATSAPP_PHONE_NUMBER_ID,
      now(),
      MAX_MESSAGE_AGE_SECONDS,
    );
    for (const s of skipped) {
      // For a phone-number mismatch, also show the last 4 digits of the configured id so a wrong
      // WHATSAPP_PHONE_NUMBER_ID secret is obvious in the logs (the id is not secret, but keep it short).
      const hint = s.reason === "wrong_phone_number_id"
        ? `configured=...${cfg.WHATSAPP_PHONE_NUMBER_ID.slice(-4)}`
        : "";
      console.log(`skip ${s.reason}`, s.wamid ?? "", s.detail ?? "", hint);
    }
    if (statusCount) console.log(`ignored ${statusCount} status update(s)`);

    // 4) Answer each new message once. Privacy: log type + id only, never text or phone numbers.
    let retryLater = false;
    for (const msg of accepted) {
      let claim: ClaimResult;
      try {
        claim = await deps.claim(msg.wamid);
      } catch (err) {
        console.error("claim threw", err instanceof Error ? err.message : "unknown error");
        claim = "error";
      }
      if (claim === "duplicate") {
        console.log("duplicate delivery ignored", msg.wamid);
        continue;
      }
      if (claim === "error") {
        retryLater = true; // database problem: let Meta retry the whole batch later
        continue;
      }
      if (!msg.phone) {
        // WhatsApp username users without a visible number — handled in M3.
        console.log("no phone number on message, not replying", msg.wamid);
        continue;
      }
      const result = await deps.send(msg.phone, buildWelcome(msg.profileName));
      console.log(
        `${msg.type} ${msg.wamid} -> reply ${result.ok ? "sent" : "failed"}`,
        result.ok ? "" : `status=${result.status} code=${result.errorCode ?? "-"}`,
      );
    }

    // 5) 200 tells Meta "received". 500 makes Meta retry; already-processed ids are skipped next time.
    return retryLater ? new Response("Retry later", { status: 500 }) : new Response("OK", { status: 200 });
  };
}
