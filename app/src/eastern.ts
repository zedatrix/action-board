// Eastern (America/New_York) wall-clock helpers for the to-do list. bin/ab.mjs loads this file (and quickadd.ts,
// todos.ts) with Node's type stripping, so it has no imports and uses only erasable TypeScript.

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

// The Eastern wall clock at an instant.
export function easternWall(t: Date | number): Wall {
  const p: Record<string, number> = {};
  for (const x of PARTS.formatToParts(t)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}

const pad = (n: number) => String(n).padStart(2, "0");

// "2026-11-26": today's date in Eastern time.
export function easternDate(t: Date | number): string {
  const w = easternWall(t);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

// "15:04": the Eastern time of day.
export function easternTime(t: Date | number): string {
  const w = easternWall(t);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

// The UTC instant (ms) of an Eastern wall-clock date and time ("00:00" when time is missing).
export function easternInstant(date: string, time = "00:00"): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  const want = Date.UTC(y, m - 1, d, h, min);
  // Guess with the offset at that instant, then once more in case the guess crossed a DST change.
  let t = want;
  for (let i = 0; i < 2; i++) {
    const w = easternWall(t);
    t += want - Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  }
  return t;
}

// "2026-11-26" plus n days.
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Whole days from date a to date b (both "YYYY-MM-DD").
export function daysBetween(a: string, b: string): number {
  const ms = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((ms(b) - ms(a)) / 86400000);
}

// A real calendar date written "YYYY-MM-DD".
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return addDays(v, 0) === v;
}

// A time of day written "HH:MM", 00:00 to 23:59.
export const isClockTime = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

const CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
});

export function etTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${CLOCK.format(date).replace(/[  ]/g, " ")} ET`;
}
