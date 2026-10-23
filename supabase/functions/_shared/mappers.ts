// Rendo M3 — turns database rows (snake_case, strings) into the bot's types (camelCase, Dates).
// Pure functions with no imports to download, so they are unit-tested offline.
// They are strict on purpose: a row that doesn't look right throws instead of silently
// producing a half-filled object that would cause a wrong booking later.
import type {
  BookResult,
  Business,
  Client,
  ContextValue,
  Conversation,
  Lang,
  Service,
  UpcomingAppointment,
} from "./domain.ts";

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== "string" || v === "") throw new Error(`row.${key}: expected a non-empty string`);
  return v;
}

function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Error(`row.${key}: expected a string or null`);
  return v;
}

function num(row: Row, key: string): number {
  const v = row[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`row.${key}: expected a number`);
  return v;
}

function date(row: Row, key: string): Date {
  const d = new Date(str(row, key));
  if (Number.isNaN(d.getTime())) throw new Error(`row.${key}: invalid timestamp`);
  return d;
}

function dateOrNull(row: Row, key: string): Date | null {
  return strOrNull(row, key) === null ? null : date(row, key);
}

function lang(row: Row, key: string): Lang {
  const v = row[key];
  if (v !== "fr" && v !== "en") throw new Error(`row.${key}: expected 'fr' or 'en'`);
  return v;
}

export function toBusiness(row: Row): Business {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    ownerWhatsapp: str(row, "owner_whatsapp"),
    timezone: str(row, "timezone"),
    defaultLanguage: lang(row, "default_language"),
    slotMinutes: num(row, "slot_minutes"),
    bufferMinutes: num(row, "buffer_minutes"),
    horizonDays: num(row, "booking_horizon_days"),
    minNoticeMinutes: num(row, "min_notice_minutes"),
    contactPhone: strOrNull(row, "contact_phone"),
  };
}

export function toService(row: Row): Service {
  const price = row["price_xaf"];
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    durationMinutes: num(row, "duration_minutes"),
    priceXaf: typeof price === "number" ? price : null,
  };
}

export function toClient(row: Row): Client {
  return {
    id: str(row, "id"),
    businessId: str(row, "business_id"),
    waUserId: strOrNull(row, "wa_user_id"),
    phone: strOrNull(row, "phone"),
    displayName: strOrNull(row, "display_name"),
    language: lang(row, "language"),
  };
}

/** Keeps only flat JSON values (string/number/boolean/null); anything else is dropped. */
export function cleanContext(value: unknown): Record<string, ContextValue> {
  const out: Record<string, ContextValue> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))
    ) {
      out[k] = v;
    }
  }
  return out;
}

export function toConversation(row: Row): Conversation {
  return {
    clientId: str(row, "client_id"),
    businessId: str(row, "business_id"),
    state: str(row, "state"),
    context: cleanContext(row["context"]),
    expiresAt: dateOrNull(row, "expires_at"),
    pausedUntil: dateOrNull(row, "paused_until"),
    lastInboundAt: dateOrNull(row, "last_inbound_at"),
    handoffRequestedAt: dateOrNull(row, "handoff_requested_at"),
    version: num(row, "version"),
    isNew: false,
  };
}

/** Conversation fields as database columns (for insert/update). */
export function conversationColumns(c: Conversation): Row {
  return {
    state: c.state,
    context: c.context,
    expires_at: c.expiresAt?.toISOString() ?? null,
    paused_until: c.pausedUntil?.toISOString() ?? null,
    last_inbound_at: c.lastInboundAt?.toISOString() ?? null,
    handoff_requested_at: c.handoffRequestedAt?.toISOString() ?? null,
  };
}

/** Postgres "time" ("08:00:00") is passed through; availability.ts parses it. */
export function toOpeningRange(row: Row) {
  return { weekday: num(row, "weekday"), opensAt: str(row, "opens_at"), closesAt: str(row, "closes_at") };
}

export function toInterval(row: Row, startKey: string, endKey: string) {
  return { start: date(row, startKey), end: date(row, endKey) };
}

export function toUpcoming(row: Row): UpcomingAppointment {
  // PostgREST returns the embedded service as an object (one service per appointment)
  const service = row["services"] as Row | null | undefined;
  return {
    id: str(row, "id"),
    bookingCode: str(row, "booking_code"),
    serviceName: service && typeof service === "object" ? str(service, "name") : "",
    startsAt: date(row, "starts_at"),
  };
}

/** The jsonb returned by rendo_book_appointment(). */
export function toBookResult(value: unknown): BookResult {
  const row = (value ?? {}) as Row;
  switch (row["status"]) {
    case "booked":
      return {
        status: "booked",
        appointmentId: str(row, "appointment_id"),
        bookingCode: str(row, "booking_code"),
        startsAt: date(row, "starts_at"),
        endsAt: date(row, "ends_at"),
      };
    case "slot_taken":
      return { status: "slot_taken" };
    case "invalid":
      return { status: "invalid", reason: typeof row["reason"] === "string" ? row["reason"] : "unknown" };
    default:
      throw new Error("rendo_book_appointment: unexpected result");
  }
}
