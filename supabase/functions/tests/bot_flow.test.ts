// M3.6 conversation: understand -> answer with real prices and times -> ask only what's missing.
// Run from the repo root:  deno test supabase/functions/tests/
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { type BotEvent, type BotResult, ids, runBot } from "../_shared/bot.ts";
import type { Business, ChoiceGroup, Client } from "../_shared/domain.ts";
import { LIMITS, type Outbound } from "../_shared/outbound.ts";
import { FakeRepo, svc, uuid } from "./fake_repo.ts";

const at = (local: string) => new Date(local.replace(" ", "T") + ":00+01:00"); // Douala = UTC+1
const NOW = at("2026-10-25 10:00"); // Sunday
const D = (sid: string, choices: string[] = []) => ({ sid, choices });

const SALON: Business = {
  id: "20000000-0000-4000-8000-000000000001",
  name: "Salon Belle Vie",
  ownerWhatsapp: "237690000099",
  timezone: "Africa/Douala",
  defaultLanguage: "fr",
  slotMinutes: 30,
  bufferMinutes: 10,
  horizonDays: 10,
  minNoticeMinutes: 120,
  contactPhone: null,
  chairs: 2,
  priceDisplay: "on_request",
};

const group = (name: string, nameEn: string, choices: Array<[string, string, number, number]>): ChoiceGroup => ({
  id: uuid(),
  name,
  nameEn,
  choices: choices.map(([n, en, price, minutes]) => ({
    id: uuid(),
    name: n,
    nameEn: en,
    priceAddXaf: price,
    durationAddMinutes: minutes,
  })),
});

function salon(business: Business = SALON) {
  const repo = new FakeRepo(business);
  const taille = group("Taille", "Size", [["Jumbo", "Jumbo", 0, 0], ["Medium", "Medium", 5000, 60], ["Small", "Small", 10000, 120]]);
  const longueur = group("Longueur", "Length", [["Épaules", "Shoulder", 0, 0], ["Dos", "Back", 3000, 60]]);
  const meches = group("Mèches", "Hair", [["Vos mèches", "Your own hair", 0, 0], ["Du salon", "Salon hair", 4000, 0]]);
  const knotless = svc({
    businessId: business.id,
    category: "Tresses",
    categoryEn: "Braids",
    name: "Knotless",
    nameEn: "Knotless",
    durationMinutes: 240,
    priceXaf: 15000,
    priceMode: "from",
    aliases: ["knotless", "sans noeuds"],
    groups: [taille, longueur, meches],
    note: "Prix final selon le modèle, confirmé au salon.",
  });
  const box = svc({
    businessId: business.id,
    category: "Tresses",
    categoryEn: "Braids",
    name: "Box braids",
    durationMinutes: 180,
    priceXaf: 12000,
    priceMode: "from",
    aliases: ["box braids", "box"],
  });
  const coupe = svc({ businessId: business.id, name: "Coupe", nameEn: "Haircut", durationMinutes: 30, priceXaf: 3000 });
  const conseil = svc({ businessId: business.id, name: "Conseil beauté", durationMinutes: 30, priceMode: "on_site" });
  repo.services.push(knotless, box, coupe, conseil);
  // braiders work through lunch: continuous hours
  for (const weekday of [1, 2, 3, 4, 5]) repo.hours.push({ weekday, opensAt: "08:00", closesAt: "18:00" });
  repo.hours.push({ weekday: 6, opensAt: "09:00", closesAt: "17:00" });
  const [jumbo, medium, small] = taille.choices;
  const [epaules, dos] = longueur.choices;
  const [vos, duSalon] = meches.choices;
  return { repo, knotless, box, coupe, conseil, jumbo, medium, small, epaules, dos, vos, duSalon };
}

async function client(repo: FakeRepo, phone = "237690000000", name = "Ana"): Promise<Client> {
  return await repo.upsertClient(SALON.id, { phone, waUserId: `BSUID.${phone}`, displayName: name });
}

