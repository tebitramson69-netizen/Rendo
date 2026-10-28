// Rendo M3.6 — the booking conversation.
//
// Input: one client event (typed text or a tapped button/list row) + the client's conversation.
// Output: the messages to send, the alerts for the owner, and the updated conversation.
// It reads/writes the database ONLY through the Repo interface, so it is tested with a fake repo.
//
// How a booking moves forward — a DRAFT that fills up step by step:
//   style -> one choice per group (Taille, Longueur, Mèches...) -> day -> time -> summary -> confirmed
// A typed message ("knotless longues avec mes mèches samedi matin") can fill several steps at once
// (see understand.ts); the bot then asks ONLY for what is still missing.
//
// Design rules:
//   * Prices come from the catalogue, times from the real calendar, and "confirmé" only after the database
//     accepted the booking. Nothing is ever invented.
//   * Every tap carries its whole draft in its id ("tm:<style>:<choices>:<startMs>") and is re-checked
//     against FRESH data. Old buttons tapped hours later never book something wrong.
//   * Typed text is never stored nor echoed. No medical data: only labels chosen by the business.
import { availableSlots, type Slot } from "./availability.ts";
import type {
  Business,
  ChoiceGroup,
  Client,
  ContextValue,
  Conversation,
  Lang,
  Repo,
  Service,
  ServiceChoice,
  UpcomingAppointment,
} from "./domain.ts";
import {
  categoryTitle,
  dayLabel,
  inSentence,
  localDateOf,
  longDay,
  noteOf,
  phoneLabel,
  priceLabel,
  serviceFullName,
  serviceTitle,
  TEXTS,
  type Texts,
  timeLabel,
  whenLabel,
} from "./i18n.ts";
import { type Button, buttons, list, type ListRow, type Outbound, type OwnerAlert, text } from "./outbound.ts";
import { type CatalogStyle, normalize as normalizeText, normalizeClient, type PartOfDay, understand } from "./understand.ts";
import { firstName } from "./whatsapp.ts";

export const FLOW_TTL_MS = 2 * 60 * 60 * 1000; // an unfinished flow is forgotten after 2 h
export const HANDOFF_COOLDOWN_MS = 6 * 60 * 60 * 1000; // owner alerted at most once per 6 h per client
export const UNKNOWN_BEFORE_HUMAN = 3; // after 3 messages in a row we don't understand, offer a person
export const MAX_UPCOMING_PER_CLIENT = 3; // one client cannot block a whole day
export const MAX_GROUPS = 3; // questions asked per style (tap ids carry at most 3 choices)
const DAY_MS = 86_400_000;
const PAGE = 10; // WhatsApp list rows

export type BotEvent =
  | { type: "text"; text: string }
  | { type: "choice"; id: string } // id of a tapped reply button or list row
  | { type: "other" }; // e.g. a template quick-reply (handled in M4)

export interface BotInput {
  business: Business;
  client: Client;
  conversation: Conversation;
  event: BotEvent;
  now: Date;
}

export interface BotResult {
  replies: Outbound[];
  alerts: OwnerAlert[];
  conversation: Conversation;
}

type Screen =
  | "idle"
  | "menu"
  | "services"
  | "variants"
  | "options"
  | "days"
  | "times"
  | "confirm"
  | "appointments"
  | "appointment";

export { normalizeText as normalize };

/** Keyword view of a typed message (kept for compatibility; the bot itself uses understand()). */
export function intentOf(raw: string) {
  const i = understand(raw, [], new Date(0), "UTC").intent;
  return i === "greeting" ? "menu" : i === "price" ? "book" : i;
}

// ---------------------------------------------------------------------------
// Tap ids. Everything needed is inside the id, and it is fully validated before use.
//   choices are written "c1.c2.c3" or "-" when none
// ---------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS = /^\d{12,14}$/;
const PART = /^(morning|afternoon|evening|-)$/;

export interface DraftIds {
  sid: string;
  choices: string[];
}

type Choice =
  | { kind: "menu" | "book" | "mine" | "human" }
  | { kind: "page"; offset: number }
  | { kind: "category"; sid: string }
  | { kind: "style"; draft: DraftIds } // style chosen, or one more choice added
  | { kind: "day"; draft: DraftIds; date: string; part: PartOfDay | null }
  | { kind: "more"; draft: DraftIds; date: string; after: number }
  | { kind: "time"; draft: DraftIds; start: number }
  | { kind: "confirm"; draft: DraftIds; start: number }
  | { kind: "appointment" | "cancel" | "keep"; aid: string }
  | { kind: "invalid" };

const enc = (d: DraftIds) => `${d.sid}:${d.choices.length ? d.choices.join(".") : "-"}`;

export const ids = {
  menu: "m:menu",
  book: "m:book",
  mine: "m:mine",
  human: "m:human",
  page: (offset: number) => `pg:${offset}`,
  /** A category, identified by one of its styles (always re-read fresh). */
  category: (sid: string) => `cat:${sid}`,
  style: (d: DraftIds) => `st:${enc(d)}`,
  day: (d: DraftIds, date: string, part: PartOfDay | null = null) => `dy:${enc(d)}:${date}:${part ?? "-"}`,
  more: (d: DraftIds, date: string, after: number) => `mr:${enc(d)}:${date}:${after}`,
  time: (d: DraftIds, start: number) => `tm:${enc(d)}:${start}`,
  confirm: (d: DraftIds, start: number) => `ok:${enc(d)}:${start}`,
  appointment: (aid: string) => `a:${aid}`,
  cancel: (aid: string) => `x:${aid}`,
  keep: (aid: string) => `k:${aid}`,
  // kept for buttons sent before M3.6 (still in clients' chats)
  service: (sid: string) => `st:${sid}:-`,
  group: (sid: string) => `cat:${sid}`,
};

