// Request handling for the WhatsApp webhook, kept apart from Deno.serve so it can be tested
// with fake dependencies (no network, no database).
import { type BotEvent, runBot } from "../_shared/bot.ts";
import type { Business, Client, Repo } from "../_shared/domain.ts";
import type { EnvResult } from "../_shared/env.ts";
import { TEXTS } from "../_shared/i18n.ts";
import type { Outbound, OwnerAlert } from "../_shared/outbound.ts";
import type { ClaimResult } from "../_shared/types.ts";
import {
  extractInbound,
  type InboundMessage,
  type Recipient,
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
  /** The database (created on first use, so status-only webhooks never touch it). */
  repo: () => Repo;
  /** Sends one bot message (text, buttons or list). */
  send: (to: Recipient, msg: Outbound) => Promise<SendResult>;
  /** Sends an approved template (owner alerts). */
  sendTemplate: (to: Recipient, alert: OwnerAlert) => Promise<SendResult>;
  nowSeconds?: () => number;
}

/** Turns a WhatsApp message into a bot event. Template quick-replies are handled in M4. */
export function eventOf(msg: InboundMessage): BotEvent {
  if (msg.type === "text") return { type: "text", text: msg.text ?? "" };
  if (msg.type === "interactive" && msg.choiceId) return { type: "choice", id: msg.choiceId };
  return { type: "other" };
}

/** A short, non-personal label for logs (never the error text: it can contain row values). */
function errorLabel(err: unknown): string {
  return err instanceof Error && err.name === "RepoError" ? err.message : "unexpected error";
}

/**
 * Runs one message through the booking conversation and sends the results.
 * Errors never escape: the client gets a polite "technical problem" message instead of silence.
 */
export async function processMessage(
  msg: InboundMessage,
  business: Business,
  deps: HandlerDeps,
  now: Date,
): Promise<void> {
  const to: Recipient = msg.phone ? { phone: msg.phone } : { userId: msg.userId! };
  let client: Client | null = null;
  try {
    const repo = deps.repo();
    client = await repo.upsertClient(business.id, {
      phone: msg.phone,
      waUserId: msg.userId,
      displayName: msg.profileName,
    });
    const conversation = await repo.conversation(client);
    const result = await runBot({ business, client, conversation, event: eventOf(msg), now }, repo);

    // Save before sending: if two messages from the same person race, the loser is only logged.
    // Its replies are still sent, because they describe what really happened (e.g. a booking).
    const saved = await repo.saveConversation(result.conversation);
    if (saved === "conflict") console.warn("conversation changed meanwhile (parallel message)", msg.wamid);

    let sent = 0;
    for (const reply of result.replies) {
      const r = await deps.send(to, reply); // one at a time: the order matters to the client
      if (r.ok) sent++;
      else console.error(`reply failed ${msg.wamid} status=${r.status} code=${r.errorCode ?? "-"}`);
    }
    for (const alert of result.alerts) {
      const r = await deps.sendTemplate({ phone: business.ownerWhatsapp }, alert);
      console.log(
        `owner alert ${alert.template} ${r.ok ? "sent" : `failed status=${r.status} code=${r.errorCode ?? "-"}`}`,
      );
    }
    console.log(
      `${msg.type} ${msg.wamid} -> ${result.conversation.state}, replies ${sent}/${result.replies.length}, alerts ${result.alerts.length}`,
    );
  } catch (err) {
    console.error(`processing failed ${msg.wamid}: ${errorLabel(err)}`);
    const lang = client?.language ?? business.defaultLanguage;
    await deps.send(to, { kind: "text", body: TEXTS[lang].technicalProblem });
  }
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
    const nowSeconds = now();
    const { accepted, skipped, statusCount } = extractInbound(
      payload,
      cfg.WHATSAPP_PHONE_NUMBER_ID,
      nowSeconds,
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

    // 4) Handle each new message once. Privacy: logs hold ids and states only, never text or numbers.
    let retryLater = false;
    let business: Business | null | undefined; // loaded once per request, on first need
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
      if (!msg.phone && !msg.userId) {
        console.log("no sender id on message, not replying", msg.wamid);
        continue;
      }
      if (business === undefined) {
        try {
          business = await deps.repo().businessByPhoneNumberId(cfg.WHATSAPP_PHONE_NUMBER_ID);
        } catch (err) {
          console.error(`loading business failed: ${errorLabel(err)}`);
          business = null;
        }
        if (!business) {
          console.error(`no active business for phone_number_id ...${cfg.WHATSAPP_PHONE_NUMBER_ID.slice(-4)}`);
        }
      }
      if (!business) continue;
      await processMessage(msg, business, deps, new Date(nowSeconds * 1000));
    }

    // 5) 200 tells Meta "received". 500 makes Meta retry; already-processed ids are skipped next time.
    return retryLater ? new Response("Retry later", { status: 500 }) : new Response("OK", { status: 200 });
  };
}
