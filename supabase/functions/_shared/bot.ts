// Rendo M3 — the booking conversation (the "state machine").
//
// Input: one client event (a typed text or a tapped button/list row) + the client's conversation.
// Output: the messages to send, the alerts for the owner, and the updated conversation.
// It reads/writes the database ONLY through the Repo interface, so it is tested with a fake repo.
//
// Design rules:
//   * Every tap carries what it needs in its id ("t:<serviceId>:<startMs>") and is re-checked against
//     FRESH data (services, availability, the client's own appointments). Old lists tapped hours later
//     therefore never book something wrong; at worst the client sees "no longer available".
//   * Typed text is never stored nor echoed. Only a few keywords are recognised (menu, annuler, EN/FR...).
//   * No medical data: only the service label chosen by the business.
import { availableSlots, type Slot } from "./availability.ts";
import type {
  Business,
  Client,
  ContextValue,
  Conversation,
  Lang,
  Repo,
  Service,
  UpcomingAppointment,
} from "./domain.ts";
import {
  dayLabel,
  durationLabel,
  localDateOf,
  longDay,
  phoneLabel,
  priceLabel,
  TEXTS,
  type Texts,
  timeLabel,
  whenLabel,
} from "./i18n.ts";
import { type Button, buttons, list, type ListRow, type Outbound, type OwnerAlert, text } from "./outbound.ts";
import { firstName } from "./whatsapp.ts";

export const FLOW_TTL_MS = 2 * 60 * 60 * 1000; // an unfinished flow is forgotten after 2 h
export const HANDOFF_COOLDOWN_MS = 6 * 60 * 60 * 1000; // owner alerted at most once per 6 h per client
export const UNKNOWN_BEFORE_HUMAN = 3; // after 3 messages in a row we don't understand, offer a person
const DAY_MS = 86_400_000;
const MAX_TIMES_PER_PAGE = 10;

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
  | "days"
  | "times"
  | "confirm"
  | "appointments"
  | "appointment";

