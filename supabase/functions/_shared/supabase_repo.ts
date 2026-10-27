// Rendo M3 — the Repo backed by Supabase (secret key, server side only).
// Every database error becomes a RepoError carrying the operation and the Postgres code only:
// Postgres messages can contain row values (phone numbers), so they are never logged or rethrown.
import type { SupabaseClient } from "./db.ts";
import {
  type AvailabilityData,
  type BookResult,
  type Business,
  type Client,
  type ClientIds,
  type Conversation,
  type Lang,
  type Repo,
  RepoError,
  type Service,
  type UpcomingAppointment,
} from "./domain.ts";
import {
  conversationColumns,
  toBookResult,
  toBusiness,
  toBusy,
  toClient,
  toConversation,
  toInterval,
  toOpeningRange,
  toService,
  toUpcoming,
} from "./mappers.ts";

type PgError = { code?: string } | null;

function fail(operation: string, error: PgError): never {
  throw new RepoError(operation, error?.code);
}

const BUSINESS_COLUMNS =
  "id, name, owner_whatsapp, timezone, default_language, slot_minutes, buffer_minutes, booking_horizon_days, min_notice_minutes, contact_phone, chairs, price_display";
const SERVICE_COLUMNS =
  "id, name, name_en, category, category_en, duration_minutes, price_xaf, price_mode, note, note_en, aliases, " +
  "service_choice_groups(id, name, name_en, sort_order, " +
  "service_choices(id, name, name_en, price_add_xaf, duration_add_minutes, sort_order, active))";
const CONVERSATION_COLUMNS =
  "client_id, business_id, state, context, expires_at, paused_until, last_inbound_at, handoff_requested_at, version";

export class SupabaseRepo implements Repo {
  constructor(private readonly db: SupabaseClient) {}

  async businessByPhoneNumberId(phoneNumberId: string): Promise<Business | null> {
    const { data, error } = await this.db.from("businesses").select(BUSINESS_COLUMNS)
      .eq("phone_number_id", phoneNumberId).eq("active", true).maybeSingle();
    if (error) fail("businessByPhoneNumberId", error);
    return data ? toBusiness(data) : null;
  }

  async activeServices(businessId: string): Promise<Service[]> {
    const { data, error } = await this.db.from("services")
      .select(SERVICE_COLUMNS)
      .eq("business_id", businessId).eq("active", true)
      .order("sort_order").order("name");
    if (error) fail("activeServices", error);
    // the select string is built from parts, so supabase-js cannot type the rows: map them ourselves
    return ((data ?? []) as unknown as Record<string, unknown>[]).map(toService);
  }

  async availabilityData(businessId: string, from: Date, to: Date): Promise<AvailabilityData> {
    const fromIso = from.toISOString(), toIso = to.toISOString();
    const [hours, closures, busy] = await Promise.all([
      this.db.from("opening_hours").select("weekday, opens_at, closes_at").eq("business_id", businessId),
      // anything that overlaps [from, to): ends after `from` AND starts before `to`
      this.db.from("closures").select("starts_at, ends_at")
        .eq("business_id", businessId).gt("ends_at", fromIso).lt("starts_at", toIso),
      // blocked_until (not starts_at) so an appointment that began before `from` still counts
      this.db.from("appointments").select("starts_at, blocked_until, chair")
        .eq("business_id", businessId).neq("status", "cancelled")
        .gt("blocked_until", fromIso).lt("starts_at", toIso),
    ]);
    if (hours.error) fail("availabilityData.opening_hours", hours.error);
    if (closures.error) fail("availabilityData.closures", closures.error);
    if (busy.error) fail("availabilityData.appointments", busy.error);
    return {
      openingHours: (hours.data ?? []).map(toOpeningRange),
      closures: (closures.data ?? []).map((r) => toInterval(r, "starts_at", "ends_at")),
      busy: (busy.data ?? []).map(toBusy),
    };
  }

  async upsertClient(businessId: string, ids: ClientIds): Promise<Client> {
    const { data, error } = await this.db.rpc("rendo_upsert_client", {
      p_business_id: businessId,
      p_wa_user_id: ids.waUserId ?? null,
      p_phone: ids.phone ?? null,
      p_display_name: ids.displayName ?? null,
    }).single();
    if (error || !data) fail("upsertClient", error);
    return toClient(data as Record<string, unknown>);
  }

  async setClientLanguage(clientId: string, language: Lang): Promise<void> {
    const { error } = await this.db.from("clients").update({ language }).eq("id", clientId);
    if (error) fail("setClientLanguage", error);
  }

  async conversation(client: Client): Promise<Conversation> {
    const { data, error } = await this.db.from("conversations").select(CONVERSATION_COLUMNS)
      .eq("client_id", client.id).maybeSingle();
    if (error) fail("conversation", error);
    if (data) return toConversation(data);
    return {
      clientId: client.id,
      businessId: client.businessId,
      state: "idle",
      context: {},
      expiresAt: null,
      pausedUntil: null,
      lastInboundAt: null,
      handoffRequestedAt: null,
      version: 0,
      isNew: true,
    };
  }

  async saveConversation(c: Conversation): Promise<"saved" | "conflict"> {
    const columns = conversationColumns(c);
    if (c.isNew) {
      const { error } = await this.db.from("conversations")
        .insert({ client_id: c.clientId, business_id: c.businessId, ...columns, version: 1 });
      if (!error) return "saved";
      if (error.code === "23505") return "conflict"; // another message created it first
      fail("saveConversation.insert", error);
    }
    // optimistic lock: only update if nobody saved since we read version c.version
    const { data, error } = await this.db.from("conversations")
      .update({ ...columns, version: c.version + 1 })
      .eq("client_id", c.clientId).eq("version", c.version)
      .select("client_id");
    if (error) fail("saveConversation.update", error);
    return data && data.length === 1 ? "saved" : "conflict";
  }

  async book(
    businessId: string,
    clientId: string,
    serviceId: string,
    startsAt: Date,
    choiceIds: string[],
  ): Promise<BookResult> {
    const { data, error } = await this.db.rpc("rendo_book_appointment", {
      p_business_id: businessId,
      p_client_id: clientId,
      p_service_id: serviceId,
      p_starts_at: startsAt.toISOString(),
      p_choice_ids: choiceIds,
    });
    if (error) fail("book", error);
    return toBookResult(data);
  }

  async upcomingForClient(clientId: string, now: Date): Promise<UpcomingAppointment[]> {
    const { data, error } = await this.db.from("appointments")
      .select("id, booking_code, starts_at, service_id, choices, services(name, name_en, category, category_en)")
      .eq("client_id", clientId).eq("status", "confirmed").gt("starts_at", now.toISOString())
      .order("starts_at").limit(10);
    if (error) fail("upcomingForClient", error);
    return (data ?? []).map((r) => toUpcoming(r as Record<string, unknown>));
  }

  async cancelByClient(appointmentId: string, clientId: string, now: Date): Promise<"cancelled" | "not_found"> {
    const { data, error } = await this.db.from("appointments")
      .update({ status: "cancelled", cancelled_at: now.toISOString(), cancelled_by: "client" })
      .eq("id", appointmentId).eq("client_id", clientId)
      .eq("status", "confirmed").gt("starts_at", now.toISOString())
      .select("id");
    if (error) fail("cancelByClient", error);
    return data && data.length === 1 ? "cancelled" : "not_found";
  }
}
