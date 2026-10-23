// Run from the repo root:  deno test supabase/functions/tests/
// node:assert is built into Deno, so the tests need no download.
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { readEnv } from "../_shared/env.ts";
import {
  extractInbound,
  firstName,
  outboundContent,
  sendTemplate,
  sendText,
  templateContent,
  timingSafeEqual,
  verifyMetaSignature,
  type WebhookMessage,
  type WebhookPayload,
} from "../_shared/whatsapp.ts";

const SECRET = "test_app_secret";
const PHONE_ID = "1392005827320537";
const NOW = 1_800_000_000;

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytes(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

function payload(
  messages: unknown[],
  phoneNumberId = PHONE_ID,
  extra: Record<string, unknown> = {},
): WebhookPayload {
  return {
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: phoneNumberId, display_phone_number: "15551557958" },
          contacts: [{ wa_id: "237690000000", user_id: "BSUID.1", profile: { name: "Marie Ngo" } }],
          messages: messages as WebhookMessage[],
          ...extra,
        },
      }],
    }],
  };
}

const textMsg = (id: string, ts = NOW - 5) => ({
  id,
  from: "237690000000",
  timestamp: String(ts),
  type: "text",
  text: { body: "Bonjour" },
});

// ---------------- signature ----------------
Deno.test("signature: valid signature is accepted", async () => {
  const body = '{"a":1}';
  assert(await verifyMetaSignature(bytes(body), await sign(body), SECRET));
});

Deno.test("signature: tampered body is rejected", async () => {
  assert(!(await verifyMetaSignature(bytes('{"a":2}'), await sign('{"a":1}'), SECRET)));
});

Deno.test("signature: wrong secret, missing header, wrong prefix are rejected", async () => {
  const body = '{"a":1}';
  assert(!(await verifyMetaSignature(bytes(body), await sign(body, "other"), SECRET)));
  assert(!(await verifyMetaSignature(bytes(body), null, SECRET)));
  assert(!(await verifyMetaSignature(bytes(body), (await sign(body)).replace("sha256=", "sha1="), SECRET)));
  assert(!(await verifyMetaSignature(bytes(body), await sign(body), "")));
});

Deno.test("timingSafeEqual", () => {
  assert(timingSafeEqual("abc", "abc"));
  assert(!timingSafeEqual("abc", "abd"));
  assert(!timingSafeEqual("abc", "abcd"));
});

// ---------------- extractInbound ----------------
Deno.test("extract: accepts a fresh text message with sender details", () => {
  const r = extractInbound(payload([textMsg("wamid.1")]), PHONE_ID, NOW, 7200);
  assertEquals(r.accepted.length, 1);
  assertEquals(r.accepted[0].wamid, "wamid.1");
  assertEquals(r.accepted[0].phone, "237690000000");
  assertEquals(r.accepted[0].userId, "BSUID.1");
  assertEquals(r.accepted[0].profileName, "Marie Ngo");
});

Deno.test("extract: ignores messages sent to another phone number id", () => {
  const r = extractInbound(payload([textMsg("wamid.1")], "999"), PHONE_ID, NOW, 7200);
  assertEquals(r.accepted.length, 0);
  assertEquals(r.skipped[0].reason, "wrong_phone_number_id");
});

Deno.test("extract: skips stale retries", () => {
  const r = extractInbound(payload([textMsg("wamid.old", NOW - 7201)]), PHONE_ID, NOW, 7200);
  assertEquals(r.accepted.length, 0);
  assertEquals(r.skipped[0].reason, "too_old");
});

Deno.test("extract: skips unsupported types (reaction, sticker)", () => {
  const r = extractInbound(
    payload([
      { id: "wamid.r", from: "237690000000", timestamp: String(NOW), type: "reaction" },
      { id: "wamid.s", from: "237690000000", timestamp: String(NOW), type: "sticker" },
    ]),
    PHONE_ID,
    NOW,
    7200,
  );
  assertEquals(r.accepted.length, 0);
  assertEquals(r.skipped.map((s) => s.reason), ["unsupported_type", "unsupported_type"]);
});