// ---------------------------------------------------------------------------
// Keyword recognition (typed text). Accents, case and punctuation are ignored.
// ---------------------------------------------------------------------------
export function normalize(input: string): string {
  return input.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

type Intent = "lang_fr" | "lang_en" | "menu" | "book" | "mine" | "human" | "unknown";

const KEYWORDS: Array<[Intent, RegExp]> = [
  ["lang_en", /^(en|english|anglais|in english)$/],
  ["lang_fr", /^(fr|francais|french|en francais)$/],
  ["mine", /^(annuler|annule|annulation|cancel|mes rdv|mes rendez vous|my appointments?|mon rdv|mon rendez vous)$/],
  ["human", /^(humain|agent|conseiller|parler a quelqu un|quelqu un|human|person|someone|talk to someone)$/],
  ["book", /^(rdv|rendez vous|prendre rdv|prendre rendez vous|reserver|reservation|book|booking|appointment)$/],
  ["menu", /^(menu|accueil|start|debut|bonjour|bonsoir|salut|hello|hi|hey|bjr|slt|cc|coucou|good morning)$/],
];

// Inside a longer sentence, only a few unambiguous words count ("je veux annuler mon rdv").
// Order matters: cancelling wins over booking, so "annuler mon rdv" never starts a new booking.
const CONTAINS: Array<[Intent, RegExp]> = [
  ["mine", /\b(annul\w*|cancel\w*)\b/],
  ["human", /\b(humain|conseiller|parler a quelqu un|talk to someone|human)\b/],
  ["book", /\b(rdv|rendez vous|reserv\w*|book\w*|appointment)\b/],
];

export function intentOf(raw: string): Intent {
  const s = normalize(raw);
  for (const [intent, re] of KEYWORDS) if (re.test(s)) return intent;
  for (const [intent, re] of CONTAINS) if (re.test(s)) return intent;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Tap ids. Kept short and fully validated before any database call.
// ---------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS = /^\d{12,14}$/;

type Choice =
  | { kind: "menu" | "book" | "mine" | "human" }
  | { kind: "service"; sid: string }
  | { kind: "day"; sid: string; date: string }
  | { kind: "more"; sid: string; date: string; after: number }
  | { kind: "time"; sid: string; start: number }
  | { kind: "confirm"; sid: string; start: number }
  | { kind: "appointment" | "cancel" | "keep"; aid: string }
  | { kind: "invalid" };

export const ids = {
  menu: "m:menu",
  book: "m:book",
  mine: "m:mine",
  human: "m:human",
  service: (sid: string) => `s:${sid}`,
  day: (sid: string, date: string) => `d:${sid}:${date}`,
  more: (sid: string, date: string, after: number) => `t+:${sid}:${date}:${after}`,
  time: (sid: string, start: number) => `t:${sid}:${start}`,
  confirm: (sid: string, start: number) => `c:${sid}:${start}`,
  appointment: (aid: string) => `a:${aid}`,
  cancel: (aid: string) => `x:${aid}`,
  keep: (aid: string) => `k:${aid}`,
};

export function parseChoice(id: string): Choice {
  const p = id.split(":");
  const uuid = (v: string | undefined) => v !== undefined && UUID.test(v);
  switch (p[0]) {
    case "m":
      if (p.length === 2 && ["menu", "book", "mine", "human"].includes(p[1])) {
        return { kind: p[1] as "menu" | "book" | "mine" | "human" };
      }
      break;
    case "s":
      if (p.length === 2 && uuid(p[1])) return { kind: "service", sid: p[1] };
      break;
    case "d":
      if (p.length === 3 && uuid(p[1]) && DATE.test(p[2])) return { kind: "day", sid: p[1], date: p[2] };
      break;
    case "t+":
      if (p.length === 4 && uuid(p[1]) && DATE.test(p[2]) && MS.test(p[3])) {
        return { kind: "more", sid: p[1], date: p[2], after: Number(p[3]) };
      }
      break;
    case "t":
    case "c":
      if (p.length === 3 && uuid(p[1]) && MS.test(p[2])) {
        return { kind: p[0] === "t" ? "time" : "confirm", sid: p[1], start: Number(p[2]) };
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

  let screen: Screen = "idle";
  let context: Record<string, ContextValue> = {};
  const go = (s: Screen, ctx: Record<string, ContextValue> = {}) => {
    screen = s;
    context = ctx;
  };

  // ----- screens -----------------------------------------------------------
  const menu = (greet: boolean, prefix: string[] = []) => {
    const lines = [...prefix];
    if (greet) lines.push(t().greeting(firstName(client.displayName ?? ""), business.name));
    lines.push(t().menuQuestion);
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

  const findService = async (sid: string): Promise<Service | null> =>
    (await repo.activeServices(business.id)).find((s) => s.id === sid) ?? null;

  const freeSlots = async (service: Service): Promise<Slot[]> => {
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
      serviceMinutes: service.durationMinutes,
      ...data,
      now,
    });
  };

  const services = async (prefix?: string) => {
    const all = await repo.activeServices(business.id);
    if (all.length === 0) return menuButtons(t().noServices(business.name), { id: ids.human, title: t().btnHuman });
    const rows: ListRow[] = all.slice(0, 10).map((s) => ({
      id: ids.service(s.id),
      title: s.name,
      description: [durationLabel(s.durationMinutes, lang), s.priceXaf !== null ? priceLabel(s.priceXaf, lang) : null]
        .filter(Boolean).join(" · "),
    }));
    const body = (prefix ? prefix + "\n\n" : "") + t().chooseService(business.name);
    replies.push(list(body, t().listButtonServices, t().sectionServices, rows));
    go("services");
  };

  const days = async (service: Service, prefix?: string) => {
    const slots = await freeSlots(service);
    const byDay = new Map<string, number>();
    for (const s of slots) byDay.set(s.localDate, (byDay.get(s.localDate) ?? 0) + 1);
    if (byDay.size === 0) {
      return menuButtons(t().noDays(service.name, business.horizonDays), { id: ids.human, title: t().btnHuman });
    }
    const today = localDateOf(now, tz);
    const rows: ListRow[] = [...byDay].slice(0, 10).map(([date, n]) => ({
      id: ids.day(service.id, date),
      title: dayLabel(date, today, lang),
      description: t().freeSlots(n),
    }));
    const body = (prefix ? prefix + "\n\n" : "") + t().chooseDay(service.name);
    replies.push(list(body, t().listButtonDays, t().sectionDays, rows));
    go("days", { sid: service.id });
  };

  const times = async (service: Service, date: string, after: number | null, prefix?: string) => {
    const slots = (await freeSlots(service)).filter((s) =>
      s.localDate === date && (after === null || s.start.getTime() > after)
    );
    if (slots.length === 0) {
      if (after !== null) return times(service, date, null, prefix); // "later" page vanished: start over
      return days(service, t().dayFull(longDay(date, lang)));
    }
    const page = slots.length > MAX_TIMES_PER_PAGE ? slots.slice(0, MAX_TIMES_PER_PAGE - 1) : slots;
    const rows: ListRow[] = page.map((s) => ({
      id: ids.time(service.id, s.start.getTime()),
      title: timeLabel(s.start, tz, lang),
      description: t().endsAround(timeLabel(s.end, tz, lang)),
    }));
    if (page.length < slots.length) {
      rows.push({
        id: ids.more(service.id, date, page[page.length - 1].start.getTime()),
        title: t().later,
        description: t().laterDesc,
      });
    }
    const body = (prefix ? prefix + "\n\n" : "") +
      t().chooseTime(service.name, dayLabel(date, localDateOf(now, tz), lang));
    replies.push(list(body, t().listButtonTimes, t().sectionTimes, rows));
    go("times", { sid: service.id, date, after });
  };

  /** The slot starting exactly at `start`, if it is still bookable right now. */
  const stillFree = async (service: Service, start: number): Promise<Slot | null> =>
    (await freeSlots(service)).find((s) => s.start.getTime() === start) ?? null;

  const confirm = async (service: Service, start: number) => {
    const slot = await stillFree(service, start);
    if (!slot) return times(service, localDateOf(new Date(start), tz), null, t().slotGone);
    const body = t().confirmQuestion(
      service.name,
      whenLabel(slot.start, tz, lang),
      durationLabel(service.durationMinutes, lang),
      business.name,
      service.priceXaf !== null ? priceLabel(service.priceXaf, lang) : null,
    );
    replies.push(buttons(body, [
      { id: ids.confirm(service.id, start), title: t().btnConfirm },
      { id: ids.day(service.id, slot.localDate), title: t().btnChangeTime },
      { id: ids.menu, title: t().btnCancelFlow },
    ]));
    go("confirm", { sid: service.id, start });
  };

  const book = async (service: Service, start: number) => {
    // Opening hours / notice are re-checked here; the database itself guarantees "no overlap".
    const slot = await stillFree(service, start);
    const date = localDateOf(new Date(start), tz);
    if (!slot) return times(service, date, null, t().slotGone);
    const result = await repo.book(business.id, client.id, service.id, slot.start);
    if (result.status === "slot_taken") return times(service, date, null, t().slotTaken);
    if (result.status === "invalid") return menu(false, [t().bookingFailed]);
    replies.push(
      text(t().booked(service.name, whenLabel(result.startsAt, tz, lang), business.name, result.bookingCode)),
    );
    alerts.push({
      template: "rendo_nouveau_rdv",
      language: "fr",
      params: [
        clientName,
        templateParam(service.name),
        templateParam(whenLabel(result.startsAt, tz, "fr")),
        client.phone ? phoneLabel(client.phone) : "non communiqué",
        result.bookingCode,
      ],
    });
    go("idle");
  };

  const myAppointments = async () => {
    const upcoming = await repo.upcomingForClient(client.id, now);
    if (upcoming.length === 0) return menuButtons(t().noUpcoming, { id: ids.book, title: t().btnBook });
    const today = localDateOf(now, tz);
    const rows: ListRow[] = upcoming.slice(0, 10).map((a) => ({
      id: ids.appointment(a.id),
      title: `${dayLabel(localDateOf(a.startsAt, tz), today, lang)} · ${timeLabel(a.startsAt, tz, lang)}`,
      description: `${a.serviceName} · ${a.bookingCode}`,
    }));
    replies.push(list(t().chooseAppointment, t().listButtonAppointments, t().sectionAppointments, rows));
    go("appointments");
  };

  const ownUpcoming = async (aid: string): Promise<UpcomingAppointment | null> =>
    (await repo.upcomingForClient(client.id, now)).find((a) => a.id === aid) ?? null;

  const appointment = async (aid: string) => {
    const a = await ownUpcoming(aid);
    if (!a) return menu(false, [t().cancelNotFound]);
    replies.push(buttons(t().appointmentDetail(a.serviceName, whenLabel(a.startsAt, tz, lang), a.bookingCode), [
      { id: ids.cancel(a.id), title: t().btnCancelAppointment },
      { id: ids.keep(a.id), title: t().btnKeep },
    ]));
    go("appointment", { aid });
  };

  const cancel = async (aid: string) => {
    const a = await ownUpcoming(aid); // details for the messages, and ownership check
    if (!a || (await repo.cancelByClient(aid, client.id, now)) !== "cancelled") {
      return menu(false, [t().cancelNotFound]);
    }
    replies.push(text(t().cancelled(a.serviceName, whenLabel(a.startsAt, tz, lang))));
    alerts.push({
      template: "rendo_annulation_rdv",
      language: "fr",
      params: [
        clientName,
        templateParam(a.serviceName),
        templateParam(whenLabel(a.startsAt, tz, "fr")),
        a.bookingCode,
      ],
    });
    go("idle");
  };

  const handoff = () => {
    const recent = conv.handoffRequestedAt !== null &&
      now.getTime() - conv.handoffRequestedAt.getTime() < HANDOFF_COOLDOWN_MS;
    const callUs = business.contactPhone ? t().handoffCallUs(business.name, phoneLabel(business.contactPhone)) : null;
    let body: string;
    if (recent) {
      body = t().handoffAlready;
    } else if (client.phone) {
      alerts.push({
        template: "rendo_demande_contact",
        language: "fr",
        params: [
          clientName,
          phoneLabel(client.phone),
        ],
      });
      conv.handoffRequestedAt = now;
      body = t().handoffSent(business.name, phoneLabel(client.phone));
    } else {
      // WhatsApp hid this client's number: the owner could not call back, so don't alert.
      body = callUs ? "" : t().handoffNoPhone(business.name);
    }
    replies.push(text([body, callUs].filter(Boolean).join("\n\n")));
    go("idle");
  };

  const setLanguage = async (next: Lang) => {
    if (next !== lang) await repo.setClientLanguage(client.id, next);
    lang = next;
    menu(false, [t().languageSet]);
  };

  /** Shows the current step again (after an unrecognised message). */
  const repeatScreen = async () => {
    const sid = typeof conv.context.sid === "string" ? conv.context.sid : null;
    const service = sid ? await findService(sid) : null;
    switch (conv.state as Screen) {
      case "services":
        return services();
      case "days":
        return service ? days(service) : services();
      case "times":
      case "confirm": {
        const date = typeof conv.context.date === "string"
          ? conv.context.date
          : typeof conv.context.start === "number"
          ? localDateOf(new Date(conv.context.start), tz)
          : null;
        return service && date ? times(service, date, null) : services();
      }
      case "appointments":
      case "appointment":
        return myAppointments();
      default:
        return menu(false);
    }
  };

  // ----- routing -----------------------------------------------------------
  let unknown = 0;
  if (event.type === "text") {
    const intent = intentOf(event.text);
    if (intent === "lang_fr") await setLanguage("fr");
    else if (intent === "lang_en") await setLanguage("en");
    else if (intent === "menu") menu(true);
    else if (intent === "book") await services();
    else if (intent === "mine") await myAppointments();
    else if (intent === "human") handoff();
    else if (expired) menu(true); // first message or after a pause: just greet
    else {
      unknown = unknownCount + 1;
      replies.push(text(
        unknown >= UNKNOWN_BEFORE_HUMAN ? `${t().didNotUnderstand}\n${t().offerHuman}` : t().didNotUnderstand,
      ));
      await repeatScreen();
    }
  } else if (event.type === "choice") {
    const c = parseChoice(event.id);
    switch (c.kind) {
      case "menu":
        menu(false);
        break;
      case "book":
        await services();
        break;
      case "mine":
        await myAppointments();
        break;
      case "human":
        handoff();
        break;
      case "service":
      case "day":
      case "more":
      case "time":
      case "confirm": {
        const service = await findService(c.sid);
        if (!service) await services(t().serviceUnavailable);
        else if (c.kind === "service") await days(service);
        else if (c.kind === "day") await times(service, c.date, null);
        else if (c.kind === "more") await times(service, c.date, c.after);
        else if (c.kind === "time") await confirm(service, c.start);
        else await book(service, c.start);
        break;
      }
      case "appointment":
        await appointment(c.aid);
        break;
      case "cancel":
        await cancel(c.aid);
        break;
      case "keep":
        replies.push(text(t().kept));
        go("idle");
        break;
      default:
        menu(true);
    }
  } else {
    menu(true);
  }

  // ----- conversation update -------------------------------------------------
  conv.state = screen;
  conv.context = unknown > 0 ? { ...context, unknown } : context;
  conv.expiresAt = screen === "idle" ? null : new Date(now.getTime() + FLOW_TTL_MS);
  conv.lastInboundAt = now;
  return { replies, alerts, conversation: conv };
}
