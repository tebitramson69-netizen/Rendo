// Tests for the booking conversation. Run from the repo root:  deno test supabase/functions/tests/
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { type BotEvent, type BotResult, ids, intentOf, parseChoice, runBot, templateParam } from "../_shared/bot.ts";
import type { Business, Client } from "../_shared/domain.ts";
import { LIMITS, type Outbound } from "../_shared/outbound.ts";
import { FakeRepo, uuid } from "./fake_repo.ts";

// Douala local time -> Date (Douala is always UTC+1)
const at = (local: string) => new Date(local.replace(" ", "T") + ":00+01:00");
const SUNDAY_NOON = at("2026-11-01 12:00"); // Monday 2 Nov is the next open day

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
};

function setup(business: Business = BUSINESS) {
  const repo = new FakeRepo(business);
  const coupe = {
    id: uuid(),
    businessId: business.id,
    name: "Coupe",
    durationMinutes: 30,
    priceXaf: 3000,
    active: true,
  };
  const tresses = {
    id: uuid(),
    businessId: business.id,
    name: "Tresses",
    durationMinutes: 120,
    priceXaf: null,
    active: true,
  };
  const old = {
    id: uuid(),
    businessId: business.id,
    name: "Ancien",
    durationMinutes: 30,
    priceXaf: null,
    active: false,
  };
  repo.services.push(coupe, tresses, old);
  for (const weekday of [1, 2, 3, 4, 5]) {
    repo.hours.push({ weekday, opensAt: "08:00:00", closesAt: "12:00:00" }, {
      weekday,
      opensAt: "14:00:00",
      closesAt: "18:00:00",
    });
  }
  repo.hours.push({ weekday: 6, opensAt: "09:00:00", closesAt: "13:00:00" });
  return { repo, coupe, tresses, old };
}

async function client(repo: FakeRepo, phone: string | null = "237690000000", name = "Marie Ngo"): Promise<Client> {
  return await repo.upsertClient(BUSINESS.id, {
    phone: phone ?? undefined,
    waUserId: `BSUID.${phone ?? uuid()}`,
    displayName: name,
  });
}

/** Sends one event as the webhook will: load conversation, run, save. */
async function send(repo: FakeRepo, c: Client, event: BotEvent, now = SUNDAY_NOON): Promise<BotResult> {
  const fresh = repo.clients.find((x) => x.id === c.id)!;
  const conversation = await repo.conversation(fresh);
  const result = await runBot({ business: repo.business, client: fresh, conversation, event, now }, repo);
  assertEquals(await repo.saveConversation(result.conversation), "saved");
  for (const r of result.replies) checkLimits(r);
  return result;
}
const say = (text: string) => ({ type: "text", text }) as BotEvent;
const tap = (id: string) => ({ type: "choice", id }) as BotEvent;

function checkLimits(m: Outbound) {
  const len = (s: string) => Array.from(s).length;
  if (m.kind === "buttons") {
    assert(m.buttons.length >= 1 && m.buttons.length <= LIMITS.buttons);
    for (const b of m.buttons) assert(len(b.title) <= LIMITS.buttonTitle, `button title too long: ${b.title}`);
    assert(len(m.body) <= LIMITS.buttonsBody);
    assertEquals(new Set(m.buttons.map((b) => b.title)).size, m.buttons.length);
  }
  if (m.kind === "list") {
    assert(m.rows.length >= 1 && m.rows.length <= LIMITS.rows, `rows: ${m.rows.length}`);
    for (const r of m.rows) {
      assert(len(r.title) <= LIMITS.rowTitle, `row title too long: ${r.title}`);
      assert(!r.description || len(r.description) <= LIMITS.rowDescription);
      assert(r.id.length <= LIMITS.rowId);
    }
    assert(len(m.button) <= LIMITS.listButton && len(m.sectionTitle) <= LIMITS.sectionTitle);
  }
  if ((m.kind === "buttons" || m.kind === "list") && m.footer) assert(len(m.footer) <= LIMITS.footer);
}

const last = (r: BotResult) => r.replies[r.replies.length - 1];
const rowsOf = (m: Outbound) => (m.kind === "list" ? m.rows : []);
const buttonsOf = (m: Outbound) => (m.kind === "buttons" ? m.buttons : []);
const bodyOf = (m: Outbound) => m.body;

// ---------------------------------------------------------------------------
Deno.test("bot: first message (any text) greets with the 3-button menu", async () => {
  const { repo } = setup();
  const c = await client(repo);
  const r = await send(repo, c, say("Bonsoir je voudrais une coupe svp"));
  assertEquals(r.replies.length, 1);
  assert(bodyOf(r.replies[0]).startsWith("Bonjour Marie 👋 Bienvenue chez Rendo Démo."));
  assertEquals(buttonsOf(r.replies[0]).map((b) => b.id), [ids.book, ids.mine, ids.human]);
  assertEquals(r.replies[0].kind === "buttons" && r.replies[0].footer, "Reply EN for English");
  assertEquals(r.conversation.state, "menu");
});

