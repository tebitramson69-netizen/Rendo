// In-memory Repo for tests: same behaviour as the database where it matters
// (active services only, overlap -> slot_taken, own appointments only, optimistic versions).
import type {
  AvailabilityData,
  BookResult,
  Business,
  Client,
  ClientIds,
  Conversation,
  Lang,
  Repo,
  Service,
  UpcomingAppointment,
} from "../_shared/domain.ts";
import type { OpeningRange } from "../_shared/availability.ts";

interface Appt {
  id: string;
  businessId: string;
  clientId: string;
  serviceId: string;
  code: string;
  start: Date;
  end: Date;
  blockedUntil: Date;
  status: "confirmed" | "cancelled";
}

type FakeService = Service & { businessId: string; active: boolean };

/** A service with the catalogue defaults (no category, fixed price, no English name, no note). */
export function svc(
  fields: Partial<FakeService> & Pick<FakeService, "businessId" | "name" | "durationMinutes">,
): FakeService {
  return {
    id: uuid(),
    nameEn: null,
    category: "",
    categoryEn: null,
    priceXaf: null,
    priceMode: "fixed",
    note: null,
    noteEn: null,
    active: true,
    ...fields,
  };
}

let counter = 0;
export const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

export class FakeRepo implements Repo {
  services: FakeService[] = [];
  hours: OpeningRange[] = [];
  appointments: Appt[] = [];
  clients: Client[] = [];
  conversations = new Map<string, Conversation>();
  languageChanges: Array<[string, Lang]> = [];
  /** Force the next book() to answer slot_taken (simulates a client winning the race). */
  nextBookTaken = false;
  calls: string[] = [];

  constructor(public business: Business) {}

  businessByPhoneNumberId(id: string): Promise<Business | null> {
    return Promise.resolve(id === "PNID" ? this.business : null);
  }

  activeServices(businessId: string): Promise<Service[]> {
    return Promise.resolve(
      this.services.filter((s) => s.businessId === businessId && s.active)
        .map(({ businessId: _b, active: _a, ...service }) => service),
    );
  }

  availabilityData(businessId: string, from: Date, to: Date): Promise<AvailabilityData> {
    return Promise.resolve({
      openingHours: this.hours,
      closures: [],
      busy: this.appointments
        .filter((a) => a.businessId === businessId && a.status !== "cancelled" && a.blockedUntil > from && a.start < to)
        .map((a) => ({ start: a.start, end: a.blockedUntil })),
    });
  }

  upsertClient(businessId: string, ids: ClientIds): Promise<Client> {
    let c = this.clients.find((x) =>
      x.businessId === businessId &&
      ((ids.waUserId && x.waUserId === ids.waUserId) || (ids.phone && x.phone === ids.phone))
    );
    if (!c) {
      c = {
        id: uuid(),
        businessId,
        waUserId: ids.waUserId ?? null,
        phone: ids.phone ?? null,
        displayName: ids.displayName ?? null,
        language: "fr",
      };
      this.clients.push(c);
    }
    return Promise.resolve(c);
  }

  setClientLanguage(clientId: string, language: Lang): Promise<void> {
    this.languageChanges.push([clientId, language]);
    const c = this.clients.find((x) => x.id === clientId);
    if (c) c.language = language;
    return Promise.resolve();
  }

  conversation(client: Client): Promise<Conversation> {
    return Promise.resolve(
      this.conversations.get(client.id) ?? {
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
      },
    );
  }

  saveConversation(c: Conversation): Promise<"saved" | "conflict"> {
    const current = this.conversations.get(c.clientId);
    if ((current?.version ?? 0) !== c.version || (c.isNew && current)) return Promise.resolve("conflict");
    this.conversations.set(c.clientId, { ...c, version: c.version + 1, isNew: false });
    return Promise.resolve("saved");
  }

  book(businessId: string, clientId: string, serviceId: string, startsAt: Date): Promise<BookResult> {
    this.calls.push("book");
    const svc = this.services.find((s) => s.id === serviceId && s.businessId === businessId && s.active);
    if (!svc) return Promise.resolve({ status: "invalid", reason: "service_unavailable" });
    const end = new Date(startsAt.getTime() + svc.durationMinutes * 60_000);
    const blockedUntil = new Date(end.getTime() + this.business.bufferMinutes * 60_000);
    const overlap = this.appointments.some((a) =>
      a.businessId === businessId && a.status !== "cancelled" && startsAt < a.blockedUntil && blockedUntil > a.start
    );
    if (overlap || this.nextBookTaken) {
      this.nextBookTaken = false;
      return Promise.resolve({ status: "slot_taken" });
    }
    const appt: Appt = {
      id: uuid(),
      businessId,
      clientId,
      serviceId,
      code: `R${String(this.appointments.length + 1).padStart(4, "0")}`,
      start: startsAt,
      end,
      blockedUntil,
      status: "confirmed",
    };
    this.appointments.push(appt);
    return Promise.resolve({ status: "booked", appointmentId: appt.id, bookingCode: appt.code, startsAt, endsAt: end });
  }

  upcomingForClient(clientId: string, now: Date): Promise<UpcomingAppointment[]> {
    return Promise.resolve(
      this.appointments
        .filter((a) => a.clientId === clientId && a.status === "confirmed" && a.start > now)
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .map((a) => ({
          id: a.id,
          bookingCode: a.code,
          service: (({ name, nameEn, category, categoryEn }) => ({ name, nameEn, category, categoryEn }))(
            this.services.find((s) => s.id === a.serviceId)!,
          ),
          startsAt: a.start,
        })),
    );
  }

  cancelByClient(appointmentId: string, clientId: string, now: Date): Promise<"cancelled" | "not_found"> {
    const a = this.appointments.find((x) =>
      x.id === appointmentId && x.clientId === clientId && x.status === "confirmed" && x.start > now
    );
    if (!a) return Promise.resolve("not_found");
    a.status = "cancelled";
    return Promise.resolve("cancelled");
  }
}