Deno.test("extract: accepts interactive and template button replies", () => {
  const r = extractInbound(
    payload([
      {
        id: "wamid.i",
        from: "237690000000",
        timestamp: String(NOW),
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "BOOK", title: "Réserver" } },
      },
      {
        id: "wamid.b",
        from: "237690000000",
        timestamp: String(NOW),
        type: "button",
        button: { payload: "CONFIRM_1", text: "Je confirme" },
      },
    ]),
    PHONE_ID,
    NOW,
    7200,
  );
  assertEquals(r.accepted.map((m) => m.type), ["interactive", "button"]);
  assertEquals(r.accepted.map((m) => [m.choiceId, m.buttonPayload, m.text]), [
    ["BOOK", undefined, undefined],
    [undefined, "CONFIRM_1", undefined],
  ]);
});

Deno.test("extract: status-only payload produces no messages", () => {
  const p = payload([], PHONE_ID, { statuses: [{ id: "wamid.x", status: "delivered" }] });
  delete (p.entry![0].changes![0].value as Record<string, unknown>).messages;
  const r = extractInbound(p, PHONE_ID, NOW, 7200);
  assertEquals(r.accepted.length, 0);
  assertEquals(r.statusCount, 1);
});

Deno.test("extract: message without phone number (username user) keeps userId", () => {
  const p = payload([{ id: "wamid.u", from_user_id: "BSUID.9", timestamp: String(NOW), type: "text" }]);
  p.entry![0].changes![0].value!.contacts = [{ user_id: "BSUID.9", profile: { name: "A" } }];
  const r = extractInbound(p, PHONE_ID, NOW, 7200);
  assertEquals(r.accepted[0].phone, undefined);
  assertEquals(r.accepted[0].userId, "BSUID.9");
});

Deno.test("extract: non-WhatsApp payload is ignored", () => {
  const r = extractInbound({ object: "page" }, PHONE_ID, NOW, 7200);
  assertEquals(r.skipped[0].reason, "not_whatsapp");
});

Deno.test("extract: malformed message is skipped, not crashed on", () => {
  const r = extractInbound(payload([{ type: "text" }]), PHONE_ID, NOW, 7200);
  assertEquals(r.skipped[0].reason, "malformed");
});

Deno.test("extract: non-numeric timestamp is malformed, not 'too_old'", () => {
  const r = extractInbound(payload([{ ...textMsg("wamid.t"), timestamp: "abc" }]), PHONE_ID, NOW, 7200);
  assertEquals(r.skipped[0].reason, "malformed");
});

Deno.test("extract: null or odd payloads are ignored without throwing", () => {
  assertEquals(
    extractInbound(null as unknown as WebhookPayload, PHONE_ID, NOW, 7200).skipped[0].reason,
    "not_whatsapp",
  );
  const odd = { object: "whatsapp_business_account", entry: {} } as unknown as WebhookPayload;
  assertEquals(extractInbound(odd, PHONE_ID, NOW, 7200).accepted.length, 0);
});

Deno.test("extract: each message gets its own sender's profile name", () => {
  const p = payload([
    textMsg("wamid.a"),
    { ...textMsg("wamid.b"), from: "237699999999" },
  ]);
  p.entry![0].changes![0].value!.contacts = [
    { wa_id: "237690000000", profile: { name: "Marie" } },
    { wa_id: "237699999999", profile: { name: "Paul" } },
  ];
  const r = extractInbound(p, PHONE_ID, NOW, 7200);
  assertEquals(r.accepted.map((m) => m.profileName), ["Marie", "Paul"]);
});

Deno.test("extract: unknown sender among several contacts gets no name (no mix-up)", () => {
  const p = payload([{ ...textMsg("wamid.c"), from: "237600000000" }]);
  p.entry![0].changes![0].value!.contacts = [
    { wa_id: "237690000000", profile: { name: "Marie" } },
    { wa_id: "237699999999", profile: { name: "Paul" } },
  ];
  assertEquals(extractInbound(p, PHONE_ID, NOW, 7200).accepted[0].profileName, "");
});

// ---------------- text ----------------
Deno.test("firstName strips symbols and limits length", () => {
  assertEquals(firstName("  Marie Ngo "), "Marie");
  assertEquals(firstName("*Bob*_<script>"), "Bobscript");
  assertEquals(firstName("Ébène"), "Ébène");
  assertEquals(firstName(""), "");
  assertEquals(firstName("A".repeat(50)).length, 30);
});