Deno.test("bot: the client's text is never echoed back", async () => {
  const { repo } = setup();
  const c = await client(repo);
  await send(repo, c, say("bonjour"));
  const r = await send(repo, c, say("SECRET-123 mon dossier médical"));
  assert(!JSON.stringify(r).includes("SECRET-123"));
  assert(!JSON.stringify(r).includes("médical"));
});

Deno.test("bot: full booking — service, day, time page 2, confirm, booked + owner alert", async () => {
  const { repo, coupe } = setup();
  const c = await client(repo);
  await send(repo, c, say("bonjour"));

  // services: active only, with duration and price when set
  let r = await send(repo, c, tap(ids.book));
  assertEquals(rowsOf(last(r)).map((x) => [x.title, x.description]), [
    ["Coupe", "30 min · 3 000 FCFA"],
    ["Tresses", "2 h"],
  ]);

  // days: Monday is "Demain" (tomorrow), 16 free slots (08-12 and 14-18, every 30 min)
  r = await send(repo, c, tap(ids.service(coupe.id)));
  const dayRows = rowsOf(last(r));
  assertEquals(dayRows[0].title, "Demain");
  assertEquals(dayRows[0].description, "16 créneaux libres");
  assertEquals(dayRows[1].title, "Mar. 3 nov.");
  assert(dayRows.length <= 10);

  // times: 16 slots -> 9 shown + "Plus tard…"
  r = await send(repo, c, tap(dayRows[0].id));
  let times = rowsOf(last(r));
  assertEquals(times.length, 10);
  assertEquals(times.slice(0, 3).map((x) => x.title), ["8h00", "8h30", "9h00"]);
  assertEquals(times[0].description, "Fin vers 8h30");
  assertEquals(times[9].title, "Plus tard…");

  // page 2: the 7 remaining slots, no "later" row
  r = await send(repo, c, tap(times[9].id));
  times = rowsOf(last(r));
  assertEquals(times.map((x) => x.title), ["14h30", "15h00", "15h30", "16h00", "16h30", "17h00", "17h30"]);

  // pick 14h30 -> confirmation summary
  const pick = times.find((x) => x.title === "14h30")!;
  r = await send(repo, c, tap(pick.id));
  assert(bodyOf(last(r)).includes("lundi 2 novembre à 14h30"));
  assert(bodyOf(last(r)).includes("Prix : 3 000 FCFA"));
  assertEquals(buttonsOf(last(r)).map((b) => b.title), ["Confirmer", "Changer l'heure", "Annuler"]);

  // confirm -> booked
  r = await send(repo, c, tap(buttonsOf(last(r))[0].id));
  assert(bodyOf(last(r)).startsWith("✅ Rendez-vous confirmé !"));
  assert(bodyOf(last(r)).includes("Référence : R0001"));
  assertEquals(repo.appointments.length, 1);
  assertEquals(repo.appointments[0].start.toISOString(), at("2026-11-02 14:30").toISOString());
  assertEquals(r.alerts, [{
    template: "rendo_nouveau_rdv",
    language: "fr",
    params: ["Marie Ngo", "Coupe", "lundi 2 novembre à 14h30", "+237 690 00 00 00", "R0001"],
  }]);
  assertEquals(r.conversation.state, "idle");
});

Deno.test("bot: a slot taken by someone else is no longer offered, and an old tap can't book it", async () => {
  const { repo, coupe } = setup();
  const a = await client(repo, "237690000001", "Ana");
  const b = await client(repo, "237690000002", "Ben");
  const start = at("2026-11-02 08:00").getTime();

  // both see the confirmation for 8h00
  await send(repo, a, tap(ids.time(coupe.id, start)));
  await send(repo, b, tap(ids.time(coupe.id, start)));
  // A confirms first
  let r = await send(repo, a, tap(ids.confirm(coupe.id, start)));
  assert(bodyOf(last(r)).startsWith("✅"));
  // B confirms the same slot with the old button -> told it's gone, shown fresh times without 8h00
  r = await send(repo, b, tap(ids.confirm(coupe.id, start)));
  assert(bodyOf(last(r)).startsWith("Ce créneau n'est plus disponible."));
  assert(!rowsOf(last(r)).some((x) => x.title === "8h00" || x.title === "8h30")); // 8h30 is inside A's buffer
  assertEquals(repo.appointments.length, 1);
  assertEquals(r.alerts, []);
});

