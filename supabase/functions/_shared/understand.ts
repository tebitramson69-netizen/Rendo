// Rendo M3.6 — understanding typed requests, without AI.
//
// Reads a client's message ("Bonsoir, c'est combien les knotless longues avec mes propres mèches ?
// Je peux passer samedi matin ?") and extracts facts: what they want (price / booking / ...), which
// style of THIS salon's catalogue, which choices, which day, morning/afternoon, an exact time.
//
// Rules:
//   * It only RECOGNISES things that exist in the salon's catalogue. It never invents a style, a price or a
//     time: the conversation code looks prices up in the catalogue and times in the real calendar.
//   * Pure function: no database, no network, no clock (now is passed in) — fully testable.
//   * The text is used in memory only; it is never stored or logged.
//   * The output format is the plug for a future AI extractor: an AI model would fill the same
//     Understanding object, and the same validation and replies would follow.
import { localParts } from "./availability.ts";
import type { Lang } from "./domain.ts";

// ---------------------------------------------------------------------------
// Input: the salon's catalogue, reduced to what matching needs
// ---------------------------------------------------------------------------
export interface CatalogChoice {
  id: string;
  name: string;
  nameEn: string | null;
}

export interface CatalogGroup {
  id: string;
  name: string;
  nameEn: string | null;
  choices: CatalogChoice[];
}

export interface CatalogStyle {
  id: string;
  name: string;
  nameEn: string | null;
  category: string;
  categoryEn: string | null;
  /** Words clients type for this style, set by the owner ("knotless", "sans noeuds"). */
  aliases: string[];
  groups: CatalogGroup[];
}

export type Intent =
  | "lang_fr"
  | "lang_en"
  | "greeting"
  | "thanks"
  | "human"
  | "mine" // see / cancel my appointments
  | "reschedule"
  | "price" // asks how much
  | "services" // asks what the salon does ("vous faites quoi ?", "what services do you offer?")
  | "book" // wants an appointment
  | "unknown";

export type PartOfDay = "morning" | "afternoon" | "evening";

