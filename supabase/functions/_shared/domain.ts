// Rendo M3 — the data the booking bot works with, and the Repo interface that loads/saves it.
//
// The bot's logic depends only on this interface, never on Supabase directly, so it can be tested
// with an in-memory fake. The real implementation is supabase_repo.ts.
// This file imports nothing that needs downloading (tests stay offline).
import type { Interval, OpeningRange } from "./availability.ts";

export type Lang = "fr" | "en";

export interface Business {
  id: string;
  name: string;
  ownerWhatsapp: string;
  timezone: string;
  defaultLanguage: Lang;
  slotMinutes: number;
  bufferMinutes: number;
  horizonDays: number;
  minNoticeMinutes: number;
  /** Public number shown to clients who ask for a person (null = not set). Never owner_whatsapp. */
  contactPhone: string | null;
}

export interface Service {
  id: string;
  name: string;
  durationMinutes: number;
  priceXaf: number | null;
}

export interface Client {
  id: string;
  businessId: string;
  waUserId: string | null;
  phone: string | null;
  displayName: string | null;
  language: Lang;
}

/** JSON-safe values only: the context is stored as jsonb. */
export type ContextValue = string | number | boolean | null;

export interface Conversation {
  clientId: string;
  businessId: string;
  state: string;
  context: Record<string, ContextValue>;
  expiresAt: Date | null;
  pausedUntil: Date | null;
  lastInboundAt: Date | null;
  /** Last "talk to a person" request: the owner is alerted at most once per period. */
  handoffRequestedAt: Date | null;
  /** Version read from the database; a save only succeeds if it is still the current one. */
  version: number;
  /** True when no row exists yet (first message from this client). */
  isNew: boolean;
}

export interface AvailabilityData {
  openingHours: OpeningRange[];
  closures: Interval[];
  /** Active appointments as [starts_at, blocked_until). */
  busy: Interval[];
}

export interface UpcomingAppointment {
  id: string;
  bookingCode: string;
  serviceName: string;
  startsAt: Date;
}

export type BookResult =
  | { status: "booked"; appointmentId: string; bookingCode: string; startsAt: Date; endsAt: Date }
  | { status: "slot_taken" }
  | { status: "invalid"; reason: string };

export interface ClientIds {
  waUserId?: string;
  phone?: string;
  displayName?: string;
}

/** Thrown by a Repo when the database fails; the message never contains personal data. */
export class RepoError extends Error {
  constructor(operation: string, code?: string) {
    super(`${operation} failed${code ? ` (${code})` : ""}`);
    this.name = "RepoError";
  }
}

export interface Repo {
  /** Active business answering on this WhatsApp phone number id, or null. */
  businessByPhoneNumberId(phoneNumberId: string): Promise<Business | null>;
  /** Active services, in the business's display order. */
  activeServices(businessId: string): Promise<Service[]>;
  /** Everything availableSlots() needs for the window [from, to). */
  availabilityData(businessId: string, from: Date, to: Date): Promise<AvailabilityData>;
  /** Finds the client by user id or phone, creating it if needed. */
  upsertClient(businessId: string, ids: ClientIds): Promise<Client>;
  setClientLanguage(clientId: string, language: Lang): Promise<void>;
  /** The client's conversation, or a fresh one (isNew = true) if none exists yet. */
  conversation(client: Client): Promise<Conversation>;
  /** "conflict" means another message saved in between: reload and handle the message again. */
  saveConversation(conversation: Conversation): Promise<"saved" | "conflict">;
  book(businessId: string, clientId: string, serviceId: string, startsAt: Date): Promise<BookResult>;
  /** The client's confirmed appointments that have not started yet, soonest first. */
  upcomingForClient(clientId: string, now: Date): Promise<UpcomingAppointment[]>;
  /** Cancels one of the client's own upcoming appointments. */
  cancelByClient(appointmentId: string, clientId: string, now: Date): Promise<"cancelled" | "not_found">;
}
