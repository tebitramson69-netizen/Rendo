// Tests for the built-in understanding of typed requests. Run from the repo root:  deno test supabase/functions/tests/
import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { type CatalogStyle, distance, understand } from "../_shared/understand.ts";

// A realistic Douala salon catalogue
const KNOTLESS: CatalogStyle = {
  id: "knotless",
  name: "Knotless",
  nameEn: "Knotless braids",
  category: "Tresses",
  categoryEn: "Braids",
  aliases: ["knotless", "sans noeuds", "sans noeud"],
  groups: [
    {
      id: "taille",
      name: "Taille",
      nameEn: "Size",
      choices: [
        { id: "jumbo", name: "Jumbo", nameEn: "Jumbo" },
        { id: "medium", name: "Medium", nameEn: "Medium" },
        { id: "small", name: "Small", nameEn: "Small" },
      ],
    },
    {
      id: "longueur",
      name: "Longueur",
      nameEn: "Length",
      choices: [
        { id: "epaules", name: "Épaules", nameEn: "Shoulder" },
        { id: "dos", name: "Dos", nameEn: "Back" },
      ],
    },
    {
      id: "meches",
      name: "Mèches",
      nameEn: "Hair",
      choices: [
        { id: "vos", name: "Vos mèches", nameEn: "Your own hair" },
        { id: "salon", name: "Du salon", nameEn: "Salon hair" },
      ],
    },
  ],
};
const style = (id: string, name: string, extra: Partial<CatalogStyle> = {}): CatalogStyle => ({
  id,
  name,
  nameEn: null,
  category: "",
  categoryEn: null,
  aliases: [],
  groups: [],
  ...extra,
});
const CATALOG: CatalogStyle[] = [
  KNOTLESS,
  style("box", "Box braids", {
    category: "Tresses",
    categoryEn: "Braids",
    aliases: ["box braids", "box", "tresses classiques"],
  }),
  style("nattes", "Nattes collées", {
    nameEn: "Cornrows",
    category: "Tresses",
    categoryEn: "Braids",
    aliases: ["nattes", "cornrows"],
  }),
  style("vanilles", "Vanilles", {
    nameEn: "Twists",
    category: "Tresses",
    categoryEn: "Braids",
    aliases: ["vanille", "twist", "twists"],
  }),
  style("coupe", "Coupe", { nameEn: "Haircut", aliases: ["haircut"] }),
  style("brushing", "Brushing", { nameEn: "Blow-dry" }),
  style("manucure", "Manucure", { nameEn: "Manicure", aliases: ["ongles", "nails"] }),
];

const TZ = "Africa/Douala";
const NOW = new Date("2026-10-25T09:00:00Z"); // Sunday 25 October 2026, 10:00 in Douala
const u = (text: string, catalog = CATALOG) => understand(text, catalog, NOW, TZ);

Deno.test("understand: the full English request from the product discussion", () => {
  const r = u("Hi, how much is long knotless braids if I bring my own hair? Can I come Saturday morning?");
  assertEquals([r.intent, r.asksPrice, r.styleId], ["price", true, "knotless"]);
  assertEquals(r.choiceIds.sort(), ["dos", "vos"]);
  assertEquals([r.day, r.partOfDay, r.time, r.language], ["2026-10-31", "morning", null, "en"]);
  assertEquals(r.noMatch, false);
});

Deno.test("understand: the same request in French, with accents and punctuation", () => {
  const r = u("Bonsoir, c'est combien les knotless longues avec mes propres mèches ? Je peux passer samedi matin ?");
  assertEquals([r.intent, r.styleId, r.day, r.partOfDay, r.language], [
    "price",
    "knotless",
    "2026-10-31",
    "morning",
    "fr",
  ]);
  assertEquals(r.choiceIds.sort(), ["dos", "vos"]);
});