export interface Understanding {
  intent: Intent;
  /** Also asked for the price ("c'est combien ... je peux passer samedi ?" = book + price). */
  asksPrice: boolean;
  /** The one style clearly meant, if any. */
  styleId: string | null;
  /** Several styles match (e.g. "tresses" when the salon has 4 kinds): ask the client to pick among these. */
  styleCandidates: string[];
  /** Recognised choices of the matched style, at most one per group. */
  choiceIds: string[];
  /** Local date "YYYY-MM-DD" in the salon's time zone. */
  day: string | null;
  partOfDay: PartOfDay | null;
  /** Local time "HH:MM". */
  time: string | null;
  /** Language the message is written in, when clear. */
  language: Lang | null;
  /** The client asked about something, but nothing in the catalogue matched (e.g. "pedicure"). */
  noMatch: boolean;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
export function normalize(input: string): string {
  return input.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[’']/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

const tokens = (s: string) => (s ? s.split(" ") : []);

// SMS spellings and common typos seen in Cameroonian WhatsApp messages -> the plain word.
// Only whole words are replaced, and only in what the CLIENT wrote (never in catalogue names).
const SMS: Record<string, string> = {
  koi: "quoi", kwa: "quoi", qoi: "quoi", qoui: "quoi", quoa: "quoi", quio: "quoi", kois: "quoi",
  vs: "vous", vou: "vous",
  fai: "faites", fais: "faites", fait: "faites", faite: "faites", faits: "faites", faitent: "faites",
  kel: "quel", kels: "quels", kell: "quelle", kelle: "quelle", kelles: "quelles",
  cb: "combien", cbn: "combien", combie: "combien", combin: "combien", combine: "combien", combines: "combien",
  combiens: "combien", conbien: "combien", conbient: "combien", combient: "combien",
  pr: "pour", pk: "pourquoi", svp: "svp", stp: "svp",
  dmain: "demain", demin: "demain", dmn: "demain", deman: "demain", demaim: "demain",
  ajd: "aujourd hui", auj: "aujourd hui", ojd: "aujourd hui", aujourdhui: "aujourd hui",
  bsr: "bonsoir", bjr: "bonjour", bnjr: "bonjour", slt: "salut", mrc: "merci", mci: "merci",
  rdz: "rdv", rv: "rdv", rendevous: "rendez vous", rendezvous: "rendez vous",
  anuler: "annuler", anule: "annuler", annule: "annuler", annulle: "annuler",
  pls: "please", plz: "please", hw: "how", u: "you", ur: "your", wat: "what", wht: "what", wot: "what",
  tmr: "tomorrow", tmrw: "tomorrow", tomoro: "tomorrow", tomorow: "tomorrow", tommorow: "tomorrow",
  "2day": "today", "2moro": "tomorrow", "2main": "demain",
};

/** normalize() + SMS spellings fixed: "vs fait koi" -> "vous faites quoi". */
export function normalizeClient(input: string): string {
  return tokens(normalize(input)).map((w) => SMS[w] ?? w).join(" ");
}

/** Levenshtein distance, stopped early when it exceeds `max`. */
export function distance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Same word, allowing small typos on longer words ("knotles" = "knotless") and simple plurals. */
function sameWord(text: string, word: string): boolean {
  if (text === word) return true;
  const strip = (w: string) => w.replace(/(es|s|x)$/, "");
  if (word.length >= 4 && strip(text) === strip(word)) return true;
  if (word.length >= 5 && distance(text, word, 1) <= 1) return true;
  if (word.length >= 8 && distance(text, word, 2) <= 2) return true;
  return false;
}

/** Position where `phrase` (several words) appears in `words`, or -1. */
function findPhrase(words: string[], phrase: string[]): number {
  if (phrase.length === 0) return -1;
  outer: for (let i = 0; i + phrase.length <= words.length; i++) {
    for (let k = 0; k < phrase.length; k++) if (!sameWord(words[i + k], phrase[k])) continue outer;
    return i;
  }
  return -1;
}

const hasAny = (text: string, re: RegExp) => re.test(text);

// ---------------------------------------------------------------------------
// Intents (whole message = keyword, or keyword inside a sentence)
// ---------------------------------------------------------------------------
const EXACT: Array<[Intent, RegExp]> = [
  ["lang_en", /^(en|english|anglais|in english)$/],
  ["lang_fr", /^(fr|francais|french|en francais)$/],
  [
    "thanks",
    /^(ok|okay|ok merci|merci|merci beaucoup|thanks|thank you|thank you very much|thx|d accord|daccord|super|parfait|cool)$/,
  ],
  [
    "greeting",
    /^(menu|accueil|start|debut|bonjour|bonsoir|salut|hello|hi|hey|bjr|slt|cc|coucou|good morning|good afternoon|good evening|good day|morning|how are you|hello how are you)$/,
  ],
];

const HUMAN =
  /\b(humain|conseiller|parler a quelqu un|parler au salon|parler a la gerante|talk to someone|talk to a person|human|real person|call me|appelez moi)\b/;
const RESCHEDULE =
  /\b(deplacer|decaler|changer|reporter|modifier|move|reschedule|change|postpone)\b.{0,30}\b(rdv|rendez vous|rendezvous|appointment|booking|reservation)\b/;
const MINE = /\b(annul\w*|cancel\w*|mes rdv|mes rendez vous|my appointments?|my booking)\b/;
// "Vous faites les vanilles ?", "do you do pedicure?" = asking whether the salon offers something
const ASK_SERVICE =
  /\b(vous faites|faites vous|vous proposez|proposez vous|avez vous|vous avez|do you (do|offer|have)|can you do)\b/;
// "combines" = "combien" after a phone's English autocorrect
const PRICE = /\b(combien|combie|combines?|prix|tarifs?|cout\w*|coute\w*|how much|price\w*|cost\w*|rate\w*)\b/;
// "what do you do?" = asking for the list of services, not for one service
const SERVICES =
  /\b(vous faites quoi|faites quoi|vous proposez quoi|vous offrez quoi|qu est ce que vous (faites|proposez|offrez)|quels? (sont )?(vos |les )?(services|prestations|styles|coiffures)|quelles? (sont )?(vos |les )?(prestations|coiffures)|vos (services|prestations)|liste des (services|prestations)|what (services|do you (do|offer|have))|which services|your services|services do you)\b/;
const BOOK =
  /\b(rdv|rendez vous|rendezvous|reserv\w*|book\w*|appointment|passer|venir|dispo\w*|libre|available|free|come|slot|creneau\w*|place)\b/;
const GREETING_START = /^(bonjour|bonsoir|salut|hello|hi|hey|bjr|slt|cc|coucou|good (morning|afternoon|evening))\b/;

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------
const EN_WORDS = new Set([
  "hi",
  "hello",
  "good",
  "morning",
  "evening",
  "afternoon",
  "how",
  "much",
  "price",
  "can",
  "i",
  "come",
  "my",
  "own",
  "hair",
  "please",
  "want",
  "would",
  "like",
  "is",
  "the",
  "for",
  "tomorrow",
  "today",
  "saturday",
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "book",
  "appointment",
  "available",
  "what",
  "do",
  "you",
  "bring",
  "long",
  "short",
  "braids",
  "thanks",
  "thank",
  "next",
  "week",
  "this",
  "time",
  "cost",
  "with",
  "am",
  "pm",
]);
const FR_WORDS = new Set([
  "bonjour",
  "bonsoir",
  "salut",
  "combien",
  "prix",
  "je",
  "peux",
  "passer",
  "mes",
  "propres",
  "meches",
  "avec",
  "pour",
  "demain",
  "aujourd",
  "hui",
  "samedi",
  "dimanche",
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "rendez",
  "vous",
  "rdv",
  "est",
  "c",
  "les",
  "des",
  "le",
  "la",
  "matin",
  "soir",
  "apres",
  "midi",
  "svp",
  "merci",
  "tresses",
  "longues",
  "courtes",
  "voudrais",
  "veux",
  "faire",
  "quel",
  "quelle",
  "une",
  "un",
  "cette",
  "semaine",
  "prochain",
  "prochaine",
]);

function detectLanguage(words: string[]): Lang | null {
  let en = 0, fr = 0;
  for (const w of words) {
    if (EN_WORDS.has(w)) en++;
    if (FR_WORDS.has(w)) fr++;
  }
  if (en === 0 && fr === 0) return null;
  if (en >= fr + 2 || (fr === 0 && en >= 1)) return "en";
  if (fr >= en + 2 || (en === 0 && fr >= 1)) return "fr";
  return null;
}

// ---------------------------------------------------------------------------
// Dates and times (in the salon's time zone)
// ---------------------------------------------------------------------------
const WEEKDAYS: Array<[number, RegExp]> = [ // ISO: 1 = Monday ... 7 = Sunday
  [1, /^(lundi|monday)$/], // not "mon": it is also French for "my" ("mon rendez-vous")
  [2, /^(mardi|tuesday|tue|tues)$/],
  [3, /^(mercredi|wednesday|wed)$/],
  [4, /^(jeudi|thursday|thu|thurs)$/],
  [5, /^(vendredi|friday|fri)$/],
  [6, /^(samedi|saturday|sat)$/],
  [7, /^(dimanche|sunday|sun)$/],
];
const MONTHS = [
  /^(janvier|janv|january|jan)$/,
  /^(fevrier|fevr|february|feb)$/,
  /^(mars|march|mar)$/,
  /^(avril|avr|april|apr)$/,
  /^(mai|may)$/,
  /^(juin|june|jun)$/,
  /^(juillet|juil|july|jul)$/,
  /^(aout|august|aug)$/,
  /^(septembre|sept|september|sep)$/,
  /^(octobre|oct|october)$/,
  /^(novembre|nov|november)$/,
  /^(decembre|dec|december)$/,
];

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDay(words: string[], text: string, raw: string, now: Date, tz: string): string | null {
  const p = localParts(now, tz);
  const today = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const plus = (n: number) => new Date(today.getTime() + n * 86_400_000);
  const isoToday = today.getUTCDay() === 0 ? 7 : today.getUTCDay();

  if (/\b(apres demain|after tomorrow|day after tomorrow)\b/.test(text)) return ymd(plus(2));
  if (/\b(demain|tomorrow|tmrw|tmr)\b/.test(text)) return ymd(plus(1));
  if (/\b(aujourd hui|aujourdhui|today|ce jour)\b/.test(text)) return ymd(today);
  if (/\b(ce week end|ce weekend|this weekend|le week end|weekend|week end)\b/.test(text)) {
    return ymd(plus((6 - isoToday + 7) % 7));
  }

  // "31/10", "31-10", "31.10" — read on the RAW text so "10:30" (a time) is never taken for a date
  const numeric = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/.exec(raw);
  // "31 octobre", "le 31", "october 31"
  for (let i = 0; i < words.length; i++) {
    const day = Number(words[i]);
    const month = i + 1 < words.length ? MONTHS.findIndex((m) => m.test(words[i + 1])) : -1;
    const monthBefore = i > 0 ? MONTHS.findIndex((m) => m.test(words[i - 1])) : -1;
    const m = month >= 0 ? month : monthBefore;
    if (Number.isInteger(day) && day >= 1 && day <= 31 && m >= 0) return futureDate(today, m + 1, day);
  }
  if (numeric) {
    const d = Number(numeric[1]), m = Number(numeric[2]);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) return futureDate(today, m, d);
  }

  for (let i = 0; i < words.length; i++) {
    const wd = WEEKDAYS.find(([, re]) => re.test(words[i]));
    if (!wd) continue;
    const next = /^(prochain|prochaine)$/.test(words[i + 1] ?? "") || words[i - 1] === "next";
    let diff = (wd[0] - isoToday + 7) % 7;
    if (next && diff === 0) diff = 7;
    return ymd(plus(diff));
  }
  const le = /\b(?:le|the) (\d{1,2})(?:er|st|nd|rd|th)?\b/.exec(text);
  if (le) {
    const d = Number(le[1]);
    if (d >= 1 && d <= 31) {
      const thisMonth = futureDate(today, today.getUTCMonth() + 1, d, true);
      return thisMonth ?? futureDate(today, today.getUTCMonth() + 2 > 12 ? 1 : today.getUTCMonth() + 2, d);
    }
  }
  return null;
}

/** The next occurrence of day/month on or after today (this year or next); null for impossible dates. */
function futureDate(today: Date, month: number, day: number, sameMonthOnly = false): string | null {
  for (const year of [today.getUTCFullYear(), today.getUTCFullYear() + 1]) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1) return null; // 31 February
    if (d.getTime() >= today.getTime()) return ymd(d);
    if (sameMonthOnly) return null;
  }
  return null;
}