Deno.test("bot: losing the race in the database (slot_taken) shows fresh times", async () => {
  const { repo, coupe } = setup();
  const c = await client(repo);
  repo.nextBookTaken = true;
  const r = await send(repo, c, tap(ids.confirm(coupe.id, at("2026-11-02 09:00").getTime())));
  assert(bodyOf(last(r)).startsWith("Oups, ce créneau vient d'être pris"));
  assertEquals(last(r).kind, "list");
  assertEquals(r.alerts, []);
});

Deno.test("bot: taps that are too soon, outside opening hours or in the past never book", async () => {
  const { repo, coupe } = setup();
  const c = await client(repo);
  for (
    const local of ["2026-11-01 13:00", "2026-11-02 12:00", "2026-11-02 07:30", "2026-10-30 10:00", "2026-11-02 08:10"]
  ) {
    const r = await send(repo, c, tap(ids.confirm(coupe.id, at(local).getTime())));
    assert(!bodyOf(r.replies[0]).startsWith("✅"), `booked ${local}`);
  }
  assertEquals(repo.calls.filter((x) => x === "book").length, 0);
});

Deno.test("bot: inactive, foreign or garbage ids are handled safely", async () => {
  const { repo, old } = setup();
  const c = await client(repo);
  let r = await send(repo, c, tap(ids.service(old.id))); // inactive service
  assert(bodyOf(last(r)).startsWith("Cette prestation n'est plus disponible."));
  r = await send(repo, c, tap(ids.service(uuid()))); // unknown service
  assert(bodyOf(last(r)).startsWith("Cette prestation n'est plus disponible."));
  for (
    const bad of ["", "x", "s:not-a-uuid", "c:abc:123", "t+:" + old.id + ":2026-11-02:12", "m:drop", "a:'; drop table"]
  ) {
    r = await send(repo, c, tap(bad));
    assertEquals(last(r).kind, "buttons"); // back to the menu
  }
  assertEquals(parseChoice("x:" + "1".repeat(36)).kind, "invalid");
});

Deno.test("bot: my appointments -> cancel own appointment -> owner alerted; can't cancel twice or someone else's", async () => {
  const { repo, coupe } = setup();
  const a = await client(repo, "237690000001", "Ana");
  const b = await client(repo, "237690000002", "Ben");

  let r = await send(repo, a, tap(ids.mine));
  assertEquals(bodyOf(last(r)), "Vous n'avez aucun rendez-vous à venir.");

  await send(repo, a, tap(ids.confirm(coupe.id, at("2026-11-03 10:00").getTime())));
  r = await send(repo, a, say("ANNULER"));
  const rows = rowsOf(last(r));
  assertEquals(rows.map((x) => [x.title, x.description]), [["Mar. 3 nov. · 10h00", "Coupe · R0001"]]);

  r = await send(repo, a, tap(rows[0].id));
  assertEquals(buttonsOf(last(r)).map((x) => x.title), ["Annuler ce RDV", "Garder"]);

  // Ben tries Ana's appointment id
  const apptId = repo.appointments[0].id;
  r = await send(repo, b, tap(ids.cancel(apptId)));
  assert(bodyOf(last(r)).startsWith("Ce rendez-vous est déjà annulé ou passé."));
  assertEquals(repo.appointments[0].status, "confirmed");

  r = await send(repo, a, tap(ids.cancel(apptId)));
  assertEquals(bodyOf(last(r)), "Votre rendez-vous Coupe du mardi 3 novembre à 10h00 est annulé. À bientôt !");
  assertEquals(r.alerts[0].template, "rendo_annulation_rdv");
  assertEquals(r.alerts[0].params, ["Ana", "Coupe", "mardi 3 novembre à 10h00", "R0001"]);
  assertEquals(repo.appointments[0].status, "cancelled");

  r = await send(repo, a, tap(ids.cancel(apptId)));
  assertEquals(r.alerts, []);
});

Deno.test("bot: talk to someone — owner alerted once per 6 h, public number shown, hidden numbers handled", async () => {
  const { repo } = setup({ ...BUSINESS, contactPhone: "237677000000" });
  const c = await client(repo);
  let r = await send(repo, c, tap(ids.human));
  assertEquals(r.alerts, [{
    template: "rendo_demande_contact",
    language: "fr",
    params: ["Marie Ngo", "+237 690 00 00 00"],
  }]);
  assert(bodyOf(last(r)).includes("va vous contacter directement au +237 690 00 00 00"));
  assert(bodyOf(last(r)).includes("appeler Rendo Démo au +237 677 00 00 00"));
  assert(!bodyOf(last(r)).includes("690000099")); // owner's private number never shown

  r = await send(repo, c, say("humain"), at("2026-11-01 15:00"));
  assertEquals(r.alerts, []);
  assert(bodyOf(last(r)).startsWith("Votre demande a déjà été transmise."));

  r = await send(repo, c, tap(ids.human), at("2026-11-01 18:30")); // 6.5 h later
  assertEquals(r.alerts.length, 1);

  const hidden = await client(repo, null, "Username");
  r = await send(repo, hidden, tap(ids.human));
  assertEquals(r.alerts, []); // the owner could not call back
  assertEquals(bodyOf(last(r)), "Vous pouvez aussi appeler Rendo Démo au +237 677 00 00 00.");
});

