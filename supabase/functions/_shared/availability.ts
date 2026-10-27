// Rendo M2 — availability engine.
//
// Pure function: given a business's rules, opening hours, closures and existing appointments,
// list the start times a client may book for one service. No database, no network, no clock:
// everything (including "now") is passed in, so it is fully unit-testable.
//
// It applies EXACTLY the rule the database enforces (appointments_no_overlap in migration 0003):
// a new appointment blocks [start, end + buffer) and that range must not overlap the
// [starts_at, blocked_until) range of any active appointment. The database stays the final
// guard against races; this engine only decides what to OFFER.

export interface BusinessRules {
  timezone: string; // IANA zone, e.g. "Africa/Douala"
  slotMinutes: number; // grid step for start times (30)
  bufferMinutes: number; // blocked after each appointment (10)
  horizonDays: number; // calendar days offered, today included (10)
  minNoticeMinutes: number; // earliest start = now + this (120)
}

export interface OpeningRange {
  weekday: number; // ISO 8601: 1 = Monday ... 7 = Sunday
  opensAt: string; // local "HH:MM" or "HH:MM:SS" (Postgres time)
  closesAt: string; // local, after opensAt; "24:00" allowed
}

export interface Interval {
  start: Date;
  end: Date; // exclusive
}

/** An existing appointment: [starts_at, blocked_until) on one chair. */
export interface BusyInterval extends Interval {
  chair?: number; // 1 when not given (salons with a single chair, or data from before chairs existed)
}

export interface AvailabilityInput {
  rules: BusinessRules;
  serviceMinutes: number;
  openingHours: OpeningRange[];
  closures: Interval[];
  /** Active appointments as [starts_at, blocked_until). Cancelled ones must not be passed. */
  busy: BusyInterval[];
  /** Clients served at the same time (default 1). A slot is free if at least ONE chair is free for all of it. */
  chairs?: number;
  now: Date;
}

export interface Slot {
  start: Date;
  end: Date; // start + service duration
  localDate: string; // "YYYY-MM-DD" in the business time zone
  localTime: string; // "HH:MM" in the business time zone
}

const MINUTE = 60_000;

export function availableSlots(input: AvailabilityInput): Slot[] {
  const { rules, serviceMinutes, openingHours, closures, busy, now } = input;
  const chairs = Math.max(1, Math.floor(input.chairs ?? 1));
  if (
    !(serviceMinutes > 0) || !(rules.slotMinutes > 0) || !(rules.horizonDays > 0) ||
    rules.bufferMinutes < 0 || rules.minNoticeMinutes < 0
  ) {
    return [];
  }

  const earliest = now.getTime() + rules.minNoticeMinutes * MINUTE;
  const today = localParts(now, rules.timezone);
  const seen = new Set<number>();
  const slots: Slot[] = [];

  for (let dayOffset = 0; dayOffset < rules.horizonDays; dayOffset++) {
    // Calendar arithmetic on the local date (UTC used only as a neutral calendar).
    const cal = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
    const y = cal.getUTCFullYear(), m = cal.getUTCMonth() + 1, d = cal.getUTCDate();
    const isoWeekday = cal.getUTCDay() === 0 ? 7 : cal.getUTCDay();

    for (const range of openingHours) {
      if (range.weekday !== isoWeekday) continue;
      const open = parseTime(range.opensAt);
      const close = parseTime(range.closesAt);
      if (open === null || close === null || close <= open) continue;

      for (let t = open; t + serviceMinutes <= close; t += rules.slotMinutes) {
        const start = zonedTimeToUtc(y, m, d, Math.floor(t / 60), t % 60, rules.timezone);
        if (!start) continue; // local time does not exist (daylight-saving gap)
        const s = start.getTime();
        if (s < earliest || seen.has(s)) continue;

        const end = s + serviceMinutes * MINUTE;
        const blockedUntil = end + rules.bufferMinutes * MINUTE;
        if (closures.some((c) => s < c.end.getTime() && end > c.start.getTime())) continue;
        // The database rule is per chair: the slot is free if some chair has no overlapping appointment.
        let freeChair = false;
        for (let chair = 1; chair <= chairs && !freeChair; chair++) {
          freeChair = !busy.some((b) =>
            (b.chair ?? 1) === chair && s < b.end.getTime() && blockedUntil > b.start.getTime()
          );
        }
        if (!freeChair) continue;

        seen.add(s);
        slots.push({
          start,
          end: new Date(end),
          localDate: `${y}-${pad(m)}-${pad(d)}`,
          localTime: `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`,
        });
      }
    }
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** "08:30" / "08:30:00" / "24:00" -> minutes since midnight, or null if invalid. */
export function parseTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]), min = Number(match[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

// ---------------------------------------------------------------------------
// Time-zone helpers (built-in Intl only, no dependency)
// ---------------------------------------------------------------------------
interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock date and time of an instant in a time zone. */
export function localParts(date: Date, timeZone: string): LocalParts {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute };
}

/** Offset of the time zone from UTC at an instant, in minutes (Douala: +60). */
function offsetMinutes(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / MINUTE) * MINUTE) / MINUTE);
}

/**
 * The instant at which the wall clock in `timeZone` shows the given local date/time.
 * Returns null when that local time does not exist (skipped by a daylight-saving change).
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date | null {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall - offsetMinutes(new Date(wall), timeZone) * MINUTE;
  const corrected = wall - offsetMinutes(new Date(guess), timeZone) * MINUTE;
  if (corrected !== guess) guess = corrected;
  const check = localParts(new Date(guess), timeZone);
  const wanted = new Date(wall);
  if (
    check.year !== wanted.getUTCFullYear() || check.month !== wanted.getUTCMonth() + 1 ||
    check.day !== wanted.getUTCDate() || check.hour !== wanted.getUTCHours() ||
    check.minute !== wanted.getUTCMinutes()
  ) {
    return null;
  }
  return new Date(guess);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