export function parseChoice(id: string): Choice {
  const p = id.split(":");
  const uuid = (v: string | undefined) => v !== undefined && UUID.test(v);
  const draft = (sid: string | undefined, ch: string | undefined): DraftIds | null => {
    if (!uuid(sid) || ch === undefined) return null;
    if (ch === "-") return { sid: sid!, choices: [] };
    const list = ch.split(".");
    return list.length <= MAX_GROUPS && list.every((c) => UUID.test(c)) ? { sid: sid!, choices: list } : null;
  };
  switch (p[0]) {
    case "m":
      if (p.length === 2 && ["menu", "book", "mine", "human"].includes(p[1])) {
        return { kind: p[1] as "menu" | "book" | "mine" | "human" };
      }
      break;
    case "pg":
      if (p.length === 2 && /^\d{1,3}$/.test(p[1])) return { kind: "page", offset: Number(p[1]) };
      break;
    case "cat":
    case "g": // before M3.6
      if (p.length === 2 && uuid(p[1])) return { kind: "category", sid: p[1] };
      break;
    case "st": {
      const d = draft(p[1], p[2]);
      if (p.length === 3 && d) return { kind: "style", draft: d };
      break;
    }
    case "s": // before M3.6
      if (p.length === 2 && uuid(p[1])) return { kind: "style", draft: { sid: p[1], choices: [] } };
      break;
    case "dy": {
      const d = draft(p[1], p[2]);
      if (p.length === 5 && d && DATE.test(p[3]) && PART.test(p[4])) {
        return { kind: "day", draft: d, date: p[3], part: p[4] === "-" ? null : p[4] as PartOfDay };
      }
      break;
    }
    case "d": // before M3.6
      if (p.length === 3 && uuid(p[1]) && DATE.test(p[2])) {
        return { kind: "day", draft: { sid: p[1], choices: [] }, date: p[2], part: null };
      }
      break;
    case "mr": {
      const d = draft(p[1], p[2]);
      if (p.length === 5 && d && DATE.test(p[3]) && MS.test(p[4])) {
        return { kind: "more", draft: d, date: p[3], after: Number(p[4]) };
      }
      break;
    }
    case "tm":
    case "ok": {
      const d = draft(p[1], p[2]);
      if (p.length === 4 && d && MS.test(p[3])) {
        return { kind: p[0] === "tm" ? "time" : "confirm", draft: d, start: Number(p[3]) };
      }
      break;
    }
    case "t": // before M3.6
    case "c":
      if (p.length === 3 && uuid(p[1]) && MS.test(p[2])) {
        return { kind: p[0] === "t" ? "time" : "confirm", draft: { sid: p[1], choices: [] }, start: Number(p[2]) };
      }
      break;
    case "a":
    case "x":
    case "k":
      if (p.length === 2 && uuid(p[1])) {
        return { kind: p[0] === "a" ? "appointment" : p[0] === "x" ? "cancel" : "keep", aid: p[1] };
      }
      break;
  }
  return { kind: "invalid" };
}

/** Template parameters may not contain line breaks, tabs or long runs of spaces. */
export function templateParam(value: string, max = 60): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return Array.from(clean).slice(0, max).join("") || "-";
}

// ---------------------------------------------------------------------------
// A validated draft: the style, its questions and the choices made so far
// ---------------------------------------------------------------------------
interface Draft {
  service: Service;
  groups: ChoiceGroup[]; // at most MAX_GROUPS
  picked: Map<string, ServiceChoice>; // group id -> choice
}

function makeDraft(service: Service, choiceIds: string[]): Draft | null {
  const groups = service.groups.slice(0, MAX_GROUPS);
  const picked = new Map<string, ServiceChoice>();
  for (const cid of choiceIds) {
    const group = groups.find((g) => g.choices.some((c) => c.id === cid));
    if (!group || picked.has(group.id)) return null; // unknown, inactive, or two in one group
    picked.set(group.id, group.choices.find((c) => c.id === cid)!);
  }
  return { service, groups, picked };
}

const draftIds = (d: Draft): DraftIds => ({
  sid: d.service.id,
  choices: d.groups.filter((g) => d.picked.has(g.id)).map((g) => d.picked.get(g.id)!.id),
});
const nextGroup = (d: Draft) => d.groups.find((g) => !d.picked.has(g.id)) ?? null;
const pickedList = (d: Draft) => d.groups.filter((g) => d.picked.has(g.id)).map((g) => d.picked.get(g.id)!);
const minutesOf = (d: Draft, extra?: ServiceChoice) =>
  Math.max(5, d.service.durationMinutes + pickedList(d).reduce((m, c) => m + c.durationAddMinutes, 0) +
    (extra?.durationAddMinutes ?? 0));