function parseTime(raw: string): string | null {
  const s = raw.toLowerCase();
  const ampm = /\b(\d{1,2})(?:[:h.](\d{2}))? ?(am|pm)\b/.exec(s);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3] === "pm") h += 12;
    const m = Number(ampm[2] ?? 0);
    return h <= 23 && m <= 59 ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` : null;
  }
  const hm = /\b(\d{1,2}) ?(?:h|:|heures?) ?(\d{2})?\b/.exec(s);
  if (hm) {
    const h = Number(hm[1]), m = Number(hm[2] ?? 0);
    if (h <= 23 && m <= 59) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  return null;
}

function parsePartOfDay(text: string): PartOfDay | null {
  if (/\b(apres midi|aprem|afternoon)\b/.test(text)) return "afternoon";
  if (/\b(soir|soiree|evening|night|nuit)\b/.test(text)) return "evening";
  if (/\b(matin|matinee|morning|tot)\b/.test(text)) return "morning";
  return null;
}

// ---------------------------------------------------------------------------
// Choices: words clients use, by meaning. The owner's choice names are matched to the same meanings,
// written from the salon's point of view ("Vos mèches" = the CLIENT's own hair).
// ---------------------------------------------------------------------------
type Meaning = "own_hair" | "salon_hair" | "short" | "medium_length" | "long" | "jumbo" | "large" | "small";

// What a CLIENT writes
const CLIENT_SAYS: Array<[Meaning, RegExp]> = [
  [
    "own_hair",
    /\b(mes (propres )?meches|mes propres|j apporte|je viens avec|je ramene|my own( hair)?|my hair|own hair|i bring|i will bring|i ll bring)\b/,
  ],
  [
    "salon_hair",
    /\b(vos meches|meches du salon|votre meche|vous fournissez|avec les meches|meches comprises|meches incluses|your hair|salon hair|you provide|hair included|with hair)\b/,
  ],
  ["short", /\b(court|courte|courtes|courts|short|epaule|epaules|shoulder)\b/],
  ["medium_length", /\b(mi long|mi longue|mi longues|mid length|moyenne longueur)\b/],
  ["long", /\b(long|longue|longues|longs|dos|back length|waist)\b/],
  ["jumbo", /\b(jumbo|tres gros|tres grosses)\b/],
  ["large", /\b(large|gros|grosse|grosses|big)\b/],
  ["small", /\b(small|petit|petite|petites|fine|fines|micro)\b/],
];
// What the OWNER wrote as choice names (bot voice)
const OWNER_WROTE: Array<[Meaning, RegExp]> = [
  ["own_hair", /\b(vos meches|vos propres|votre meche|apportees|your own|own hair|client hair|bring your)\b/],
  ["salon_hair", /\b(du salon|salon|fournies|incluses|comprises|included|provided)\b/],
  ["short", /\b(court|courte|courtes|short|epaule|epaules|shoulder)\b/],
  ["medium_length", /\b(mi long|mi longue|mi longues|mid length)\b/],
  ["long", /\b(long|longue|longues|dos|back|waist)\b/],
  ["jumbo", /\bjumbo\b/],
  ["large", /\b(large|gros|grosse|grosses|big)\b/],
  ["small", /\b(small|petit|petite|petites|fine|fines)\b/],
];

function meaningsOf(text: string, table: Array<[Meaning, RegExp]>): Set<Meaning> {
  const out = new Set<Meaning>();
  for (const [m, re] of table) if (re.test(text)) out.add(m);
  if (out.has("medium_length")) out.delete("long"); // "mi-longues" is not "longues"
  // An OWNER's name like "Vos mèches (apportées au salon)" is the client's own hair.
  // A CLIENT who mentions both ("je n'ai pas mes mèches, vous fournissez") is not guessed: the bot asks.
  if (table === OWNER_WROTE && out.has("own_hair")) out.delete("salon_hair");
  return out;
}

function matchChoices(style: CatalogStyle, words: string[], text: string): string[] {
  const said = meaningsOf(text, CLIENT_SAYS);
  const picked: string[] = [];
  for (const group of style.groups) {
    const hits = new Set<string>();
    // 1. the choice's own name typed by the client ("Medium", "Jumbo", "Small")
    for (const c of group.choices) {
      for (const name of [c.name, c.nameEn]) {
        const phrase = tokens(normalize(name ?? ""));
        // skip names that are only a pronoun + "meches" ("Vos mèches"): handled by meaning below
        if (phrase.length && !/^(vos|votre|your|du|de)$/.test(phrase[0]) && findPhrase(words, phrase) >= 0) {
          hits.add(c.id);
        }
      }
    }
    // 2. same meaning ("mes propres mèches" -> the owner's "Vos mèches")
    if (hits.size === 0) {
      for (const c of group.choices) {
        const owner = meaningsOf(normalize(`${c.name} ${c.nameEn ?? ""}`), OWNER_WROTE);
        if ([...owner].some((m) => said.has(m))) hits.add(c.id);
      }
    }
    if (hits.size === 1) picked.push([...hits][0]); // ambiguous within a group: ask instead of guessing
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
interface StyleScore {
  id: string;
  score: number; // number of words matched by the best phrase
}

function scoreStyles(catalog: CatalogStyle[], words: string[]): { best: StyleScore[]; categoryHits: string[] } {
  const scores: StyleScore[] = [];
  const categoryHits = new Set<string>();
  for (const s of catalog) {
    let score = 0;
    const phrases = [s.name, s.nameEn, ...s.aliases].filter(Boolean) as string[];
    for (const ph of phrases) {
      const t = tokens(normalize(ph));
      if (t.length && findPhrase(words, t) >= 0) score = Math.max(score, t.length * 10 + t.join("").length);
    }
    for (const cat of [s.category, s.categoryEn]) {
      const t = tokens(normalize(cat ?? ""));
      if (t.length && findPhrase(words, t) >= 0) categoryHits.add(normalize(s.category));
    }
    if (score > 0) scores.push({ id: s.id, score });
  }
  scores.sort((a, b) => b.score - a.score);
  const top = scores.length ? scores[0].score : 0;
  return { best: scores.filter((x) => x.score === top), categoryHits: [...categoryHits] };
}

// Words that carry no request content (used to decide "asked for something we don't offer")
const FILLER = new Set([
  ..."bonjour bonsoir salut hello hi hey svp sil vous plait please merci thanks thank je j tu vous nous on il elle c est ce cette ces le la les l un une des de du d a au aux en et ou mais pour avec sans sur dans par pas ne n que qu qui quoi quel quelle quels quelles combien prix tarif tarifs cout coute how much price cost is the a an of for with my your i you we can could would like want voudrais veux voulais peux pourrais faire fais do does did passer venir come book rdv rendez appointment reserver disponible dispo libre available free demain aujourd hui today tomorrow matin soir apres midi morning afternoon evening samedi dimanche lundi mardi mercredi jeudi vendredi saturday sunday monday tuesday wednesday thursday friday h heure heures am pm svp stp please ok oui yes non no there here what when where moi me mon ma mes propres meches meche own hair bring apporte coiffure coiffer hairstyle style service services prestation prestations faites faire fait offrez proposez offer have avez as cher comme genre type quoi aimerais souhaite souhaiterais besoin voir savoir chez salon ici combines combie vos votre nos notre leur leurs sont est etes suis ont bien bon bonne pas encore aussi also too still just juste svp"
    .split(" "),
]);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export function understand(raw: string, catalog: CatalogStyle[], now: Date, timeZone: string): Understanding {
  const text = normalizeClient(raw);
  const words = tokens(text);
  const result: Understanding = {
    intent: "unknown",
    asksPrice: hasAny(text, PRICE),
    styleId: null,
    styleCandidates: [],
    choiceIds: [],
    day: null,
    partOfDay: null,
    time: null,
    language: detectLanguage(words),
    noMatch: false,
  };
  if (!text) return result;

  for (const [intent, re] of EXACT) {
    if (re.test(text)) {
      result.intent = intent;
      // "hello / hi" are used by French speakers too: only clearly English greetings set the language
      if (intent === "greeting") result.language = /^(good|morning|how|hello how)/.test(text) ? "en" : null;
      return result;
    }
  }

  // catalogue
  const { best, categoryHits } = scoreStyles(catalog, words);
  if (best.length === 1) result.styleId = best[0].id;
  else if (best.length > 1) result.styleCandidates = best.map((b) => b.id);
  else if (categoryHits.length) {
    const inCategory = catalog.filter((s) => categoryHits.includes(normalize(s.category)));
    if (inCategory.length === 1) result.styleId = inCategory[0].id;
    else result.styleCandidates = inCategory.map((s) => s.id);
  }
  // several styles share the top score: the choice words may decide ("tresses longues" -> "Longues")
  if (!result.styleId && result.styleCandidates.length > 1) {
    const said = meaningsOf(text, CLIENT_SAYS);
    const narrowed = catalog.filter((s) =>
      result.styleCandidates.includes(s.id) &&
      [...meaningsOf(normalize(`${s.name} ${s.nameEn ?? ""}`), OWNER_WROTE)].some((m) => said.has(m))
    );
    if (narrowed.length === 1) {
      result.styleId = narrowed[0].id;
      result.styleCandidates = [];
    }
  }
  const style = catalog.find((s) => s.id === result.styleId);
  if (style) result.choiceIds = matchChoices(style, words, text);

  // when
  result.day = parseDay(words, text, raw, now, timeZone);
  result.time = parseTime(raw);
  result.partOfDay = result.time ? null : parsePartOfDay(text);

  // what they want
  if (HUMAN.test(text)) result.intent = "human";
  else if (RESCHEDULE.test(text)) result.intent = "reschedule";
  else if (MINE.test(text)) result.intent = "mine";
  else if (SERVICES.test(text) && !result.styleId && !result.styleCandidates.length) result.intent = "services";
  else if (result.asksPrice) result.intent = "price";
  else if (
    ASK_SERVICE.test(text) || BOOK.test(text) || result.day || result.time || result.styleId ||
    result.styleCandidates.length
  ) {
    result.intent = "book";
  } else if (GREETING_START.test(text)) result.intent = "greeting";

  // asked for something the salon doesn't list? Only when the client NAMES a thing in a question about
  // it ("vous faites les vanilles ?", "combien la pédicure ?"); "je veux prendre rendez-vous pour ma fille"
  // is a booking wish, never "we don't offer that".
  if (
    (result.intent === "price" || (result.intent === "book" && ASK_SERVICE.test(text))) &&
    !result.styleId && !result.styleCandidates.length
  ) {
    const content = words.filter((w) =>
      !FILLER.has(w) && !/^\d+$/.test(w) && !/^\d+h\d*$/.test(w) &&
      !WEEKDAYS.some(([, re]) => re.test(w)) && !MONTHS.some((re) => re.test(w)) && w.length > 2
    );
    result.noMatch = content.length > 0;
  }
  return result;
}