Deno.test("understand: 'vos mèches' from the CLIENT means the salon's hair (perspective)", () => {
  assertEquals(u("knotless avec vos mèches").choiceIds, ["salon"]);
  assertEquals(u("knotless, j'apporte mes mèches").choiceIds, ["vos"]);
  assertEquals(u("knotless with salon hair").choiceIds, ["salon"]);
  // both mentioned (often with a negation the bot can't read safely): ask, don't guess
  assertEquals(u("knotless, je n'ai pas mes mèches, vous fournissez ?").choiceIds, []);
});

Deno.test("understand: sizes and lengths; ambiguity is left for the bot to ask", () => {
  assertEquals(u("knotles small").choiceIds, ["small"]); // typo in the style name
  assertEquals(u("knotless jumbo épaules").choiceIds.sort(), ["epaules", "jumbo"]);
  assertEquals(u("knotless medium ou small ?").choiceIds, []); // two sizes: don't guess
  assertEquals(u("knotless mi-longues").choiceIds, []); // "mi-longues" is not "longues"
});

Deno.test("understand: a category with several styles gives candidates, not a guess", () => {
  const r = u("je veux des tresses demain à 14h");
  assertEquals(r.styleId, null);
  assertEquals(r.styleCandidates.sort(), ["box", "knotless", "nattes", "vanilles"]);
  assertEquals([r.intent, r.day, r.time], ["book", "2026-10-26", "14:00"]);
  assertEquals(u("braids please").styleCandidates.length, 4);
});

Deno.test("understand: styles by name, alias or English name", () => {
  assertEquals(u("box braids vendredi après-midi").styleId, "box");
  assertEquals(u("box braids vendredi après-midi").day, "2026-10-30");
  assertEquals(u("box braids vendredi après-midi").partOfDay, "afternoon");
  assertEquals(u("nattes collées pour demain").styleId, "nattes");
  assertEquals(u("cornrows tomorrow").styleId, "nattes");
  assertEquals(u("vous faites les vanilles ?").styleId, "vanilles");
  assertEquals(u("manucure ce week-end").styleId, "manucure");
  assertEquals(u("manucure ce week-end").day, "2026-10-31");
  assertEquals(u("I need a haircut").styleId, "coupe");
});

Deno.test("understand: something the salon doesn't offer is reported, never invented", () => {
  const r = u("do you do pedicure?");
  assertEquals([r.intent, r.styleId, r.styleCandidates, r.noMatch], ["book", null, [], true]);
  assertEquals(u("combien pour une pédicure ?").noMatch, true);
  assertEquals(u("c'est combien ?").noMatch, false); // a price question with nothing specific
  assertEquals(u("je veux un rdv demain").noMatch, false);
});

Deno.test("understand: dates", () => {
  assertEquals(u("le 31 octobre à 10h30").day, "2026-10-31");
  assertEquals(u("le 31 octobre à 10h30").time, "10:30");
  assertEquals(u("rdv le 31/10").day, "2026-10-31");
  assertEquals(u("rdv le 3/11").day, "2026-11-03");
  assertEquals(u("rdv le 30/02").day, null); // impossible date
  assertEquals(u("next saturday").day, "2026-10-31");
  assertEquals(u("samedi prochain").day, "2026-10-31");
  assertEquals(u("dimanche").day, "2026-10-25"); // today is Sunday
  assertEquals(u("dimanche prochain").day, "2026-11-01");
  assertEquals(u("après-demain").day, "2026-10-27");
  assertEquals(u("aujourd'hui").day, "2026-10-25");
  assertEquals(u("rdv le 2").day, "2026-11-02"); // the 2nd has passed this month -> next month
  assertEquals(u("rdv le 28").day, "2026-10-28");
  assertEquals(u("à 10:05 svp").day, null); // a time, not a date
});