async function send(repo: FakeRepo, c: Client, event: BotEvent, now = NOW): Promise<BotResult> {
  const fresh = repo.clients.find((x) => x.id === c.id)!;
  const conversation = await repo.conversation(fresh);
  const r = await runBot({ business: repo.business, client: fresh, conversation, event, now }, repo);
  assertEquals(await repo.saveConversation(r.conversation), "saved");
  for (const m of r.replies) {
    if (m.kind === "buttons") for (const b of m.buttons) assert(Array.from(b.title).length <= LIMITS.buttonTitle, b.title);
    if (m.kind === "list") {
      assert(m.rows.length <= LIMITS.rows);
      for (const row of m.rows) assert(row.id.length <= LIMITS.rowId && Array.from(row.title).length <= LIMITS.rowTitle);
    }
  }
  return r;
}
const say = (text: string) => ({ type: "text", text }) as BotEvent;
const tap = (id: string) => ({ type: "choice", id }) as BotEvent;
const last = (r: BotResult) => r.replies[r.replies.length - 1];
const rowsOf = (m: Outbound) => (m.kind === "list" ? m.rows : []);
const btns = (m: Outbound) => (m.kind === "buttons" ? m.buttons : []);

// ---------------------------------------------------------------------------
Deno.test("flow: one French message -> price answered, only the missing question asked, day kept", async () => {
  const s = salon();
  const c = await client(s.repo);
  let r = await send(
    s.repo,
    c,
    say("Bonsoir, c'est combien les knotless longues avec mes propres mèches ? Je peux passer samedi matin ?"),
  );
  assertEquals(r.replies.length, 1);
  assertEquals(
    last(r).body,
    "Bonjour Ana 👋 Bienvenue chez Salon Belle Vie.\n\n" +
      "Tresses – Knotless (Dos, Vos mèches) : dès 18 000 FCFA.\n\n" +
      "Le prix exact dépend de vos choix 👇\n\n" +
      "Tresses – Knotless (Dos, Vos mèches) — choisissez : Taille\n\n" +
      "• Jumbo : dès 18 000 FCFA\n• Medium : dès 23 000 FCFA\n• Small : dès 28 000 FCFA", // asked -> prices, never durations
  );
  assertEquals(btns(last(r)).map((b) => b.title), ["Jumbo", "Medium", "Small"]);

  // tap Medium -> straight to Saturday MORNING times (the day typed earlier is remembered)
  r = await send(s.repo, c, tap(btns(last(r))[1].id));
  assertEquals(last(r).body, "Tresses – Knotless (Medium, Dos, Vos mèches) – Sam. 31 oct. : à quelle heure ?");
  assertEquals(rowsOf(last(r)).map((x) => x.title), ["9h00", "9h30", "10h00", "10h30", "11h00"]); // 6 h must end by 17h
  assertEquals(rowsOf(last(r))[0].description, undefined); // no end time shown

  // 9h -> summary with the estimate and the salon's note (no duration)
  r = await send(s.repo, c, tap(rowsOf(last(r))[0].id));
  const summary = last(r).body;
  assert(summary.includes("• Tresses – Knotless (Medium, Dos, Vos mèches)\n"), summary);
  assert(!summary.includes("≈"), summary);
  assert(summary.includes("• samedi 31 octobre à 9h00"));
  assert(summary.includes("• Prix : à partir de 23 000 FCFA"));
  assert(summary.includes("ℹ️ Prix final selon le modèle, confirmé au salon."));

  // confirm -> booked with the estimate saved, and the owner sees the choices
  r = await send(s.repo, c, tap(btns(last(r))[0].id));
  assert(last(r).body.startsWith("✅ Rendez-vous confirmé !\nTresses – Knotless (Medium, Dos, Vos mèches)"), last(r).body);
  assert(last(r).body.includes("samedi 31 octobre à 9h00 chez Salon Belle Vie\n"));
  assert(last(r).body.includes("Prix : à partir de 23 000 FCFA"));
  const appt = s.repo.appointments[0];
  assertEquals([appt.estimateXaf, appt.choiceIds.length], [23000, 3]);
  assertEquals(appt.end.toISOString(), at("2026-10-31 15:00").toISOString()); // the chair is still blocked 6 h
  assertEquals(r.alerts[0].params[1], "Tresses – Knotless (Medium, Dos, Vos mèches)");
});

