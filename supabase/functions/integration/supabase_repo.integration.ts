// Integration test: SupabaseRepo against a REAL Postgres + PostgREST (not run by `deno test` on
// the tests/ folder, because it needs a local database and downloads supabase-js).
//
// Requires:
//   RENDO_IT_REST_URL  PostgREST base URL (e.g. http://127.0.0.1:3001), schema with migrations 0001-0006
//   RENDO_IT_JWT       a JWT for role service_role signed with PostgREST's jwt-secret
// Run:  deno test --allow-net --allow-env supabase/functions/integration/supabase_repo.integration.ts
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { adminClient } from "../_shared/db.ts";
import { SupabaseRepo } from "../_shared/supabase_repo.ts";
import { availableSlots } from "../_shared/availability.ts";
import { ids, runBot } from "../_shared/bot.ts";
import { createHandler } from "../whatsapp-webhook/handler.ts";
import type { Outbound } from "../_shared/outbound.ts";

const REST = Deno.env.get("RENDO_IT_REST_URL");
const JWT = Deno.env.get("RENDO_IT_JWT");

// supabase-js calls <url>/rest/v1/...; PostgREST serves at its root. A tiny proxy strips the prefix.
let server: Deno.HttpServer<Deno.NetAddr> | undefined;
function startProxy(): string {
  server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const url = new URL(req.url);
    const target = REST + url.pathname.replace(/^\/rest\/v1/, "") + url.search;
    return fetch(target, { method: req.method, headers: req.headers, body: req.body });
  });
  return `http://127.0.0.1:${server.addr.port}`;
}