/** Base price + chosen additions (null when there is no price or it is set on site). */
const priceOf = (d: Draft, extra?: ServiceChoice) =>
  d.service.priceXaf === null || d.service.priceMode === "on_site"
    ? null
    : Math.max(0, d.service.priceXaf + pickedList(d).reduce((p, c) => p + c.priceAddXaf, 0) + (extra?.priceAddXaf ?? 0));

/** Catalogue as understand() needs it. */
function toCatalog(services: Service[]): CatalogStyle[] {
  return services.map((s) => ({
    id: s.id,
    name: s.name,
    nameEn: s.nameEn,
    category: s.category,
    categoryEn: s.categoryEn,
    aliases: s.aliases,
    groups: s.groups.slice(0, MAX_GROUPS).map((g) => ({
      id: g.id,
      name: g.name,
      nameEn: g.nameEn,
      choices: g.choices.map((c) => ({ id: c.id, name: c.name, nameEn: c.nameEn })),
    })),
  }));
}

const PARTS: Record<PartOfDay, [number, number]> = { morning: [0, 12], afternoon: [12, 17], evening: [17, 24] };
/** Steps of a booking in progress (a side question there is answered, then the booking continues). */
const BOOKING_STEPS = ["options", "days", "times", "confirm"];
/** "Annuler" alone while booking = stop this booking (not: cancel an appointment already confirmed). */
const STOP_BOOKING = /^(annuler|cancel|arreter|arrete|laisse tomber|laissez tomber|j annuler|je annuler|non merci)$/;

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------
export async function runBot(input: BotInput, repo: Repo): Promise<BotResult> {
  const { business, client, event, now } = input;
  let lang: Lang = client.language;
  const replies: Outbound[] = [];
  const alerts: OwnerAlert[] = [];
  const conv: Conversation = { ...input.conversation, context: { ...input.conversation.context } };
  const t = (): Texts => TEXTS[lang];
  const tz = business.timezone;
  const clientName = client.displayName?.trim() ? templateParam(client.displayName) : "Client WhatsApp";

  const expired = conv.isNew || conv.state === "idle" ||
    (conv.expiresAt !== null && conv.expiresAt.getTime() <= now.getTime());
  const unknownCount = expired ? 0 : Number(conv.context.unknown ?? 0);
  // Prices: the salon decides (businesses.price_display). "on_request" shows them once the client has asked
  // in this flow, and always in the summary before Confirmer.
  let pricesAsked = !expired && conv.context.pr === true;
  const listPrices = () =>
    business.priceDisplay === "always" || (business.priceDisplay === "on_request" && pricesAsked);
  const neverPrices = business.priceDisplay === "never";

  let screen: Screen = "idle";
  let context: Record<string, ContextValue> = {};
  const go = (s: Screen, ctx: Record<string, ContextValue> = {}) => {
    screen = s;
    context = ctx;
  };
  const draftContext = (d: Draft, extra: Record<string, ContextValue> = {}) => {
    const di = draftIds(d);
    return { sid: di.sid, ch: di.choices.join(".") || "-", ...extra };
  };
  const withPrefix = (prefix: string[], body: string) => [...prefix, body].filter(Boolean).join("\n\n");

  // ----- catalogue and calendar ---------------------------------------------
  let catalogCache: Service[] | null = null;
  const catalog = async () => (catalogCache ??= await repo.activeServices(business.id));
  const findService = async (sid: string) => (await catalog()).find((s) => s.id === sid) ?? null;
  const draftFrom = async (ids: DraftIds) => {
    const service = await findService(ids.sid);
    return service ? makeDraft(service, ids.choices) : null;
  };

  const freeSlots = async (d: Draft): Promise<Slot[]> => {
    const to = new Date(now.getTime() + (business.horizonDays + 1) * DAY_MS);
    const data = await repo.availabilityData(business.id, now, to);
    return availableSlots({
      rules: {
        timezone: tz,
        slotMinutes: business.slotMinutes,
        bufferMinutes: business.bufferMinutes,
        horizonDays: business.horizonDays,
        minNoticeMinutes: business.minNoticeMinutes,
      },
      serviceMinutes: minutesOf(d),
      ...data,
      chairs: business.chairs,
      now,
    });
  };

  // ----- labels ---------------------------------------------------------------
  const choiceName = (c: ServiceChoice) => lang === "en" && c.nameEn ? c.nameEn : c.name;
  const groupName = (g: ChoiceGroup) => lang === "en" && g.nameEn ? g.nameEn : g.name;
  /** "Tresses – Knotless (Medium, Dos)" */
  const draftName = (d: Draft, l: Lang = lang) => {
    const names = pickedList(d).map((c) => l === "en" && c.nameEn ? c.nameEn : c.name);
    return serviceFullName(d.service, l) + (names.length ? ` (${names.join(", ")})` : "");
  };
  /** Short price: "3 000 FCFA", "dès 20 000 FCFA", "prix sur place"; null = no price shown. */
  const priceShortOf = (d: Draft, extra?: ServiceChoice, open = false) => {
    if (d.service.priceMode === "on_site") return lang === "fr" ? "prix sur place" : "price on site";
    const p = priceOf(d, extra);
    if (p === null) return null;
    const from = d.service.priceMode === "from" || open;
    return from ? (lang === "fr" ? `dès ${priceLabel(p, lang)}` : `from ${priceLabel(p, lang)}`) : priceLabel(p, lang);
  };
  /** Summary price: "3 000 FCFA", "à partir de 24 000 FCFA", "confirmé sur place", "à convenir au salon". */
  const priceLongOf = (d: Draft) => {
    if (neverPrices) return t().priceAtSalon;
    if (d.service.priceMode === "on_site") return lang === "fr" ? "confirmé sur place" : "confirmed on site";
    const p = priceOf(d);
    if (p === null) return null;
    return d.service.priceMode === "from"
      ? (lang === "fr" ? `à partir de ${priceLabel(p, lang)}` : `from ${priceLabel(p, lang)}`)
      : priceLabel(p, lang);
  };
  /** List row description: the price when prices are shown, otherwise nothing (durations are never shown). */
  const styleDesc = (s: Service) => (listPrices() ? priceShortOf(makeDraft(s, [])!, undefined, s.groups.length > 0) ?? undefined : undefined);

  /** "Chez nous : coiffure (coupe, brushing), tresses (knotless, box braids), manucure et conseil beauté." */
  const offerSentence = async (): Promise<string | null> => {
    const all = await catalog();
    if (all.length === 0) return null;
    const byCategory = new Map<string, Service[]>();
    for (const sv of all) {
      const key = sv.category ? `c:${sv.category}` : `s:${sv.id}`;
      byCategory.set(key, [...(byCategory.get(key) ?? []), sv]);
    }
    const items = [...byCategory.values()].slice(0, 6).map((g) => {
      if (!g[0].category) return inSentence(serviceTitle(g[0], lang));
      const names = g.slice(0, 4).map((x) => inSentence(serviceTitle(x, lang)));
      if (g.length > 4) names.push("…");
      return `${inSentence(categoryTitle(g[0], lang))} (${names.join(", ")})`;
    });
    if (byCategory.size > 6) items.push(t().andMore);
    return t().weOffer(items);
  };

  // ----- screens -------------------------------------------------------------
  const menu = async (greet: boolean, prefix: string[] = [], question?: string) => {
    const lines = [...prefix];
    if (greet) lines.push(t().greeting(firstName(client.displayName ?? ""), business.name));
    if (greet || question) {
      const offer = await offerSentence();
      if (offer) lines.push(offer);
      lines.push(question ?? t().askOpen);
    } else lines.push(t().menuQuestion);
    replies.push(buttons(lines.join("\n\n"), [
      { id: ids.book, title: t().btnBook },
      { id: ids.mine, title: t().btnMine },
      { id: ids.human, title: t().btnHuman },
    ], t().menuFooter));
    go("menu");
  };

  const menuButtons = (body: string, first: Button) => {
    replies.push(buttons(body, [first, { id: ids.menu, title: t().btnMenu }]));
    go("menu");
  };

  /** Top-level list: styles without a category + one row per category; 10 rows per page. */
  const services = async (prefix: string[] = [], offset = 0) => {
    const all = await catalog();
    if (all.length === 0) {
      return menuButtons(withPrefix(prefix, t().noServices(business.name)), { id: ids.human, title: t().btnHuman });
    }
    const groups = new Map<string, Service[]>();
    for (const sv of all) {
      const key = sv.category ? `c:${sv.category}` : `s:${sv.id}`;
      groups.set(key, [...(groups.get(key) ?? []), sv]);
    }
    const entries = [...groups.values()];
    const start = Math.min(offset, Math.max(0, entries.length - 1));
    const hasMore = entries.length - start > PAGE;
    const page = entries.slice(start, start + (hasMore ? PAGE - 1 : PAGE));
    const rows: ListRow[] = page.map((g) => {
      if (g.length === 1) {
        return { id: ids.style({ sid: g[0].id, choices: [] }), title: serviceFullName(g[0], lang), description: styleDesc(g[0]) };
      }
      const prices = g.filter((x) => x.priceMode !== "on_site" && x.priceXaf !== null).map((x) => x.priceXaf!);
      const from = prices.length && listPrices()
        ? (lang === "fr" ? `dès ${priceLabel(Math.min(...prices), lang)}` : `from ${priceLabel(Math.min(...prices), lang)}`)
        : null;
      return {
        id: ids.category(g[0].id),
        title: categoryTitle(g[0], lang),
        description: [t().variantsCount(g.length), from].filter(Boolean).join(" · "),
      };
    });
    if (hasMore) rows.push({ id: ids.page(start + PAGE - 1), title: t().moreServices, description: t().moreServicesDesc });
    replies.push(list(withPrefix(prefix, t().chooseService(business.name)), t().listButtonServices, t().sectionServices, rows));
    go("services", { off: start });
  };

  /** A short list of styles to choose from (category tapped, or several styles matched a typed request). */
  const styleList = (styles: Service[], body: string, prefix: string[] = []) => {
    const rows: ListRow[] = styles.slice(0, PAGE).map((x) => ({
      id: ids.style({ sid: x.id, choices: [] }),
      title: x.category && styles.every((y) => y.category === x.category) ? serviceTitle(x, lang) : serviceFullName(x, lang),
      description: styleDesc(x),
    }));
    replies.push(list(withPrefix(prefix, body), t().listButtonVariants, t().sectionVariants, rows));
    go("variants", { sids: styles.slice(0, PAGE).map((x) => x.id).join(".") });
  };

  const category = async (anyOfGroup: Service, prefix: string[] = []) => {
    const all = (await catalog()).filter((x) => x.category === anyOfGroup.category);
    if (!anyOfGroup.category || all.length <= 1) {
      return all.length ? proceed(makeDraft(all[0], [])!, {}, prefix) : services([t().serviceUnavailable]);
    }
    styleList(all, t().chooseVariant(categoryTitle(anyOfGroup, lang)), prefix);
  };

  /** Ask the next question of the style (Taille, Longueur, Mèches...), with the price of each answer. */
  type When = { day?: string | null; part?: PartOfDay | null; time?: string | null };
  const askGroup = (d: Draft, g: ChoiceGroup, prefix: string[] = [], when: When = {}) => {
    const more = d.groups.some((x) => x.id !== g.id && !d.picked.has(x.id)); // other questions still to come
    const priceFor = (c: ServiceChoice) => (listPrices() ? priceShortOf(d, c, more) : null);
    const lines = g.choices.slice(0, PAGE).flatMap((c) => {
      const p = priceFor(c);
      return p ? [t().optionLine(choiceName(c), p)] : [];
    });
    const body = withPrefix(prefix, t().chooseOption(draftName(d), groupName(g)));
    const idFor = (c: ServiceChoice) => ids.style({ sid: d.service.id, choices: [...draftIds(d).choices, c.id] });
    if (g.choices.length <= 3) {
      replies.push(buttons(withPrefix([body], lines.join("\n")), g.choices.map((c) => ({ id: idFor(c), title: choiceName(c) }))));
    } else {
      replies.push(list(
        body,
        t().listButtonVariants,
        groupName(g),
        g.choices.slice(0, PAGE).map((c) => ({
          id: idFor(c),
          title: choiceName(c),
          description: priceFor(c) ?? undefined,
        })),
      ));
    }
    // remember the day/time the client already gave ("samedi matin"), for after the last question
    go("options", draftContext(d, { day: when.day ?? null, part: when.part ?? null, time: when.time ?? null }));
  };

  const days = async (d: Draft, prefix: string[] = []) => {
    const slots = await freeSlots(d);
    const byDay = new Map<string, number>();
    for (const s of slots) byDay.set(s.localDate, (byDay.get(s.localDate) ?? 0) + 1);
    if (byDay.size === 0) {
      return menuButtons(
        withPrefix(prefix, t().noDays(draftName(d), business.horizonDays)),
        { id: ids.human, title: t().btnHuman },
      );
    }
    const today = localDateOf(now, tz);
    const rows: ListRow[] = [...byDay].slice(0, PAGE).map(([date, n]) => ({
      id: ids.day(draftIds(d), date),
      title: dayLabel(date, today, lang),
      description: t().freeSlots(n),
    }));
    replies.push(list(withPrefix(prefix, t().chooseDay(draftName(d))), t().listButtonDays, t().sectionDays, rows));
    go("days", draftContext(d));
  };

  const inPart = (s: Slot, part: PartOfDay) => {
    const h = Number(s.localTime.slice(0, 2));
    return h >= PARTS[part][0] && h < PARTS[part][1];
  };

  const times = async (
    d: Draft,
    date: string,
    opts: { after?: number | null; part?: PartOfDay | null; prefix?: string[] } = {},
  ) => {
    const prefix = [...(opts.prefix ?? [])];
    const ofDay = (await freeSlots(d)).filter((s) => s.localDate === date);
    if (ofDay.length === 0) return days(d, [...prefix, t().dayFull(longDay(date, lang))]);
    let slots = ofDay.filter((s) => opts.after == null || s.start.getTime() > opts.after);
    if (slots.length === 0) slots = ofDay; // the "later" page vanished: start over
    if (opts.part) {
      const inside = slots.filter((s) => inPart(s, opts.part!));
      if (inside.length) slots = inside;
      else prefix.push(t().partNone(opts.part));
    }
    const page = slots.length > PAGE ? slots.slice(0, PAGE - 1) : slots;
    const rows: ListRow[] = page.map((s) => ({
      id: ids.time(draftIds(d), s.start.getTime()),
      title: timeLabel(s.start, tz, lang),
    }));
    if (page.length < slots.length) {
      rows.push({ id: ids.more(draftIds(d), date, page[page.length - 1].start.getTime()), title: t().later, description: t().laterDesc });
    }
    const body = withPrefix(prefix, t().chooseTime(draftName(d), dayLabel(date, localDateOf(now, tz), lang)));
    replies.push(list(body, t().listButtonTimes, t().sectionTimes, rows));
    go("times", draftContext(d, { date }));
  };

  const stillFree = async (d: Draft, start: number) =>
    (await freeSlots(d)).find((s) => s.start.getTime() === start) ?? null;

  const confirm = async (d: Draft, start: number, prefix: string[] = []) => {
    const slot = await stillFree(d, start);
    if (!slot) return times(d, localDateOf(new Date(start), tz), { prefix: [...prefix, t().slotGone] });
    const body = t().confirmQuestion(
      draftName(d),
      whenLabel(slot.start, tz, lang),
      business.name,
      priceLongOf(d),
      noteOf(d.service, lang),
    );
    replies.push(buttons(withPrefix(prefix, body), [
      { id: ids.confirm(draftIds(d), start), title: t().btnConfirm },
      { id: ids.day(draftIds(d), slot.localDate), title: t().btnChangeTime },
      { id: ids.menu, title: t().btnCancelFlow },
    ]));
    go("confirm", draftContext(d, { start }));
  };

  /**
   * Moves the draft forward: next unanswered question, then the day, then the time.
   * `when` comes from a typed message ("samedi matin", "demain 14h").
   */
  const proceed = async (d: Draft, when: When, prefix: string[] = []): Promise<void> => {
    const g = nextGroup(d);
    if (g) return askGroup(d, g, prefix, when);
    if (!when.day) return days(d, prefix);
    if (when.time) {
      const wanted = (await freeSlots(d)).find((s) => s.localDate === when.day && s.localTime === when.time);
      if (wanted) return confirm(d, wanted.start.getTime(), [...prefix, t().timeFree(whenLabel(wanted.start, tz, lang))]);
      const label = lang === "fr" ? when.time.replace(/^0/, "").replace(":", "h") : when.time;
      return times(d, when.day, { prefix: [...prefix, t().timeTaken(label)] });
    }
    return times(d, when.day, { part: when.part ?? null, prefix });
  };

  const book = async (d: Draft, start: number) => {
    const date = localDateOf(new Date(start), tz);
    const upcoming = await repo.upcomingForClient(client.id, now);
    // tapped "Confirmer" again for an appointment that is already booked
    const same = upcoming.find((a) => a.serviceId === d.service.id && a.startsAt.getTime() === start);
    if (same) {
      replies.push(text(t().alreadyBooked(same.bookingCode)));
      return go("idle");
    }
    if (upcoming.length >= MAX_UPCOMING_PER_CLIENT) {
      return menuButtons(t().tooMany(upcoming.length), { id: ids.mine, title: t().btnMine });
    }
    if (nextGroup(d)) return askGroup(d, nextGroup(d)!); // a question was skipped: ask it
    // Opening hours / notice / chairs are re-checked here; the database guarantees "no overlap per chair".
    const slot = await stillFree(d, start);
    if (!slot) return times(d, date, { prefix: [t().slotGone] });
    const result = await repo.book(business.id, client.id, d.service.id, slot.start, draftIds(d).choices);
    if (result.status === "slot_taken") return times(d, date, { prefix: [t().slotTaken] });
    if (result.status === "invalid") return menu(false, [t().bookingFailed]);
    const price = neverPrices || d.service.priceMode === "on_site"
      ? priceLongOf(d)
      : result.estimateXaf === null
      ? null
      : d.service.priceMode === "from"
      ? (lang === "fr" ? `à partir de ${priceLabel(result.estimateXaf, lang)}` : `from ${priceLabel(result.estimateXaf, lang)}`)
      : priceLabel(result.estimateXaf, lang);
    replies.push(text(t().booked(
      draftName(d),
      whenLabel(result.startsAt, tz, lang),
      business.name,
      result.bookingCode,
      price,
    )));
    alerts.push({
      template: "rendo_nouveau_rdv",
      language: "fr",
      params: [
        clientName,
        templateParam(draftName(d, "fr")),
        templateParam(whenLabel(result.startsAt, tz, "fr")),
        client.phone ? phoneLabel(client.phone) : "non communiqué",
        result.bookingCode,
      ],
    });
    go("idle");
  };

  // ----- my appointments -------------------------------------------------------
  const apptName = (a: UpcomingAppointment) =>
    serviceFullName(a.service, lang) + (a.choiceNames.length ? ` (${a.choiceNames.join(", ")})` : "");

  const myAppointments = async (prefix: string[] = []) => {
    const upcoming = await repo.upcomingForClient(client.id, now);
    if (upcoming.length === 0) {
      return menuButtons(t().noUpcoming, { id: ids.book, title: t().btnBook });
    }
    const today = localDateOf(now, tz);
    const rows: ListRow[] = upcoming.slice(0, PAGE).map((a) => ({
      id: ids.appointment(a.id),
      title: `${dayLabel(localDateOf(a.startsAt, tz), today, lang)} · ${timeLabel(a.startsAt, tz, lang)}`,
      description: `${apptName(a)} · ${a.bookingCode}`,
    }));
    replies.push(list(withPrefix(prefix, t().chooseAppointment), t().listButtonAppointments, t().sectionAppointments, rows));
    go("appointments");
  };

  const ownUpcoming = async (aid: string): Promise<UpcomingAppointment | null> =>
    (await repo.upcomingForClient(client.id, now)).find((a) => a.id === aid) ?? null;

  const appointment = async (aid: string) => {
    const a = await ownUpcoming(aid);
    if (!a) return menu(false, [t().cancelNotFound]);
    replies.push(
      buttons(t().appointmentDetail(apptName(a), whenLabel(a.startsAt, tz, lang), a.bookingCode), [
        { id: ids.cancel(a.id), title: t().btnCancelAppointment },
        { id: ids.keep(a.id), title: t().btnKeep },
      ]),
    );
    go("appointment", { aid });
  };

  const cancel = async (aid: string) => {
    const a = await ownUpcoming(aid); // details for the messages, and ownership check
    if (!a || (await repo.cancelByClient(aid, client.id, now)) !== "cancelled") {
      return menu(false, [t().cancelNotFound]);
    }
    replies.push(text(t().cancelled(apptName(a), whenLabel(a.startsAt, tz, lang))));
    alerts.push({
      template: "rendo_annulation_rdv",
      language: "fr",
      params: [
        clientName,
        templateParam(serviceFullName(a.service, "fr") + (a.choiceNames.length ? ` (${a.choiceNames.join(", ")})` : "")),
        templateParam(whenLabel(a.startsAt, tz, "fr")),
        a.bookingCode,
      ],
    });
    go("idle");
  };

  // ----- talk to a person ------------------------------------------------------
  const handoff = () => {
    const recent = conv.handoffRequestedAt !== null &&
      now.getTime() - conv.handoffRequestedAt.getTime() < HANDOFF_COOLDOWN_MS;
    const callUs = business.contactPhone ? t().handoffCallUs(business.name, phoneLabel(business.contactPhone)) : null;
    let body: string;
    if (recent) {
      body = t().handoffAlready;
    } else if (client.phone) {
      alerts.push({ template: "rendo_demande_contact", language: "fr", params: [clientName, phoneLabel(client.phone)] });
      conv.handoffRequestedAt = now;
      body = t().handoffSent(business.name, phoneLabel(client.phone));
    } else {
      // WhatsApp hid this client's number: the owner could not call back, so don't alert.
      body = callUs ? "" : t().handoffNoPhone(business.name);
    }
    replies.push(text([body, callUs].filter(Boolean).join("\n\n")));
    go("idle");
  };

  // ----- the current step, from the saved conversation --------------------------
  const savedDraft = async (): Promise<Draft | null> => {
    const sid = typeof conv.context.sid === "string" ? conv.context.sid : null;
    const ch = typeof conv.context.ch === "string" ? conv.context.ch : "-";
    return sid ? await draftFrom({ sid, choices: ch === "-" ? [] : ch.split(".") }) : null;
  };

  /** Day / part / time the client typed earlier in this booking ("samedi matin"). */
  const rememberedWhen = (): When => ({
    day: typeof conv.context.day === "string" ? conv.context.day : null,
    part: typeof conv.context.part === "string" ? conv.context.part as PartOfDay : null,
    time: typeof conv.context.time === "string" ? conv.context.time : null,
  });

  /** Shows the current step again (after an unrecognised message, a side question, or a language switch). */
  const repeatScreen = async (prefix: string[] = []) => {
    const d = expired ? null : await savedDraft();
    switch (conv.state as Screen) {
      case "services":
        return services(prefix, Number(conv.context.off ?? 0));
      case "variants": {
        const wanted = String(conv.context.sids ?? "").split(".");
        const styles = (await catalog()).filter((s) => wanted.includes(s.id));
        return styles.length > 1 ? styleList(styles, t().chooseStyle, prefix) : services(prefix);
      }
      case "options":
        return d ? proceed(d, rememberedWhen(), prefix) : services(prefix);
      case "days":
        return d ? proceed(d, {}, prefix) : services(prefix);
      case "confirm":
        if (d && typeof conv.context.start === "number") return confirm(d, conv.context.start, prefix);
        // falls through
      case "times": {
        const date = typeof conv.context.date === "string"
          ? conv.context.date
          : typeof conv.context.start === "number"
          ? localDateOf(new Date(conv.context.start), tz)
          : null;
        return d && date ? times(d, date, { prefix }) : services(prefix);
      }
      case "appointments":
      case "appointment":
        return myAppointments(prefix);
      default:
        return menu(false, prefix);
    }
  };

  const setLanguage = async (next: Lang) => {
    if (next !== lang) await repo.setClientLanguage(client.id, next);
    lang = next;
    if (expired) return menu(false, [t().languageSet]);
    await repeatScreen([t().languageSet]); // stay on the same step, now in the new language
  };

  // ----- typed text -------------------------------------------------------------
  let unknown = 0;
  const handleText = async (raw: string) => {
    const all = await catalog();
    const u = understand(raw, toCatalog(all), now, tz);

    // A brand-new client writing clearly in English gets English straight away.
    if (conv.isNew && u.language && u.language !== lang) {
      await repo.setClientLanguage(client.id, u.language);
      lang = u.language;
    }
    if (u.asksPrice || u.intent === "price") pricesAsked = true;
    const inBooking = !expired && BOOKING_STEPS.includes(conv.state);

    // "Annuler" typed in the middle of a booking: stop this booking (nothing was booked yet)
    if (inBooking && STOP_BOOKING.test(normalizeClient(raw))) return menu(false, [t().flowStopped]);

    switch (u.intent) {
      case "lang_fr":
        return setLanguage("fr");
      case "lang_en":
        return setLanguage("en");
      case "greeting":
        return menu(true);
      case "thanks":
        if (conv.isNew) return menu(true);
        replies.push(text(t().thanksReply));
        return go("idle");
      case "human":
        return handoff();
      case "mine":
        return myAppointments();
      case "reschedule":
        return myAppointments([t().reschedulePrefix]);
    }

    const greet = conv.isNew || expired ? [t().greeting(firstName(client.displayName ?? ""), business.name)] : [];
    const when = { day: u.day, part: u.partOfDay, time: u.time };

    // "vous faites quoi ?": say what the salon does, in one sentence, then let the client say what she wants
    if (u.intent === "services") {
      if (u.asksPrice && !neverPrices) return services([...greet, t().priceListIntro]);
      if (inBooking) { // a side question: answer it, then continue the booking where it was
        const offer = await offerSentence();
        return repeatScreen(offer ? [offer] : []);
      }
      return menu(conv.isNew || expired, [], t().askWhich);
    }

    // 1. a precise style: answer with its price, then ask only what is missing
    if (u.styleId) {
      const service = all.find((s) => s.id === u.styleId)!;
      const previous = expired ? null : await savedDraft();
      // same style as the booking in progress and nothing new ("c'est combien les box braids ?" on the
      // summary): answer, then stay on the current step instead of starting the booking again
      if (
        inBooking && previous && previous.service.id === service.id && u.choiceIds.length === 0 &&
        !u.day && !u.time && !u.partOfDay
      ) {
        const side: string[] = [];
        if (u.asksPrice || u.intent === "price") {
          if (neverPrices) side.push(t().priceNever);
          else side.push(t().priceIntro(draftName(previous), priceShortOf(previous, undefined, nextGroup(previous) !== null)));
        }
        return repeatScreen(side);
      }
      const keep = previous && previous.service.id === service.id ? draftIds(previous).choices : [];
      const merged = [...keep];
      for (const c of u.choiceIds) {
        const group = service.groups.find((g) => g.choices.some((x) => x.id === c));
        const already = merged.findIndex((m) => group?.choices.some((x) => x.id === m));
        if (already >= 0) merged[already] = c; // the client changed their mind for this question
        else merged.push(c);
      }
      const d = makeDraft(service, merged) ?? makeDraft(service, [])!;
      const prefix = [...greet];
      if (u.asksPrice || u.intent === "price") {
        const open = nextGroup(d) !== null;
        if (neverPrices) prefix.push(t().priceNever);
        else {
          prefix.push(t().priceIntro(draftName(d), priceShortOf(d, undefined, open)));
          if (open && d.service.priceMode !== "on_site") prefix.push(t().priceDepends);
        }
      }
      return proceed(d, when, prefix);
    }
    // 2. several styles fit ("tresses"): let the client pick
    if (u.styleCandidates.length > 1) {
      const styles = all.filter((s) => u.styleCandidates.includes(s.id));
      const about = u.asksPrice ? [neverPrices ? t().priceNever : t().priceListIntro] : [];
      return styleList(styles, t().chooseStyle, [...greet, ...about]);
    }
    // 3. only a day/time while a draft is in progress ("samedi plutôt", "14h") -> continue that draft
    if ((u.day || u.time || u.partOfDay) && !expired) {
      const d = await savedDraft();
      if (d) {
        const day = u.day ?? (typeof conv.context.date === "string" ? conv.context.date : null);
        return proceed(d, { ...when, day }, greet);
      }
    }
    // 4. asked for something the salon doesn't list
    if (u.noMatch) return services([...greet, t().notOffered]);
    // 5. general price question or booking wish
    if (u.intent === "price") return services([...greet, neverPrices ? t().priceNever : t().priceListIntro]);
    if (u.intent === "book") return services(greet);
    // 6. not understood
    if (expired) return menu(true);
    unknown = unknownCount + 1;
    const sorry = unknown >= UNKNOWN_BEFORE_HUMAN ? `${t().didNotUnderstand}\n${t().offerHuman}` : t().didNotUnderstand;
    replies.push(text(sorry));
    await repeatScreen();
  };

  // ----- taps -------------------------------------------------------------------
  const handleChoice = async (id: string) => {
    const c = parseChoice(id);
    switch (c.kind) {
      case "menu":
        return menu(false);
      case "book":
        return services();
      case "page":
        return services([], c.offset);
      case "mine":
        return myAppointments();
      case "human":
        return handoff();
      case "category": {
        const s = await findService(c.sid);
        return s ? category(s) : services([t().serviceUnavailable]);
      }
      case "style":
      case "day":
      case "more":
      case "time":
      case "confirm": {
        const service = await findService(c.draft.sid);
        if (!service) return services([t().serviceUnavailable]);
        const d = makeDraft(service, c.draft.choices);
        if (!d) return proceed(makeDraft(service, [])!, {}); // options changed since: ask again
        if (c.kind === "style") {
          // an option tapped: continue with the day/time the client had already typed, if any
          const sameDraft = !expired && conv.context.sid === d.service.id;
          const remembered: When = sameDraft ? rememberedWhen() : {};
          return proceed(d, remembered);
        }
        if (nextGroup(d)) return proceed(d, {}); // a question is unanswered (catalogue changed)
        if (c.kind === "day") return times(d, c.date, { part: c.part });
        if (c.kind === "more") return times(d, c.date, { after: c.after });
        if (c.kind === "time") return confirm(d, c.start);
        return book(d, c.start);
      }
      case "appointment":
        return appointment(c.aid);
      case "cancel":
        return cancel(c.aid);
      case "keep":
        replies.push(text(t().kept));
        return go("idle");
      default:
        return menu(true);
    }
  };

  if (event.type === "text") await handleText(event.text);
  else if (event.type === "choice") await handleChoice(event.id);
  else await menu(true);

  // ----- conversation update -------------------------------------------------
  conv.state = screen;
  conv.context = {
    ...context,
    ...(pricesAsked && screen !== "idle" ? { pr: true } : {}), // keep showing prices in this flow once asked
    ...(unknown > 0 ? { unknown } : {}),
  };
  conv.expiresAt = screen === "idle" ? null : new Date(now.getTime() + FLOW_TTL_MS);
  conv.lastInboundAt = now;
  return { replies, alerts, conversation: conv };
}