Deno.test("flow: the same request in English from a new client is answered in English", async () => {
  const s = salon();
  const c = await client(s.repo);
  const r = await send(
    s.repo,
    c,
    say("Hi, how much is long knotless braids if I bring my own hair? Can I come Saturday morning?"),
  );
  assert(last(r).body.includes("Braids – Knotless (Back, Your own hair): from 18,000 FCFA."), last(r).body);
  assert(last(r).body.includes("• Medium: from 23,000 FCFA"));
  assertEquals(s.repo.languageChanges, [[c.id, "en"]]);
});

Deno.test("flow: a complete request with an exact free time goes straight to the summary", async () => {
  const s = salon();
  const c = await client(s.repo);
  const r = await send(s.repo, c, say("knotless jumbo épaules avec mes mèches samedi à 10h"));
  assert(last(r).body.startsWith("Bonjour Ana 👋 Bienvenue chez Salon Belle Vie.\n\nsamedi 31 octobre à 10h00 est libre ✅"));
  assertEquals(btns(last(r)).map((b) => b.title), ["Confirmer", "Changer l'heure", "Annuler"]);
  assertEquals(r.conversation.state, "confirm");
});

Deno.test("flow: a time that isn't free, or a part of the day with nothing left, is said honestly", async () => {
  const s = salon();
  const c = await client(s.repo);
  let r = await send(s.repo, c, say("knotless jumbo épaules mes mèches samedi à 7h"));
  assert(last(r).body.includes("7h00 n'est pas disponible. Voici les heures libres :"), last(r).body);
  assertEquals(rowsOf(last(r))[0].title, "9h00");
  r = await send(s.repo, c, say("knotless jumbo épaules mes mèches samedi soir"));
  assert(last(r).body.includes("Plus de créneau libre le soir ce jour-là."), last(r).body);
  assert(rowsOf(last(r)).length > 0);
});

Deno.test("flow: several styles match -> the client picks; a price question gets the price list wording", async () => {
  const s = salon();
  const c = await client(s.repo);
  let r = await send(s.repo, c, say("je veux des tresses"));
  assert(last(r).body.endsWith("Laquelle de ces prestations souhaitez-vous ?"));
  assertEquals(rowsOf(last(r)).map((x) => [x.title, x.description]), [
    ["Knotless", undefined], // not asked: no prices (salon setting "on_request")
    ["Box braids", undefined],
  ]);
  r = await send(s.repo, c, say("c'est combien les tresses ?"));
  assert(last(r).body.includes("Voici nos prestations et leurs prix 👇"));
  assertEquals(rowsOf(last(r)).map((x) => x.description), ["dès 15 000 FCFA", "dès 12 000 FCFA"]); // asked: prices
});

Deno.test("flow: something not offered is said honestly, with the real list", async () => {
  const s = salon();
  const c = await client(s.repo);
  const r = await send(s.repo, c, say("vous faites la pédicure ?"));
  assert(last(r).body.includes("Désolé, nous ne proposons pas cette prestation pour le moment"), last(r).body);
  assertEquals(rowsOf(last(r)).length, 3); // Tresses (category), Coupe, Conseil beauté
});

Deno.test("flow: two chairs -> two clients at the same time, the third doesn't see that time", async () => {
  const s = salon();
  const start = at("2026-10-31 09:00").getTime();
  const draft = D(s.knotless.id, [s.jumbo.id, s.epaules.id, s.vos.id]);
  for (const phone of ["237690000001", "237690000002"]) {
    const c = await client(s.repo, phone);
    const r = await send(s.repo, c, tap(ids.confirm(draft, start)));
    assert(last(r).body.startsWith("✅"), last(r).body);
  }
  assertEquals(s.repo.appointments.map((a) => a.chair), [1, 2]);
  const third = await client(s.repo, "237690000003");
  const r = await send(s.repo, third, tap(ids.day(draft, "2026-10-31")));
  assert(!rowsOf(last(r)).some((x) => x.title === "9h00"));
});

