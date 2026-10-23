// Rendo M3 — everything the client reads, in French and English, plus date/price/phone formatting.
// Dates are always shown in the BUSINESS time zone (Africa/Douala for the pilot).
import type { Lang, Service, ServiceLabel } from "./domain.ts";
import { localParts } from "./availability.ts";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
// Day and month names are written out here instead of using Intl locale data: the result is then
// identical on every machine and runtime (an Edge runtime without French locale data would
// otherwise silently fall back to English).
const NAMES = {
  fr: {
    days: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
    daysShort: ["Dim.", "Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam."],
    months: [
      "janvier",
      "février",
      "mars",
      "avril",
      "mai",
      "juin",
      "juillet",
      "août",
      "septembre",
      "octobre",
      "novembre",
      "décembre",
    ],
    monthsShort: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
  },
  en: {
    days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    daysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    months: [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ],
    monthsShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  },
} as const;

/** A local calendar date "YYYY-MM-DD" as a Date at noon UTC (safe to format with timeZone UTC). */
function calendarDate(localDate: string): Date {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** "YYYY-MM-DD" of an instant in the business time zone. */
export function localDateOf(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Short day label for list rows: "Aujourd'hui", "Demain", "Lun. 2 nov." / "Today", "Tomorrow", "Mon 2 Nov". */
export function dayLabel(localDate: string, today: string, lang: Lang): string {
  const diff = Math.round((calendarDate(localDate).getTime() - calendarDate(today).getTime()) / 86_400_000);
  if (diff === 0) return lang === "fr" ? "Aujourd'hui" : "Today";
  if (diff === 1) return lang === "fr" ? "Demain" : "Tomorrow";
  const d = calendarDate(localDate), n = NAMES[lang];
  return `${n.daysShort[d.getUTCDay()]} ${d.getUTCDate()} ${n.monthsShort[d.getUTCMonth()]}`;
}

/** "lundi 2 novembre" / "Monday 2 November" for a local date. */
export function longDay(localDate: string, lang: Lang): string {
  const d = calendarDate(localDate), n = NAMES[lang];
  return `${n.days[d.getUTCDay()]} ${d.getUTCDate()} ${n.months[d.getUTCMonth()]}`;
}

/** "10h30" (fr) / "10:30" (en) in the business time zone. */
export function timeLabel(instant: Date, timeZone: string, lang: Lang): string {
  const p = localParts(instant, timeZone);
  const mm = String(p.minute).padStart(2, "0");
  return lang === "fr" ? `${p.hour}h${mm}` : `${String(p.hour).padStart(2, "0")}:${mm}`;
}

/** "lundi 2 novembre à 10h30" / "Monday 2 November at 10:30". */
export function whenLabel(instant: Date, timeZone: string, lang: Lang): string {
  const day = longDay(localDateOf(instant, timeZone), lang);
  return lang === "fr"
    ? `${day} à ${timeLabel(instant, timeZone, lang)}`
    : `${day} at ${timeLabel(instant, timeZone, lang)}`;
}

/** "3 000 FCFA" (fr) / "3,000 FCFA" (en). */
export function priceLabel(xaf: number, lang: Lang): string {
  const n = Math.round(xaf).toString().replace(/\B(?=(\d{3})+(?!\d))/g, lang === "fr" ? " " : ",");
  return `${n} FCFA`;
}

/** "+237 690 00 00 00" for Cameroon numbers, "+<digits>" otherwise. */
export function phoneLabel(digits: string): string {
  const m = /^237(\d{3})(\d{2})(\d{2})(\d{2})$/.exec(digits);
  return m ? `+237 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : `+${digits}`;
}

/** Variant name in the client's language ("Longues" / "Long"); French if no English name. */
export function serviceTitle(s: ServiceLabel, lang: Lang): string {
  return lang === "en" && s.nameEn ? s.nameEn : s.name;
}

/** Category name in the client's language. */
export function categoryTitle(s: ServiceLabel, lang: Lang): string {
  return lang === "en" && s.categoryEn ? s.categoryEn : s.category;
}

/** "Tresses – Longues" / "Braids – Long", or just the name when there is no category. */
export function serviceFullName(s: ServiceLabel, lang: Lang): string {
  return s.category ? `${categoryTitle(s, lang)} – ${serviceTitle(s, lang)}` : serviceTitle(s, lang);
}

/** Short price for list rows: "3 000 FCFA", "dès 15 000 FCFA", "prix sur place" (null = show nothing). */
export function priceShort(s: Service, lang: Lang): string | null {
  if (s.priceMode === "on_site") return lang === "fr" ? "prix sur place" : "price on site";
  if (s.priceXaf === null) return null;
  const p = priceLabel(s.priceXaf, lang);
  return s.priceMode === "from" ? (lang === "fr" ? `dès ${p}` : `from ${p}`) : p;
}

/** Price line for the summary: "3 000 FCFA", "à partir de 15 000 FCFA", "confirmé sur place". */
export function priceLong(s: Service, lang: Lang): string | null {
  if (s.priceMode === "on_site") return lang === "fr" ? "confirmé sur place" : "confirmed on site";
  if (s.priceXaf === null) return null;
  const p = priceLabel(s.priceXaf, lang);
  return s.priceMode === "from" ? (lang === "fr" ? `à partir de ${p}` : `from ${p}`) : p;
}

/** The business's note in the client's language (French note if no English one). */
export function noteOf(s: Service, lang: Lang): string | null {
  return (lang === "en" ? s.noteEn ?? s.note : s.note) || null;
}

/** Duration "30 min" / "1 h 30" (fr) / "1 h 30 min" (en). */
export function durationLabel(minutes: number, lang: Lang): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (m === 0) return `${h} h`;
  return lang === "fr" ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h ${m} min`;
}

// ---------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------
export interface Texts {
  greeting(firstName: string, business: string): string;
  menuQuestion: string;
  didNotUnderstand: string;
  offerHuman: string;
  menuFooter: string;
  btnBook: string;
  btnMine: string;
  btnHuman: string;
  btnMenu: string;
  // services
  chooseService(business: string): string;
  listButtonServices: string;
  sectionServices: string;
  noServices(business: string): string;
  serviceUnavailable: string;
  chooseVariant(category: string): string;
  sectionVariants: string;
  listButtonVariants: string;
  variantsCount(n: number): string;
  thanksReply: string;
  // days
  chooseDay(service: string): string;
  listButtonDays: string;
  sectionDays: string;
  freeSlots(n: number): string;
  noDays(service: string, days: number): string;
  // times
  chooseTime(service: string, day: string): string;
  listButtonTimes: string;
  sectionTimes: string;
  endsAround(time: string): string;
  later: string;
  laterDesc: string;
  dayFull(day: string): string;
  // confirm
  confirmQuestion(
    service: string,
    when: string,
    duration: string,
    business: string,
    price: string | null,
    note: string | null,
  ): string;
  btnConfirm: string;
  btnChangeTime: string;
  btnCancelFlow: string;
  slotGone: string;
  // booked
  booked(service: string, when: string, business: string, code: string): string;
  slotTaken: string;
  bookingFailed: string;
  // my appointments
  noUpcoming: string;
  chooseAppointment: string;
  listButtonAppointments: string;
  sectionAppointments: string;
  appointmentDetail(service: string, when: string, code: string): string;
  btnCancelAppointment: string;
  btnKeep: string;
  cancelled(service: string, when: string): string;
  cancelNotFound: string;
  kept: string;
  // handoff
  handoffSent(business: string, phone: string): string;
  handoffAlready: string;
  handoffCallUs(business: string, phone: string): string;
  handoffNoPhone(business: string): string;
  // language
  languageSet: string;
  // errors
  technicalProblem: string;
}

export const TEXTS: Record<Lang, Texts> = {
  fr: {
    greeting: (n, b) => n ? `Bonjour ${n} 👋 Bienvenue chez ${b}.` : `Bonjour 👋 Bienvenue chez ${b}.`,
    menuQuestion: "Que souhaitez-vous faire ?",
    didNotUnderstand: "Je n'ai pas compris 🙂 Merci d'utiliser les boutons ci-dessous.",
    offerHuman: "Vous pouvez aussi appuyer sur « Parler à quelqu'un ».",
    menuFooter: "Reply EN for English",
    btnBook: "Prendre rendez-vous",
    btnMine: "Mes rendez-vous",
    btnHuman: "Parler à quelqu'un",
    btnMenu: "Menu",
    chooseService: (b) => `Quelle prestation souhaitez-vous chez ${b} ?`,
    listButtonServices: "Voir les prestations",
    sectionServices: "Prestations",
    noServices: (b) => `${b} n'a pas encore de prestation réservable sur WhatsApp.`,
    serviceUnavailable: "Cette prestation n'est plus disponible. Voici la liste à jour :",
    chooseVariant: (c) => `${c} : quelle option souhaitez-vous ?`,
    sectionVariants: "Options",
    listButtonVariants: "Voir les options",
    variantsCount: (n) => `${n} options`,
    thanksReply: "Avec plaisir 🙂 Écrivez MENU à tout moment pour revenir au menu.",
    chooseDay: (s) => `${s} : quel jour vous arrange ?`,
    listButtonDays: "Voir les jours",
    sectionDays: "Jours disponibles",
    freeSlots: (n) => n === 1 ? "1 créneau libre" : `${n} créneaux libres`,
    noDays: (s, d) => `Désolé, plus aucun créneau libre pour ${s} dans les ${d} prochains jours.`,
    chooseTime: (s, d) => `${s} – ${d} : à quelle heure ?`,
    listButtonTimes: "Voir les heures",
    sectionTimes: "Heures disponibles",
    endsAround: (t) => `Fin vers ${t}`,
    later: "Plus tard…",
    laterDesc: "Voir les heures suivantes",
    dayFull: (d) => `Il n'y a plus de créneau libre ${d}. Choisissez un autre jour :`,
    confirmQuestion: (s, w, d, b, p, n) =>
      `Récapitulatif :\n• ${s} (${d})\n• ${w}\n• chez ${b}` + (p ? `\n• Prix : ${p}` : "") +
      (n ? `\n\nℹ️ ${n}` : "") + "\n\nJe confirme le rendez-vous ?",
    btnConfirm: "Confirmer",
    btnChangeTime: "Changer l'heure",
    btnCancelFlow: "Annuler",
    slotGone: "Ce créneau n'est plus disponible. Voici les heures encore libres :",
    booked: (s, w, b, c) =>
      `✅ Rendez-vous confirmé !\n${s} – ${w} chez ${b}.\nRéférence : ${c}\n\n` +
      "Pour annuler, écrivez ANNULER à tout moment.",
    slotTaken: "Oups, ce créneau vient d'être pris par quelqu'un d'autre. Voici les heures encore libres :",
    bookingFailed: "Ce rendez-vous n'a pas pu être enregistré. Merci de recommencer.",
    noUpcoming: "Vous n'avez aucun rendez-vous à venir.",
    chooseAppointment: "Vos prochains rendez-vous :",
    listButtonAppointments: "Voir mes rendez-vous",
    sectionAppointments: "À venir",
    appointmentDetail: (s, w, c) => `${s} – ${w}\nRéférence : ${c}\n\nQue souhaitez-vous faire ?`,
    btnCancelAppointment: "Annuler ce RDV",
    btnKeep: "Garder",
    cancelled: (s, w) => `Votre rendez-vous ${s} du ${w} est annulé. À bientôt !`,
    cancelNotFound: "Ce rendez-vous est déjà annulé ou passé.",
    kept: "Parfait, votre rendez-vous est maintenu 👍",
    handoffSent: (b, p) => `C'est noté ✅ ${b} va vous contacter directement au ${p} dès que possible.`,
    handoffAlready: "Votre demande a déjà été transmise. Vous serez contacté(e) dès que possible.",
    handoffCallUs: (b, p) => `Vous pouvez aussi appeler ${b} au ${p}.`,
    handoffNoPhone: (b) => `Pour parler à quelqu'un, merci de contacter ${b} directement.`,
    languageSet: "C'est noté, je vous parle en français.",
    technicalProblem: "Désolé, un problème technique est survenu. Merci de réessayer dans quelques minutes.",
  },
  en: {
    greeting: (n, b) => n ? `Hello ${n} 👋 Welcome to ${b}.` : `Hello 👋 Welcome to ${b}.`,
    menuQuestion: "What would you like to do?",
    didNotUnderstand: "Sorry, I didn't understand 🙂 Please use the buttons below.",
    offerHuman: "You can also tap “Talk to someone”.",
    menuFooter: "Écrivez FR pour le français",
    btnBook: "Book appointment",
    btnMine: "My appointments",
    btnHuman: "Talk to someone",
    btnMenu: "Menu",
    chooseService: (b) => `Which service would you like at ${b}?`,
    listButtonServices: "See services",
    sectionServices: "Services",
    noServices: (b) => `${b} has no services bookable on WhatsApp yet.`,
    serviceUnavailable: "This service is no longer available. Here is the current list:",
    chooseVariant: (c) => `${c}: which option would you like?`,
    sectionVariants: "Options",
    listButtonVariants: "See options",
    variantsCount: (n) => `${n} options`,
    thanksReply: "You're welcome 🙂 Type MENU at any time to see the menu again.",
    chooseDay: (s) => `${s}: which day suits you?`,
    listButtonDays: "See days",
    sectionDays: "Available days",
    freeSlots: (n) => n === 1 ? "1 free slot" : `${n} free slots`,
    noDays: (s, d) => `Sorry, there are no free slots for ${s} in the next ${d} days.`,
    chooseTime: (s, d) => `${s} – ${d}: what time?`,
    listButtonTimes: "See times",
    sectionTimes: "Available times",
    endsAround: (t) => `Ends around ${t}`,
    later: "Later…",
    laterDesc: "See later times",
    dayFull: (d) => `There are no free slots left on ${d}. Please choose another day:`,
    confirmQuestion: (s, w, d, b, p, n) =>
      `Summary:\n• ${s} (${d})\n• ${w}\n• at ${b}` + (p ? `\n• Price: ${p}` : "") +
      (n ? `\n\nℹ️ ${n}` : "") + "\n\nShall I confirm the appointment?",
    btnConfirm: "Confirm",
    btnChangeTime: "Change time",
    btnCancelFlow: "Cancel",
    slotGone: "This slot is no longer available. Here are the times still free:",
    booked: (s, w, b, c) =>
      `✅ Appointment confirmed!\n${s} – ${w} at ${b}.\nReference: ${c}\n\n` +
      "To cancel, type CANCEL at any time.",
    slotTaken: "Oops, someone just took this slot. Here are the times still free:",
    bookingFailed: "This appointment could not be saved. Please start again.",
    noUpcoming: "You have no upcoming appointments.",
    chooseAppointment: "Your upcoming appointments:",
    listButtonAppointments: "See my appointments",
    sectionAppointments: "Upcoming",
    appointmentDetail: (s, w, c) => `${s} – ${w}\nReference: ${c}\n\nWhat would you like to do?`,
    btnCancelAppointment: "Cancel appointment",
    btnKeep: "Keep it",
    cancelled: (s, w) => `Your ${s} appointment on ${w} is cancelled. See you soon!`,
    cancelNotFound: "This appointment is already cancelled or over.",
    kept: "Great, your appointment is kept 👍",
    handoffSent: (b, p) => `Noted ✅ ${b} will contact you directly on ${p} as soon as possible.`,
    handoffAlready: "Your request has already been passed on. You will be contacted as soon as possible.",
    handoffCallUs: (b, p) => `You can also call ${b} on ${p}.`,
    handoffNoPhone: (b) => `To talk to someone, please contact ${b} directly.`,
    languageSet: "Noted, I'll talk to you in English.",
    technicalProblem: "Sorry, a technical problem occurred. Please try again in a few minutes.",
  },
};
