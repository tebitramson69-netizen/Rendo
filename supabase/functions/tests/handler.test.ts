// End-to-end tests of the webhook request flow with fake database and fake WhatsApp sender.
// Run from the repo root:  deno test supabase/functions/tests/
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { ids } from "../_shared/bot.ts";
import type { Business } from "../_shared/domain.ts";
import type { Outbound, OwnerAlert } from "../_shared/outbound.ts";
import type { ClaimResult } from "../_shared/types.ts";
import type { Recipient, SendResult } from "../_shared/whatsapp.ts";
import { createHandler, type HandlerDeps } from "../whatsapp-webhook/handler.ts";
import { FakeRepo, svc } from "./fake_repo.ts";

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

type Msg = Record<string, unknown>;
const textMsg = (id: string, body = "Bonjour"): Msg => ({
  id,
  from: "237690000000",
  timestamp: String(NOW - 5),
  type: "text",
  text: { body },
});
const tapMsg = (id: string, choice: string, list = false): Msg => ({
  id,
  from: "237690000000",
  timestamp: String(NOW - 5),
  type: "interactive",
  interactive: list
    ? { type: "list_reply", list_reply: { id: choice, title: "x" } }
    : { type: "button_reply", button_reply: { id: choice, title: "x" } },
});

function messageBody(
  id: string | Msg,
  contacts: unknown[] = [{ wa_id: "237690000000", profile: { name: "Marie Ngo" } }],
): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: PHONE_ID },
          contacts,
          messages: [typeof id === "string" ? textMsg(id) : id],
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

const BUSINESS: Business = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Rendo Démo",
  ownerWhatsapp: "237690000099",
  timezone: "Africa/Douala",
  defaultLanguage: "fr",
  slotMinutes: 30,
  bufferMinutes: 10,
  horizonDays: 10,
  minNoticeMinutes: 120,
  contactPhone: null,
  chairs: 1,
};

/** Fake services that record what the handler did. */
function fakes(claimResult: ClaimResult | "throw" = "new", business: Business | null = BUSINESS) {
  const repo = new FakeRepo(business ?? BUSINESS);
  if (!business) repo.businessByPhoneNumberId = () => Promise.resolve(null);
  else repo.businessByPhoneNumberId = (id) => Promise.resolve(id === PHONE_ID ? business : null);
  const coupe = svc({ businessId: BUSINESS.id, name: "Coupe", durationMinutes: 30, priceXaf: 3000 });
  repo.services.push(coupe);
  for (const weekday of [1, 2, 3, 4, 5, 6, 7]) repo.hours.push({ weekday, opensAt: "08:00", closesAt: "18:00" });
  const sent: Array<{ to: Recipient; msg: Outbound }> = [];
  const templates: Array<{ to: Recipient; alert: OwnerAlert }> = [];
  const claimed: string[] = [];
  let repoCalls = 0;
  const deps: HandlerDeps = {
    env,
    nowSeconds: () => NOW,
    claim: (wamid) => {
      claimed.push(wamid);
      if (claimResult === "throw") return Promise.reject(new Error("db down"));
      return Promise.resolve(claimResult);
    },
    repo: () => {
      repoCalls++;
      return repo;
    },
    send: (to, msg): Promise<SendResult> => {
      sent.push({ to, msg });
      return Promise.resolve({ ok: true, status: 200, messageId: "wamid.out" });
    },
    sendTemplate: (to, alert): Promise<SendResult> => {
      templates.push({ to, alert });
      return Promise.resolve({ ok: true, status: 200, messageId: "wamid.tpl" });
    },
  };
  return { deps, sent, templates, claimed, repo, coupe, repoCalls: () => repoCalls };
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

Deno.test("handler: new message is claimed once and answered once with the menu", async () => {
  const f = fakes("new");
  const res = await createHandler(f.deps)(await signedPost(messageBody("wamid.1")));
  assertEquals(res.status, 200);
  assertEquals(f.claimed, ["wamid.1"]);
  assertEquals(f.sent.length, 1);
  assertEquals(f.sent[0].to, { phone: "237690000000" });
  assertEquals(f.sent[0].msg.kind, "buttons");
  assert(f.sent[0].msg.body.startsWith("Bonjour Marie"));
  assertEquals(f.repo.clients.length, 1); // client created
  assertEquals(f.repo.conversations.size, 1); // conversation saved
});

Deno.test("handler: taps (buttons and list rows) drive the booking; owner alerted by template", async () => {
  const f = fakes("new");
  const h = createHandler(f.deps);
  await h(await signedPost(messageBody(tapMsg("wamid.a", ids.book))));
  assertEquals(f.sent.at(-1)!.msg.kind, "list");
  await h(await signedPost(messageBody(tapMsg("wamid.b", ids.service(f.coupe.id), true))));
  const days = f.sent.at(-1)!.msg;
  assert(days.kind === "list");
  await h(await signedPost(messageBody(tapMsg("wamid.c", days.rows[0].id, true))));
  const times = f.sent.at(-1)!.msg;
  assert(times.kind === "list");
  await h(await signedPost(messageBody(tapMsg("wamid.d", times.rows[0].id, true))));
  const confirm = f.sent.at(-1)!.msg;
  assert(confirm.kind === "buttons");
  await h(await signedPost(messageBody(tapMsg("wamid.e", confirm.buttons[0].id))));
  assert(f.sent.at(-1)!.msg.body.startsWith("✅ Rendez-vous confirmé"));
  assertEquals(f.templates.length, 1);
  assertEquals(f.templates[0].to, { phone: "237690000099" }); // the owner's alert number
  assertEquals(f.templates[0].alert.template, "rendo_nouveau_rdv");
  assertEquals(f.repo.appointments.length, 1);
});

Deno.test("handler: user who hides their number is answered by user id", async () => {
  const f = fakes("new");
  const msg = {
    id: "wamid.u",
    from_user_id: "CM.42",
    timestamp: String(NOW - 5),
    type: "text",
    text: { body: "salut" },
  };
  await createHandler(f.deps)(await signedPost(messageBody(msg, [{ user_id: "CM.42", profile: { name: "Ana" } }])));
  assertEquals(f.sent[0].to, { userId: "CM.42" });
  assertEquals(f.repo.clients[0].phone, null);
});

Deno.test("handler: no active business for this number -> nothing sent, still 200", async () => {
  const f = fakes("new", null);
  const res = await createHandler(f.deps)(await signedPost(messageBody("wamid.1")));
  assertEquals([res.status, f.sent.length, f.repo.clients.length], [200, 0, 0]);
});

Deno.test("handler: a database failure during the conversation sends a polite error, never silence", async () => {
  const f = fakes("new");
  f.repo.conversation = () =>
    Promise.reject(Object.assign(new Error("conversation failed (08006)"), { name: "RepoError" }));
  const res = await createHandler(f.deps)(await signedPost(messageBody("wamid.1")));
  assertEquals(res.status, 200); // already claimed: a retry would be ignored anyway
  assertEquals(f.sent.length, 1);
  assert(f.sent[0].msg.body.startsWith("Désolé, un problème technique"));
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
  assertEquals([res.status, f.claimed.length, f.sent.length, f.repoCalls()], [200, 0, 0, 0]);
});

Deno.test("handler: missing secrets make every request fail closed with 500", async () => {
  const f = fakes();
  const h = createHandler({ ...f.deps, env: { ok: false, missing: ["META_APP_SECRET"] } });
  const res = await h(await signedPost(messageBody("wamid.1")));
  assertEquals([res.status, f.sent.length], [500, 0]);
});