Deno.test("flow: at most 3 upcoming appointments per client; a repeated Confirm is not a new booking", async () => {
  const s = salon();
  const c = await client(s.repo);
  const book = (local: string) => send(s.repo, c, tap(ids.confirm(D(s.coupe.id), at(local).getTime())));
  let r = await book("2026-10-26 09:00");
  assert(last(r).body.startsWith("✅"));
  r = await book("2026-10-26 09:00"); // same button again
  assertEquals(last(r).body, "Ce rendez-vous est déjà confirmé ✅ (référence R0001).");
  await book("2026-10-27 09:00");
  await book("2026-10-28 09:00");
  r = await book("2026-10-29 09:00");
  assert(last(r).body.startsWith("Vous avez déjà 3 rendez-vous à venir."), last(r).body);
  assertEquals(s.repo.appointments.length, 3);
});

Deno.test("flow: typing a new day or a new option continues the same booking", async () => {
  const s = salon();
  const c = await client(s.repo);
  await send(s.repo, c, tap(ids.day(D(s.knotless.id, [s.jumbo.id, s.epaules.id, s.vos.id]), "2026-10-31")));
  let r = await send(s.repo, c, say("plutôt lundi"));
  assertEquals(last(r).body, "Tresses – Knotless (Jumbo, Épaules, Vos mèches) – Demain : à quelle heure ?"); // Monday 26 is tomorrow
  r = await send(s.repo, c, say("finalement knotless small"));
  // the size changes, the other answers are kept
  assert(last(r).body.startsWith("Tresses – Knotless (Small, Épaules, Vos mèches) : quel jour vous arrange ?"), last(r).body);
});

Deno.test("flow: 'move my appointment' explains how and shows the appointments (no new booking)", async () => {
  const s = salon();
  const c = await client(s.repo);
  await send(s.repo, c, tap(ids.confirm(D(s.coupe.id), at("2026-10-27 09:00").getTime())));
  const r = await send(s.repo, c, say("je veux déplacer mon rendez-vous à jeudi"));
  assert(last(r).body.startsWith("Pour changer la date"), last(r).body);
  assertEquals(rowsOf(last(r)).length, 1);
  assertEquals(s.repo.appointments.length, 1);
});

Deno.test("flow: buttons sent before this version still work", async () => {
  const s = salon();
  const c = await client(s.repo);
  let r = await send(s.repo, c, tap(`s:${s.coupe.id}`));
  assertEquals(r.conversation.state, "days");
  r = await send(s.repo, c, tap(`d:${s.coupe.id}:2026-10-26`));
  assertEquals(r.conversation.state, "times");
  r = await send(s.repo, c, tap(`c:${s.coupe.id}:${at("2026-10-26 09:00").getTime()}`));
  assert(last(r).body.startsWith("✅"));
  // an old button for a style that now has questions asks them instead of booking
  r = await send(s.repo, c, tap(`c:${s.knotless.id}:${at("2026-10-27 09:00").getTime()}`));
  assertEquals(r.conversation.state, "options");
  assertEquals(s.repo.appointments.length, 1);
});

Deno.test("flow: stale or forged option ids never book", async () => {
  const s = salon();
  const c = await client(s.repo);
  const start = at("2026-10-27 09:00").getTime();
  // two sizes at once / an option of another style -> the questions are asked again
  for (const choices of [[s.jumbo.id, s.medium.id, s.vos.id], [s.jumbo.id, uuid(), s.vos.id]]) {
    const r = await send(s.repo, c, tap(ids.confirm(D(s.knotless.id, choices), start)));
    assertEquals(r.conversation.state, "options");
  }
  assertEquals(s.repo.calls.filter((x) => x === "book").length, 0);
});

Deno.test("flow: a Confirm id with two answers to one question, or a question skipped, never books", async () => {
  const s = salon();
  s.knotless.groups.splice(1, 1); // only Taille + Mèches: 3 ids could otherwise look complete
  const c = await client(s.repo);
  const start = at("2026-10-27 09:00").getTime();
  // Jumbo AND Medium (same question) + Vos mèches
  let r = await send(s.repo, c, tap(ids.confirm(D(s.knotless.id, [s.jumbo.id, s.medium.id, s.vos.id]), start)));
  assert(r.conversation.state !== "idle", r.conversation.state);
  assertEquals(s.repo.calls.filter((x) => x === "book").length, 0);
  // Mèches never answered: the question is asked, nothing is booked
  r = await send(s.repo, c, tap(ids.confirm(D(s.knotless.id, [s.medium.id]), start)));
  assertEquals(r.conversation.state, "options");
  assert(last(r).body.includes("choisissez : Mèches"), last(r).body);
  assertEquals(s.repo.calls.filter((x) => x === "book").length, 0);
});

