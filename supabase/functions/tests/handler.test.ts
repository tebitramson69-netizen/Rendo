// End-to-end tests of the webhook request flow with fake database and fake WhatsApp sender.
// Run from the repo root:  deno test supabase/functions/tests/
import { deepStrictEqual as assertEquals } from "node:assert/strict";
import type { ClaimResult } from "../_shared/types.ts";
import type { SendResult } from "../_shared/whatsapp.ts";
import { createHandler, type HandlerDeps } from "../whatsapp-webhook/handler.ts";

const SECRET = "test_app_secret";
const PHONE_ID = "1392005827320537";
const NOW = 1_800_000_000;
const URL_BASE = "https://example.supabase.co/functions/v1/whatsapp-webhook";

const env: HandlerDeps["env"] = {
  ok: true,
  values: {
    WHATSAPP_VERIFY_TOKEN: "verify_me",
    META_APP_SECRET: SECRET,
    WHATSAPP_TOKEN: "token",
    WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
  },
};

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function messageBody(id: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: PHONE_ID },
          contacts: [{ wa_id: "237690000000", profile: { name: "Marie Ngo" } }],
          messages: [{
            id,
            from: "237690000000",
            timestamp: String(NOW - 5),
            type: "text",
            text: { body: "Bonjour" },
          }],
        },
      }],
    }],
  });
}

async function signedPost(body: string): Promise<Request> {
  return new Request(URL_BASE, {
    method: "POST",
    headers: { "x-hub-signature-256": await sign(body), "content-type": "application/json" },
    body,
  });
}

/** Fake services that record what the handler did. */
function fakes(claimResult: ClaimResult | "throw" = "new") {
  const sent: Array<{ to: string; body: string }> = [];
  const claimed: string[] = [];
  const deps: HandlerDeps = {
    env,
    nowSeconds: () => NOW,
    claim: (wamid) => {
      claimed.push(wamid);
      if (claimResult === "throw") return Promise.reject(new Error("db down"));
      return Promise.resolve(claimResult);
    },
    send: (to, body): Promise<SendResult> => {
      sent.push({ to, body });
      return Promise.resolve({ ok: true, status: 200, messageId: "wamid.out" });
    },
  };
  return { deps, sent, claimed };
}

Deno.test("handler: GET handshake returns the challenge only with the right token", async () => {
  const h = createHandler(fakes().deps);
  const good = await h(
    new Request(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=verify_me&hub.challenge=42`),
  );
  assertEquals([good.status, await good.text()], [200, "42"]);
  const bad = await h(new Request(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`));
  assertEquals(bad.status, 403);
  const none = await h(new Request(URL_BASE));
  assertEquals(none.status, 403);
});

Deno.test("handler: other methods get 405", async () => {
  const res = await createHandler(fakes().deps)(new Request(URL_BASE, { method: "PUT" }));
  assertEquals(res.status, 405);
});

Deno.test("handler: unsigned or wrongly signed POST gets 401 and nothing is sent", async () => {
  const f = fakes();
  const h = createHandler(f.deps);
  const unsigned = await h(new Request(URL_BASE, { method: "POST", body: messageBody("wamid.1") }));
  const forged = await h(
    new Request(URL_BASE, {
      method: "POST",
      headers: { "x-hub-signature-256": await sign("something else") },
      body: messageBody("wamid.1"),
    }),
  );
  assertEquals([unsigned.status, forged.status], [401, 401]);
  assertEquals([f.claimed.length, f.sent.length], [0, 0]);
});

Deno.test("handler: signed invalid JSON gets 400", async () => {
  const res = await createHandler(fakes().deps)(await signedPost("{not json"));
  assertEquals(res.status, 400);
});

Deno.test("handler: new message is claimed once and answered once", async () => {
  const f = fakes("new");
  const res = await createHandler(f.deps)(await signedPost(messageBody("wamid.1")));
  assertEquals(res.status, 200);
  assertEquals(f.claimed, ["wamid.1"]);
  assertEquals(f.sent.length, 1);
  assertEquals(f.sent[0].to, "237690000000");
  assertEquals(f.sent[0].body.startsWith("Bonjour Marie"), true);
});

Deno.test("handler: duplicate delivery is acknowledged but not answered again", async () => {
  const f = fakes("duplicate");
  const res = await createHandler(f.deps)(await signedPost(messageBody("wamid.1")));
  assertEquals([res.status, f.sent.length], [200, 0]);
});

Deno.test("handler: database error (returned or thrown) asks Meta to retry and sends nothing", async () => {
  for (const mode of ["error", "throw"] as const) {
    const f = fakes(mode);
    const res = await createHandler(f.deps)(await signedPost(messageBody("wamid.1")));
    assertEquals([res.status, f.sent.length], [500, 0]);
  }
});

Deno.test("handler: status-only webhook never touches the database", async () => {
  const f = fakes();
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: { metadata: { phone_number_id: PHONE_ID }, statuses: [{ id: "w", status: "read" }] },
      }],
    }],
  });
  const res = await createHandler(f.deps)(await signedPost(body));
  assertEquals([res.status, f.claimed.length, f.sent.length], [200, 0, 0]);
});

Deno.test("handler: missing secrets make every request fail closed with 500", async () => {
  const f = fakes();
  const h = createHandler({ ...f.deps, env: { ok: false, missing: ["META_APP_SECRET"] } });
  const res = await h(await signedPost(messageBody("wamid.1")));
  assertEquals([res.status, f.sent.length], [500, 0]);
});