Deno.test("bot: EN / FR switch is saved and the menu changes language", async () => {
  const { repo } = setup();
  const c = await client(repo);
  let r = await send(repo, c, say("English"));
  assertEquals(repo.languageChanges, [[c.id, "en"]]);
  assertEquals(buttonsOf(last(r)).map((b) => b.title), ["Book appointment", "My appointments", "Talk to someone"]);
  const menuMsg = last(r);
  assertEquals(menuMsg.kind === "buttons" && menuMsg.footer, "Écrivez FR pour le français");
  r = await send(repo, c, tap(ids.book));
  assertEquals(rowsOf(last(r))[0].description, "30 min · 3,000 FCFA");
  r = await send(repo, c, say("fr"));
  assertEquals(buttonsOf(last(r))[0].title, "Prendre rendez-vous");
});

Deno.test("bot: unknown text inside a step repeats the step; the 3rd time offers a person", async () => {
  const { repo, coupe } = setup();
  const c = await client(repo);
  await send(repo, c, tap(ids.service(coupe.id)));
  let r = await send(repo, c, say("demain matin ?"));
  assertEquals(r.replies.length, 2);
  assert(bodyOf(r.replies[0]).startsWith("Je n'ai pas compris"));
  assertEquals(r.conversation.state, "days"); // same step shown again
  r = await send(repo, c, say("??"));
  assert(!bodyOf(r.replies[0]).includes("Parler à quelqu'un"));
  r = await send(repo, c, say("allo"));
  assert(bodyOf(r.replies[0]).includes("« Parler à quelqu'un »"));
  // a recognised tap resets the counter
  r = await send(repo, c, tap(ids.menu));
  assertEquals(r.conversation.context.unknown, undefined);
});

Deno.test("bot: an unfinished flow expires after 2 h — next message just greets", async () => {
  const { repo, coupe } = setup();
  const c = await client(repo);
  await send(repo, c, tap(ids.service(coupe.id)), at("2026-11-01 08:00"));
  const r = await send(repo, c, say("ok"), at("2026-11-01 10:01"));
  assertEquals(r.replies.length, 1);
  assert(bodyOf(r.replies[0]).startsWith("Bonjour Marie"));
});

Deno.test("bot: no slots at all -> clear message with a way to reach a person", async () => {
  const { repo, coupe } = setup();
  repo.hours = [];
  const c = await client(repo);
  const r = await send(repo, c, tap(ids.service(coupe.id)));
  assert(bodyOf(last(r)).startsWith("Désolé, plus aucun créneau libre pour Coupe dans les 10 prochains jours."));
  assertEquals(buttonsOf(last(r)).map((b) => b.id), [ids.human, ids.menu]);
});

Deno.test("bot: long names never break WhatsApp limits; template params have no line breaks", async () => {
  const long = { ...BUSINESS, name: "Institut de Beauté et Bien-Être des Grandes Dames de Bonapriso" };
  const { repo } = setup(long);
  repo.services.push({
    id: uuid(),
    businessId: long.id,
    name: "Soin visage complet luxe",
    durationMinutes: 90,
    priceXaf: 1250000,
    active: true,
  });
  const c = await client(repo, "237690000000", "Marie\nNgo\t\tépouse   Kamga");
  let r = await send(repo, c, tap(ids.book)); // limits checked inside send()
  assert(rowsOf(last(r)).some((x) => x.description === "1 h 30 · 1 250 000 FCFA"));
  r = await send(repo, c, tap(ids.human));
  assertEquals(r.alerts[0].params[0], "Marie Ngo épouse Kamga");
  assertEquals(templateParam("  \n "), "-");
});

Deno.test("bot: keyword recognition ignores case, accents and punctuation", () => {
  assertEquals(intentOf("  Annulé !"), "mine");
  assertEquals(intentOf("MES RDV"), "mine");
  assertEquals(intentOf("Rendez-vous"), "book");
  assertEquals(intentOf("Bonjour!!"), "menu");
  assertEquals(intentOf("Français"), "lang_fr");
  assertEquals(intentOf("je veux annuler mon rdv de demain"), "mine"); // "annul…" wins over "rdv"
  assertEquals(intentOf("je veux un rdv pour samedi"), "book");
  assertEquals(intentOf("Bonsoir je voudrais une coupe svp"), "unknown");
  assertEquals(intentOf("I want to cancel"), "mine");
});