Deno.test("flow: more than 3 options -> a list; more than 10 services -> pages", async () => {
  const s = salon();
  s.knotless.groups[0].choices.push({ id: uuid(), name: "Micro", nameEn: null, priceAddXaf: 15000, durationAddMinutes: 180 });
  const c = await client(s.repo);
  let r = await send(s.repo, c, tap(ids.style(D(s.knotless.id))));
  assertEquals(last(r).kind, "list");
  assertEquals(rowsOf(last(r)).map((x) => x.title), ["Jumbo", "Medium", "Small", "Micro"]);
  assertEquals(rowsOf(last(r))[3].description, undefined); // prices not asked (on_request)

  for (let i = 1; i <= 10; i++) {
    s.repo.services.push(svc({ businessId: SALON.id, name: `Soin ${i}`, durationMinutes: 30, priceXaf: 1000 * i }));
  }
  r = await send(s.repo, c, tap(ids.book));
  const rows = rowsOf(last(r));
  assertEquals(rows.length, 10);
  assertEquals(rows[9].title, "Plus de prestations…");
  r = await send(s.repo, c, tap(rows[9].id));
  assertEquals(rowsOf(last(r)).map((x) => x.title), ["Soin 7", "Soin 8", "Soin 9", "Soin 10"]);
});

Deno.test("flow: tap ids with 3 options stay within WhatsApp's 200-character limit", () => {
  const d = D(uuid(), [uuid(), uuid(), uuid()]);
  for (const id of [ids.style(d), ids.day(d, "2026-10-31", "afternoon"), ids.more(d, "2026-10-31", Date.now()), ids.time(d, Date.now()), ids.confirm(d, Date.now())]) {
    assert(id.length <= 200, `${id.length}`);
  }
});

// ---------------------------------------------------------------------------
// M3.7: talk like a salon — say what we do, no durations, prices as the salon decides
// ---------------------------------------------------------------------------
const FCFA = /FCFA/;
const allText = (r: BotResult) =>
  r.replies.map((m) => [m.body, ...btns(m).map((b) => b.title), ...rowsOf(m).map((x) => `${x.title} ${x.description ?? ""}`)].join("\n"))
    .join("\n");

Deno.test("talk: a first 'bonjour' says, in one sentence, what the salon does", async () => {
  const s = salon();
  const c = await client(s.repo);
  const r = await send(s.repo, c, say("bonjour"));
  assertEquals(
    last(r).body,
    "Bonjour Ana 👋 Bienvenue chez Salon Belle Vie.\n\n" +
      "Chez nous : tresses (knotless, box braids), coupe et conseil beauté.\n\n" +
      "Dites-moi simplement ce que vous souhaitez, par exemple « knotless samedi matin », ou choisissez ci-dessous 👇",
  );
  assertEquals(btns(last(r)).map((b) => b.title), ["Prendre rendez-vous", "Mes rendez-vous", "Parler à quelqu'un"]);
  assert(!FCFA.test(allText(r)), "no prices in a greeting");

  const en = await send(s.repo, await client(s.repo, "237690000001", "Joy"), say("good morning"));
  assert(last(en).body.includes("We offer: braids (knotless, box braids), haircut and conseil beauté."), last(en).body);
});

Deno.test("talk: 'vous faites quoi ?' is answered naturally; with 'prix' it gets the priced list", async () => {
  const s = salon();
  const c = await client(s.repo);
  await send(s.repo, c, say("bonjour"));
  let r = await send(s.repo, c, say("vous faites quoi comme services ?"));
  assertEquals(
    last(r).body,
    "Chez nous : tresses (knotless, box braids), coupe et conseil beauté.\n\n" +
      "Qu'est-ce qui vous ferait plaisir ? Écrivez-le simplement, par exemple « knotless samedi matin », ou appuyez sur « Prendre rendez-vous » 👇",
  );
  r = await send(s.repo, c, say("quels sont vos services et vos prix ?"));
  assert(last(r).body.includes("Voici nos prestations et leurs prix 👇"), last(r).body);
  assert(rowsOf(last(r)).some((x) => x.description === "3 000 FCFA"));
});