// ---------------- env ----------------
Deno.test("readEnv reports missing and blank values", () => {
  const r = readEnv(["A", "B", "C"] as const, (n) => ({ A: "1", B: "  " } as Record<string, string>)[n]);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.missing, ["B", "C"]);
});

// ---------------- sendText ----------------
Deno.test("sendText: success returns message id", async () => {
  let sentBody = "";
  const fake = ((_url: string, init: RequestInit) => {
    sentBody = init.body as string;
    return Promise.resolve(
      new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 }),
    );
  }) as unknown as typeof fetch;
  const r = await sendText({ token: "t", phoneNumberId: PHONE_ID, fetchFn: fake }, "237690000000", "hi");
  assertEquals(r, { ok: true, status: 200, messageId: "wamid.out" });
  assertEquals(JSON.parse(sentBody).to, "237690000000");
});

Deno.test("sendText: API error keeps only the error code", async () => {
  const fake = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code: 190, message: "expired for +237..." } }), {
        status: 401,
      }),
    )) as unknown as typeof fetch;
  const r = await sendText({ token: "t", phoneNumberId: PHONE_ID, fetchFn: fake }, "x", "hi");
  assertEquals(r, { ok: false, status: 401, errorCode: 190 });
});

Deno.test("sendText: a hanging Graph API call times out instead of blocking", async () => {
  const hang = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
  const r = await sendText({ token: "t", phoneNumberId: PHONE_ID, fetchFn: hang, timeoutMs: 20 }, "x", "hi");
  assertEquals(r, { ok: false, status: 0 });
});

Deno.test("sendText: network failure does not throw", async () => {
  const fake = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
  const r = await sendText({ token: "t", phoneNumberId: PHONE_ID, fetchFn: fake }, "x", "hi");
  assertEquals(r, { ok: false, status: 0 });
});

// ---------------- outgoing message shapes ----------------
Deno.test("outbound: reply buttons and list match the Cloud API format", () => {
  assertEquals(
    outboundContent({
      kind: "buttons",
      body: "Que souhaitez-vous faire ?",
      footer: "Reply EN",
      buttons: [{ id: "m:book", title: "Prendre rendez-vous" }],
    }),
    {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Que souhaitez-vous faire ?" },
        footer: { text: "Reply EN" },
        action: { buttons: [{ type: "reply", reply: { id: "m:book", title: "Prendre rendez-vous" } }] },
      },
    },
  );
  assertEquals(
    outboundContent({
      kind: "list",
      body: "Choisissez",
      button: "Voir les heures",
      sectionTitle: "Heures",
      rows: [{ id: "t:1", title: "8h00", description: "Fin vers 8h30" }, { id: "t:2", title: "8h30" }],
    }),
    {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Choisissez" },
        action: {
          button: "Voir les heures",
          sections: [{
            title: "Heures",
            rows: [{ id: "t:1", title: "8h00", description: "Fin vers 8h30" }, { id: "t:2", title: "8h30" }],
          }],
        },
      },
    },
  );
});

Deno.test("outbound: template alert with body parameters, sent to the owner", async () => {
  const alert = { template: "rendo_nouveau_rdv" as const, language: "fr" as const, params: ["Marie", "Coupe"] };
  assertEquals(templateContent(alert), {
    type: "template",
    template: {
      name: "rendo_nouveau_rdv",
      language: { code: "fr" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Marie" }, { type: "text", text: "Coupe" }] }],
    },
  });
  let sent: Record<string, unknown> = {};
  const fake = ((_url: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "w" }] }), { status: 200 }));
  }) as unknown as typeof fetch;
  await sendTemplate({ token: "t", phoneNumberId: PHONE_ID, fetchFn: fake }, { phone: "237690000099" }, alert);
  assertEquals([sent.messaging_product, sent.to, sent.type], ["whatsapp", "237690000099", "template"]);
});

Deno.test("outbound: users who hide their number are addressed by user id ('recipient', not 'to')", async () => {
  let sent: Record<string, unknown> = {};
  const fake = ((_url: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
  await sendText({ token: "t", phoneNumberId: PHONE_ID, fetchFn: fake }, { userId: "CM.123456" }, "hi");
  assertEquals([sent.recipient, "to" in sent], ["CM.123456", false]);
});