Deno.test("understand: times and parts of the day", () => {
  assertEquals(u("10:30").time, "10:30");
  assertEquals(u("à 9h").time, "09:00");
  assertEquals(u("2pm tomorrow").time, "14:00");
  assertEquals(u("2pm tomorrow").day, "2026-10-26");
  assertEquals(u("9am").time, "09:00");
  assertEquals(u("I am available tomorrow").partOfDay, null); // "am" is not "morning"
  assertEquals(u("demain soir").partOfDay, "evening");
  assertEquals(u("dans la matinée").partOfDay, "morning");
});

Deno.test("understand: short messages and other intents", () => {
  assertEquals(u("Bonjour").intent, "greeting");
  assertEquals(u("Hello").language, null); // neutral: francophones say hello too
  assertEquals(u("Good morning").language, "en");
  assertEquals(u("Ok merci").intent, "thanks");
  assertEquals(u("EN").intent, "lang_en");
  assertEquals(u("français").intent, "lang_fr");
  assertEquals(u("je veux parler au salon").intent, "human");
  assertEquals(u("annuler mon rdv").intent, "mine");
  assertEquals(u("I want to cancel my booking").intent, "mine");
  const move = u("je veux déplacer mon rendez-vous à jeudi");
  assertEquals([move.intent, move.day], ["reschedule", "2026-10-29"]);
  assertEquals(u("can I move my appointment to Friday?").intent, "reschedule");
  assertEquals(u("mon rendez-vous de samedi").day, "2026-10-31"); // "mon" (my) is not Monday
  assertEquals(u("").intent, "unknown");
  assertEquals(u("👍").intent, "unknown");
});

Deno.test("understand: the current demo catalogue (separate 'Courtes' / 'Longues' styles in 'Tresses')", () => {
  const demo: CatalogStyle[] = [
    style("courtes", "Courtes", { nameEn: "Short", category: "Tresses", categoryEn: "Braids" }),
    style("longues", "Longues", { nameEn: "Long", category: "Tresses", categoryEn: "Braids" }),
    style("coupe", "Coupe", { nameEn: "Haircut", category: "Coiffure", categoryEn: "Hair" }),
  ];
  assertEquals(u("tresses longues samedi", demo).styleId, "longues");
  assertEquals(u("long braids", demo).styleId, "longues");
  assertEquals(u("des tresses svp", demo).styleCandidates.sort(), ["courtes", "longues"]);
});

Deno.test("understand: small-typo tolerance never matches unrelated short words", () => {
  assertEquals(distance("knotles", "knotless"), 1);
  assertEquals(u("bon box").styleId, "box"); // "bon" is not "box"
  assertEquals(u("bonne journée").styleCandidates, []);
  assertEquals(u("bonne journée").styleId, null);
});

Deno.test("understand: an owner's answer named 'Vos mèches, apportées au salon' still means the client's own hair", () => {
  const knot: CatalogStyle = {
    ...KNOTLESS,
    groups: [{
      id: "meches",
      name: "Mèches",
      nameEn: null,
      choices: [
        { id: "vos", name: "Vos mèches", nameEn: "Own hair, to the salon" },
        { id: "salon", name: "Mèches du salon", nameEn: null },
      ],
    }],
  };
  assertEquals(u("knotless avec mes propres mèches", [knot]).choiceIds, ["vos"]);
  assertEquals(u("knotless, vous fournissez les mèches ?", [knot]).choiceIds, ["salon"]);
});

Deno.test("understand: SMS spellings and typos used on WhatsApp", () => {
  assertEquals(u("Vous fait qoui").intent, "services");
  assertEquals(u("vs faites koi").intent, "services");
  assertEquals(u("kel sont vos services").intent, "services");
  assertEquals([u("cb les knotless").intent, u("cb les knotless").styleId], ["price", "knotless"]);
  assertEquals(u("c koi vos prix").noMatch, false);
  assertEquals(u("knotless dmain matin").day, "2026-10-26");
  assertEquals(u("hw much 4 box braids tmr").asksPrice, true);
  assertEquals(u("je peux venir ajd a 14h").time, "14:00");
  assertEquals(u("anuler").intent, "mine");
});