Deno.test("talk: 'je veux prendre rendez-vous pour ma fille' is a booking, never 'we don't offer that'", async () => {
  const s = salon();
  const c = await client(s.repo);
  const r = await send(s.repo, c, say("je veux prendre rendez-vous pour ma fille"));
  assert(!last(r).body.includes("nous ne proposons pas"), last(r).body);
  assertEquals(r.conversation.state, "services");
});

Deno.test("talk: no durations anywhere, and with 'on_request' no price until asked — except the summary", async () => {
  const s = salon();
  const c = await client(s.repo);
  let r = await send(s.repo, c, say("knotless samedi matin"));
  assertEquals(last(r).body, "Bonjour Ana 👋 Bienvenue chez Salon Belle Vie.\n\nTresses – Knotless — choisissez : Taille");
  const seen: string[] = [allText(r)];
  for (const pick of [0, 0, 0]) { // Jumbo, Épaules, Vos mèches
    r = await send(s.repo, c, tap(btns(last(r))[pick].id));
    seen.push(allText(r));
  }
  assertEquals(last(r).body, "Tresses – Knotless (Jumbo, Épaules, Vos mèches) – Sam. 31 oct. : à quelle heure ?");
  r = await send(s.repo, c, tap(rowsOf(last(r))[0].id));
  const summary = last(r).body;
  assert(summary.includes("• Prix : à partir de 15 000 FCFA"), summary); // the client knows before confirming
  r = await send(s.repo, c, tap(btns(last(r))[0].id));
  seen.push(summary, allText(r));
  assert(!FCFA.test(seen.slice(0, 4).join("\n")), "no price before the summary");
  for (const t of seen) assert(!/≈|\d h\b|Fin vers|environ/.test(t), t);
});

Deno.test("talk: salon setting 'always' shows prices without being asked", async () => {
  const s = salon({ ...SALON, priceDisplay: "always" });
  const c = await client(s.repo);
  const r = await send(s.repo, c, say("knotless"));
  assert(last(r).body.endsWith("• Jumbo : dès 15 000 FCFA\n• Medium : dès 20 000 FCFA\n• Small : dès 25 000 FCFA"), last(r).body);
});

Deno.test("talk: salon setting 'never' never quotes an amount, even when asked", async () => {
  const s = salon({ ...SALON, priceDisplay: "never" });
  const c = await client(s.repo);
  let r = await send(s.repo, c, say("c'est combien les knotless jumbo épaules avec mes mèches samedi à 10h ?"));
  assert(last(r).body.includes("Le prix se fixe au salon, selon le modèle 🙂"), last(r).body);
  assert(last(r).body.includes("• Prix : à convenir au salon"), last(r).body);
  const texts = [allText(r)];
  r = await send(s.repo, c, tap(btns(last(r))[0].id));
  texts.push(allText(r));
  assert(last(r).body.includes("Prix : à convenir au salon"), last(r).body);
  r = await send(s.repo, c, say("les prix svp"));
  texts.push(allText(r));
  assert(!FCFA.test(texts.join("\n")), texts.join("\n---\n"));
  assertEquals(s.repo.appointments[0].estimateXaf, 15000); // still saved for the owner
});

Deno.test("talk: once the client asked the price, the next questions of the same booking keep showing prices", async () => {
  const s = salon();
  const c = await client(s.repo);
  let r = await send(s.repo, c, say("c'est combien les knotless ?"));
  assert(last(r).body.includes("• Jumbo : dès 15 000 FCFA"), last(r).body);
  r = await send(s.repo, c, tap(btns(last(r))[0].id)); // Jumbo -> Longueur
  assert(last(r).body.endsWith("• Épaules : dès 15 000 FCFA\n• Dos : dès 18 000 FCFA"), last(r).body);
  // a new booking later (flow finished / expired) starts without prices again
  r = await send(s.repo, c, say("knotless"), new Date(NOW.getTime() + 3 * 3600_000));
  assert(!FCFA.test(last(r).body), last(r).body);
});
