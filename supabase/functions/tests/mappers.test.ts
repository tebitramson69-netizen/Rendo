// Tests for the row -> domain mappers. Run from the repo root:  deno test supabase/functions/tests/
import { deepStrictEqual as assertEquals, ok as assert, throws } from "node:assert/strict";
import {
  cleanContext,
  conversationColumns,
  toBookResult,
  toBusiness,
  toClient,
  toConversation,
  toUpcoming,
} from "../_shared/mappers.ts";

const BUSINESS_ROW = {
  id: "b1",
  name: "Rendo Démo",
  owner_whatsapp: "237690000000",
  timezone: "Africa/Douala",
  default_language: "fr",
  slot_minutes: 30,
  buffer_minutes: 10,
  booking_horizon_days: 10,
  min_notice_minutes: 120,
};

Deno.test("mappers: business row -> Business", () => {
  assertEquals(toBusiness(BUSINESS_ROW), {
    id: "b1",
    name: "Rendo Démo",
    ownerWhatsapp: "237690000000",
    timezone: "Africa/Douala",
    defaultLanguage: "fr",
    slotMinutes: 30,
    bufferMinutes: 10,
    horizonDays: 10,
    minNoticeMinutes: 120,
  });
});

Deno.test("mappers: a malformed row throws instead of producing half an object", () => {
  throws(() => toBusiness({ ...BUSINESS_ROW, slot_minutes: "30" }), /slot_minutes/);
  throws(() => toBusiness({ ...BUSINESS_ROW, default_language: "de" }), /default_language/);
  throws(() => toClient({ id: "c1", business_id: "b1", language: "fr", phone: 237 }), /phone/);
});

Deno.test("mappers: client with hidden phone number", () => {
  assertEquals(
    toClient({ id: "c1", business_id: "b1", wa_user_id: "BSUID.1", phone: null, display_name: null, language: "en" }),
    {
      id: "c1",
      businessId: "b1",
      waUserId: "BSUID.1",
      phone: null,
      displayName: null,
      language: "en",
    },
  );
});

Deno.test("mappers: conversation round trip keeps dates and version", () => {
  const row = {
    client_id: "c1",
    business_id: "b1",
    state: "choosing_day",
    context: { serviceId: "s1", page: 2, nested: { no: 1 }, list: [1] },
    expires_at: "2026-11-02T08:00:00+00:00",
    paused_until: null,
    last_inbound_at: "2026-11-01T08:00:00.000Z",
    version: 3,
  };
  const c = toConversation(row);
  assertEquals(c.context, { serviceId: "s1", page: 2 }); // nested values are dropped
  assertEquals(c.expiresAt?.toISOString(), "2026-11-02T08:00:00.000Z");
  assertEquals(c.version, 3);
  assertEquals(c.isNew, false);
  assertEquals(conversationColumns(c), {
    state: "choosing_day",
    context: { serviceId: "s1", page: 2 },
    expires_at: "2026-11-02T08:00:00.000Z",
    paused_until: null,
    last_inbound_at: "2026-11-01T08:00:00.000Z",
  });
});

Deno.test("mappers: cleanContext ignores non-objects", () => {
  assertEquals(cleanContext(null), {});
  assertEquals(cleanContext([1, 2]), {});
  assertEquals(cleanContext("x"), {});
  assertEquals(cleanContext({ a: Infinity, b: true }), { b: true });
});

Deno.test("mappers: booking results", () => {
  const booked = toBookResult({
    status: "booked",
    appointment_id: "a1",
    booking_code: "R0042",
    starts_at: "2026-11-02T08:00:00+00:00",
    ends_at: "2026-11-02T08:30:00+00:00",
  });
  assert(booked.status === "booked");
  assertEquals(booked.bookingCode, "R0042");
  assertEquals(booked.endsAt.toISOString(), "2026-11-02T08:30:00.000Z");
  assertEquals(toBookResult({ status: "slot_taken" }), { status: "slot_taken" });
  assertEquals(toBookResult({ status: "invalid", reason: "starts_in_past" }), {
    status: "invalid",
    reason: "starts_in_past",
  });
  throws(() => toBookResult(null), /unexpected/);
});

Deno.test("mappers: upcoming appointment with embedded service", () => {
  const u = toUpcoming({
    id: "a1",
    booking_code: "R1234",
    starts_at: "2026-11-02T08:00:00Z",
    services: { name: "Coupe" },
  });
  assertEquals(u.serviceName, "Coupe");
  assertEquals(u.startsAt.toISOString(), "2026-11-02T08:00:00.000Z");
});
