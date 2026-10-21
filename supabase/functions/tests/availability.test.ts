// Tests for the M2 availability engine. Run from the repo root:  deno test supabase/functions/tests/
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import {
  type AvailabilityInput,
  availableSlots,
  type BusinessRules,
  type Interval,
  parseTime,
  zonedTimeToUtc,
} from "../_shared/availability.ts";

const RULES: BusinessRules = {
  timezone: "Africa/Douala", // UTC+1, no daylight saving
  slotMinutes: 30,
  bufferMinutes: 10,
  horizonDays: 10,
  minNoticeMinutes: 120,
};

// Douala local time -> Date (Douala is always UTC+1)
const at = (local: string) => new Date(local.replace(" ", "T") + ":00+01:00");

// Monday 2 Nov 2026, 08:00-12:00 and 14:00-18:00; Tuesday 08:00-12:00; closed otherwise
const HOURS = [
  { weekday: 1, opensAt: "08:00", closesAt: "12:00" },
  { weekday: 1, opensAt: "14:00:00", closesAt: "18:00:00" }, // Postgres "time" format
  { weekday: 2, opensAt: "08:00", closesAt: "12:00" },
];

function input(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    rules: RULES,
    serviceMinutes: 30,
    openingHours: HOURS,
    closures: [],
    busy: [],
    now: at("2026-11-01 12:00"), // Sunday noon, so Monday is fully bookable
    ...overrides,
  };
}

const timesOn = (date: string, inp: AvailabilityInput) =>
  availableSlots(inp).filter((s) => s.localDate === date).map((s) => s.localTime);

Deno.test("availability: full morning and afternoon on a split day", () => {
  assertEquals(timesOn("2026-11-02", input()), [
    "08:00",
    "08:30",
    "09:00",
    "09:30",
    "10:00",
    "10:30",
    "11:00",
    "11:30",
    "14:00",
    "14:30",
    "15:00",
    "15:30",
    "16:00",
    "16:30",
    "17:00",
    "17:30",
  ]);
});

Deno.test("availability: local Douala time maps to the right UTC instant", () => {
  const first = availableSlots(input())[0];
  assertEquals(first.start.toISOString(), "2026-11-02T07:00:00.000Z");
  assertEquals(first.end.toISOString(), "2026-11-02T07:30:00.000Z");
});

Deno.test("availability: a 60-minute service must finish before closing", () => {
  const times = timesOn("2026-11-02", input({ serviceMinutes: 60 }));
  assertEquals(times.slice(0, 7), ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00"]);
  assert(!times.includes("11:30"));
  assert(!times.includes("17:30"));
});

Deno.test("availability: existing booking blocks its time plus buffer, and our own buffer counts too", () => {
  // existing 09:00-09:30, blocked until 09:40
  const busy: Interval[] = [{ start: at("2026-11-02 09:00"), end: at("2026-11-02 09:40") }];
  const times = timesOn("2026-11-02", input({ busy }));
  assert(times.includes("08:00")); // 08:00-08:30 +10 = 08:40, free
  assert(!times.includes("08:30")); // 08:30-09:00 +10 = 09:10 collides with 09:00
  assert(!times.includes("09:00"));
  assert(!times.includes("09:30")); // starts before 09:40
  assert(times.includes("10:00"));
});

Deno.test("availability: minimum notice hides slots that start too soon", () => {
  // Monday 09:10 + 120 min = 11:10 -> first offer 11:30
  const times = timesOn("2026-11-02", input({ now: at("2026-11-02 09:10") }));
  assertEquals(times[0], "11:30");
});

Deno.test("availability: horizon limits the days offered (today counts as day 1)", () => {
  const dates = new Set(
    availableSlots(input({ rules: { ...RULES, horizonDays: 2 } })).map((s) => s.localDate),
  );
  // Sunday (closed) + Monday
  assertEquals([...dates], ["2026-11-02"]);
});

Deno.test("availability: a closure removes the slots it covers", () => {
  const closures = [{ start: at("2026-11-03 00:00"), end: at("2026-11-04 00:00") }];
  assertEquals(timesOn("2026-11-03", input({ closures })), []);
  assert(timesOn("2026-11-02", input({ closures })).length > 0);
});

Deno.test("availability: closed weekdays offer nothing", () => {
  assertEquals(timesOn("2026-11-04", input()), []); // Wednesday
});

Deno.test("availability: next week's Monday appears within a 10-day horizon", () => {
  assert(timesOn("2026-11-09", input()).length === 16);
});

Deno.test("availability: invalid settings return no slots instead of looping", () => {
  assertEquals(availableSlots(input({ serviceMinutes: 0 })), []);
  assertEquals(availableSlots(input({ rules: { ...RULES, slotMinutes: 0 } })), []);
});

Deno.test("availability: daylight-saving gap is skipped (Europe/Paris, 29 Mar 2026)", () => {
  // 02:00-02:59 local does not exist that night in Paris
  const paris: AvailabilityInput = {
    ...input(),
    rules: { ...RULES, timezone: "Europe/Paris", minNoticeMinutes: 0 },
    openingHours: [{ weekday: 7, opensAt: "01:00", closesAt: "04:00" }],
    now: new Date("2026-03-28T12:00:00Z"),
  };
  const times = availableSlots(paris).filter((s) => s.localDate === "2026-03-29").map((s) => s.localTime);
  assertEquals(times, ["01:00", "01:30", "03:00", "03:30"]);
});

Deno.test("availability: offered slots never violate the database no-overlap rule (random bookings)", () => {
  // Simulate many clients each taking a random offered slot; the DB rule must always hold.
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const busy: Interval[] = [];
  for (let i = 0; i < 60; i++) {
    const service = [30, 45, 60, 90][Math.floor(rand() * 4)];
    const offered = availableSlots(input({ busy, serviceMinutes: service }));
    if (offered.length === 0) break;
    const pick = offered[Math.floor(rand() * offered.length)];
    const blocked = { start: pick.start, end: new Date(pick.end.getTime() + RULES.bufferMinutes * 60_000) };
    for (const b of busy) {
      const overlap = blocked.start < b.end && blocked.end > b.start;
      assert(!overlap, `slot ${pick.localDate} ${pick.localTime} overlaps an existing booking`);
    }
    busy.push(blocked);
  }
  assert(busy.length > 10);
});

Deno.test("parseTime and zonedTimeToUtc helpers", () => {
  assertEquals(parseTime("08:30"), 510);
  assertEquals(parseTime("24:00"), 1440);
  assertEquals(parseTime("25:00"), null);
  assertEquals(parseTime("8h30"), null);
  assertEquals(
    zonedTimeToUtc(2026, 11, 2, 10, 0, "Africa/Douala")?.toISOString(),
    "2026-11-02T09:00:00.000Z",
  );
  assertEquals(zonedTimeToUtc(2026, 3, 29, 2, 30, "Europe/Paris"), null);
});