Deno.test({
  name: "SupabaseRepo against a real database",
  ignore: !REST || !JWT,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    Deno.env.set("SUPABASE_URL", startProxy());
    Deno.env.set("SUPABASE_SECRET_KEYS", JSON.stringify({ default: JWT }));
    const db = adminClient();
    const repo = new SupabaseRepo(db);

    // fresh test business (deleted at the end)
    const pnid = String(900000000000000 + Math.floor(Math.random() * 99999));
    const { data: biz, error } = await db.from("businesses")
      .insert({ name: "Repo IT", phone_number_id: pnid, owner_whatsapp: "237690000077" }).select("id").single();
    assert(!error && biz, `setup failed: ${error?.code}`);
    const businessId = biz.id as string;
    // bulk inserts need the same keys on every row (missing keys are sent as null)
    const svc = await db.from("services").insert([
      { business_id: businessId, name: "Coupe", duration_minutes: 30, price_xaf: 3000, sort_order: 2, active: true },
      { business_id: businessId, name: "Brushing", duration_minutes: 30, price_xaf: null, sort_order: 1, active: true },
      { business_id: businessId, name: "Ancien", duration_minutes: 30, price_xaf: null, sort_order: 0, active: false },
    ]);
    assert(!svc.error, `services setup failed: ${svc.error?.code}`);
    // open every day 08:00-18:00 so the test does not depend on today's weekday
    const oh = await db.from("opening_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        business_id: businessId,
        weekday,
        opens_at: "08:00",
        closes_at: "18:00",
      })),
    );
    assert(!oh.error, `opening_hours setup failed: ${oh.error?.code}`);

    try {
      await t.step("businessByPhoneNumberId", async () => {
        const b = await repo.businessByPhoneNumberId(pnid);
        assertEquals(b?.id, businessId);
        assertEquals(b?.slotMinutes, 30);
        assertEquals(await repo.businessByPhoneNumberId("123456789"), null);
      });

      await t.step("activeServices: active only, in sort order", async () => {
        const s = await repo.activeServices(businessId);
        assertEquals(s.map((x) => x.name), ["Brushing", "Coupe"]);
        assertEquals(s[1].priceXaf, 3000);
        assertEquals(s[0].priceXaf, null);
      });

      const client = await repo.upsertClient(businessId, {
        waUserId: "BSUID.IT.1",
        phone: "237690000078",
        displayName: "Marie",
      });
      await t.step("upsertClient is idempotent", async () => {
        const again = await repo.upsertClient(businessId, { phone: "237690000078" });
        assertEquals(again.id, client.id);
        assertEquals(again.displayName, "Marie");
        await repo.setClientLanguage(client.id, "en");
        assertEquals((await repo.upsertClient(businessId, { waUserId: "BSUID.IT.1" })).language, "en");
      });

      await t.step("conversation: new -> save -> stale save conflicts", async () => {
        const c = await repo.conversation(client);
        assert(c.isNew);
        assertEquals(await repo.saveConversation({ ...c, state: "choosing_service", context: { page: 1 } }), "saved");
        assertEquals(await repo.saveConversation({ ...c, state: "x" }), "conflict"); // second insert
        const loaded = await repo.conversation(client);
        assertEquals([loaded.isNew, loaded.state, loaded.version, loaded.context], [false, "choosing_service", 1, {
          page: 1,
        }]);
        assertEquals(await repo.saveConversation({ ...loaded, state: "choosing_day" }), "saved");
        assertEquals(await repo.saveConversation({ ...loaded, state: "confirming" }), "conflict"); // stale version 1
        assertEquals((await repo.conversation(client)).state, "choosing_day");
      });

      const services = await repo.activeServices(businessId);
      const coupe = services.find((s) => s.name === "Coupe")!;
      const now = new Date();
      const horizonEnd = new Date(now.getTime() + 3 * 86_400_000);
      let firstSlot: Date;

      await t.step("availability -> book -> slot disappears -> double booking refused", async () => {
        const b = (await repo.businessByPhoneNumberId(pnid))!;
        const input = async () => ({
          rules: {
            timezone: b.timezone,
            slotMinutes: b.slotMinutes,
            bufferMinutes: b.bufferMinutes,
            horizonDays: 3,
            minNoticeMinutes: b.minNoticeMinutes,
          },
          serviceMinutes: coupe.durationMinutes,
          ...(await repo.availabilityData(businessId, now, horizonEnd)),
          now,
        });
        const before = availableSlots(await input());
        assert(before.length > 0, "no slots offered");
        firstSlot = before[0].start;

        const r = await repo.book(businessId, client.id, coupe.id, firstSlot, []);
        assert(r.status === "booked", `book: ${JSON.stringify(r)}`);
        assert(/^R\d{4}$/.test(r.bookingCode));

        const after = availableSlots(await input());
        assert(!after.some((s) => s.start.getTime() === firstSlot.getTime()), "booked slot still offered");
        assertEquals((await repo.availabilityData(businessId, now, horizonEnd)).busy.length, 1);

        assertEquals(await repo.book(businessId, client.id, coupe.id, firstSlot, []), { status: "slot_taken" });
      });

      await t.step("upcoming -> cancel -> slot free again", async () => {
        const up = await repo.upcomingForClient(client.id, now);
        assertEquals(up.length, 1);
        assertEquals(up[0].service.name, "Coupe");
        const other = await repo.upsertClient(businessId, { waUserId: "BSUID.IT.2" });
        assertEquals(await repo.cancelByClient(up[0].id, other.id, now), "not_found"); // not their appointment
        assertEquals(await repo.cancelByClient(up[0].id, client.id, now), "cancelled");
        assertEquals(await repo.cancelByClient(up[0].id, client.id, now), "not_found"); // already cancelled
        assertEquals(await repo.upcomingForClient(client.id, now), []);
        assertEquals((await repo.availabilityData(businessId, now, horizonEnd)).busy.length, 0);
      });
      await t.step("bot end to end on the real repo: book, conversation saved, cancel", async () => {
        const b = (await repo.businessByPhoneNumberId(pnid))!;
        const me = await repo.upsertClient(businessId, {
          waUserId: "BSUID.IT.BOT",
          phone: "237690000079",
          displayName: "Bot Test",
        });
        const step = async (event: Parameters<typeof runBot>[0]["event"]) => {
          const conversation = await repo.conversation(me);
          const r = await runBot({ business: b, client: me, conversation, event, now: new Date() }, repo);
          assertEquals(await repo.saveConversation(r.conversation), "saved");
          return r;
        };
        let r = await step({ type: "text", text: "bonjour" });
        assertEquals(r.replies[0].kind, "buttons");
        r = await step({ type: "choice", id: ids.service(coupe.id) });
        const day = r.replies.at(-1)!;
        assert(day.kind === "list");
        r = await step({ type: "choice", id: day.rows[0].id });
        const time = r.replies.at(-1)!;
        assert(time.kind === "list");
        r = await step({ type: "choice", id: time.rows[0].id });
        const confirm = r.replies.at(-1)!;
        assert(confirm.kind === "buttons");
        r = await step({ type: "choice", id: confirm.buttons[0].id });
        assert(r.replies[0].body.startsWith("✅"), r.replies[0].body);
        assertEquals(r.alerts[0].template, "rendo_nouveau_rdv");
        assertEquals((await repo.conversation(me)).state, "idle");
        const [appt] = await repo.upcomingForClient(me.id, new Date());
        r = await step({ type: "choice", id: ids.cancel(appt.id) });
        assertEquals(r.alerts[0].template, "rendo_annulation_rdv");
        assertEquals(await repo.upcomingForClient(me.id, new Date()), []);
        r = await step({ type: "choice", id: ids.human });
        assertEquals(r.alerts[0].template, "rendo_demande_contact");
        assert((await repo.conversation(me)).handoffRequestedAt !== null);
      });
      await t.step("signed webhook -> real database -> replies (no network to Meta)", async () => {
        const secret = "it_secret";
        const sent: Outbound[] = [];
        const alerts: string[] = [];
        const nowS = Math.floor(Date.now() / 1000);
        const h = createHandler({
          env: {
            ok: true,
            values: {
              WHATSAPP_VERIFY_TOKEN: "v",
              META_APP_SECRET: secret,
              WHATSAPP_TOKEN: "t",
              WHATSAPP_PHONE_NUMBER_ID: pnid,
            },
          },
          claim: () => Promise.resolve("new"),
          repo: () => repo,
          send: (_to, msg) => (sent.push(msg), Promise.resolve({ ok: true, status: 200 })),
          sendTemplate: (_to, a) => (alerts.push(a.template), Promise.resolve({ ok: true, status: 200 })),
          nowSeconds: () => nowS,
        });
        const post = async (message: Record<string, unknown>) => {
          const body = JSON.stringify({
            object: "whatsapp_business_account",
            entry: [{
              changes: [{
                field: "messages",
                value: {
                  metadata: { phone_number_id: pnid },
                  contacts: [{ wa_id: "237690000081", profile: { name: "Webhook Test" } }],
                  messages: [{ from: "237690000081", timestamp: String(nowS), ...message }],
                },
              }],
            }],
          });
          const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          );
          const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
          const sig = "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
          const res = await h(
            new Request("http://x/", { method: "POST", headers: { "x-hub-signature-256": sig }, body }),
          );
          assertEquals(res.status, 200);
        };
        const tapId = (id: string) => ({
          id: crypto.randomUUID(),
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id, title: "x" } },
        });
        await post({ id: crypto.randomUUID(), type: "text", text: { body: "Bonjour" } });
        assert(sent[0].kind === "buttons" && sent[0].body.startsWith("Bonjour Webhook"));
        await post(tapId(ids.service(coupe.id)));
        const days = sent.at(-1)!;
        assert(days.kind === "list");
        await post(tapId(days.rows[0].id));
        const times = sent.at(-1)!;
        assert(times.kind === "list");
        await post(tapId(times.rows[0].id));
        const confirm = sent.at(-1)!;
        assert(confirm.kind === "buttons");
        await post(tapId(confirm.buttons[0].id));
        assert(sent.at(-1)!.body.startsWith("✅"), sent.at(-1)!.body);
        assertEquals(alerts, ["rendo_nouveau_rdv"]);
      });
      await t.step("style with choices + 2 chairs through the real database (embedded select, estimate, chairs)", async () => {
        await db.from("businesses").update({ chairs: 2 }).eq("id", businessId);
        const sv = await db.from("services").insert({
          business_id: businessId, category: "Tresses", name: "Knotless", duration_minutes: 240, price_xaf: 15000,
          price_mode: "from", aliases: ["knotless", "sans noeuds"],
        }).select("id").single();
        assert(!sv.error && sv.data, `service setup ${sv.error?.code}`);
        const sid = sv.data.id as string;
        const grp = await db.from("service_choice_groups")
          .insert({ business_id: businessId, service_id: sid, name: "Taille", sort_order: 1 }).select("id").single();
        assert(!grp.error && grp.data, `group setup ${grp.error?.code}`);
        const ch = await db.from("service_choices").insert([
          { business_id: businessId, group_id: grp.data.id, name: "Jumbo", price_add_xaf: 0, duration_add_minutes: 0, sort_order: 1, active: true },
          { business_id: businessId, group_id: grp.data.id, name: "Medium", price_add_xaf: 5000, duration_add_minutes: 60, sort_order: 2, active: true },
          { business_id: businessId, group_id: grp.data.id, name: "Vieux", price_add_xaf: 1, duration_add_minutes: 0, sort_order: 3, active: false },
        ]).select("id, name");
        assert(!ch.error && ch.data, `choices setup ${ch.error?.code}`);
        const medium = ch.data.find((c) => c.name === "Medium")!.id as string;

        const knot = (await repo.activeServices(businessId)).find((s) => s.id === sid)!;
        assertEquals(knot.aliases, ["knotless", "sans noeuds"]);
        assertEquals(knot.groups.map((g) => [g.name, g.choices.map((c) => c.name)]), [["Taille", ["Jumbo", "Medium"]]]);
        assertEquals((await repo.businessByPhoneNumberId(pnid))!.chairs, 2);
        assertEquals((await repo.businessByPhoneNumberId(pnid))!.priceDisplay, "on_request"); // 0011 default

        const when = new Date(Date.now() + 5 * 86_400_000);
        when.setUTCHours(7, 0, 0, 0); // 08:00 in Douala
        const a = await repo.book(businessId, client.id, sid, when, [medium]);
        assert(a.status === "booked", JSON.stringify(a));
        assertEquals(a.estimateXaf, 20000);
        assertEquals(a.endsAt.getTime() - when.getTime(), 5 * 3600_000);
        const other = await repo.upsertClient(businessId, { waUserId: "BSUID.IT.CH2" });
        const b = await repo.book(businessId, other.id, coupe.id, new Date(when.getTime() + 3600_000), []);
        assert(b.status === "booked", "second chair should take a parallel booking");
        const busy = (await repo.availabilityData(businessId, new Date(), new Date(when.getTime() + 86_400_000))).busy;
        // earlier steps also booked; look only at the two overlapping bookings made here
        const here = busy.filter((x) => x.start.getTime() === when.getTime() || x.start.getTime() === when.getTime() + 3600_000);
        assertEquals(here.map((x) => x.chair).sort(), [1, 2]);
        const up = (await repo.upcomingForClient(client.id, new Date())).find((x) => x.id === (a as { appointmentId: string }).appointmentId)!;
        assertEquals([up.serviceId, up.choiceNames], [sid, ["Medium"]]);
      });
    } finally {
      // clean up (appointments block business deletion on purpose: on delete restrict)
      await db.from("appointments").delete().eq("business_id", businessId);
      await db.from("businesses").delete().eq("id", businessId);
      await server?.shutdown();
    }
  },
});
