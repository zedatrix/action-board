// When a decision card came in: the newer of created_at and updated_at, in the board's time zone (TIME_ZONE).
// "added 9:14 AM" today, "updated Nov 12, 2:40 PM" on another day, "added Nov 12, 2025, 2:40 PM" in another year.
import { TIME_ZONE } from "./config";

const ZONE = TIME_ZONE;
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: ZONE, ...o });
const TIME = fmt({ hour: "numeric", minute: "2-digit" });
const DAY = fmt({ year: "numeric", month: "numeric", day: "numeric" });
const YEAR = fmt({ year: "numeric" });
const MONTH_DAY = fmt({ month: "short", day: "numeric" });
const MONTH_DAY_YEAR = fmt({ month: "short", day: "numeric", year: "numeric" });
const FULL = fmt({ weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

// Newer ICU puts a narrow no-break space before AM/PM; show a plain space everywhere.
const plain = (s: string) => s.replace(/[  ]/g, " ");

export type Stamp = {
  verb: "added" | "updated";
  // The stamp as stored, for <time dateTime>.
  iso: string;
  // "9:14 AM" or "Nov 12, 2:40 PM".
  when: string;
  // Full date and time in the board's zone, for the tooltip: "Thu, Nov 12, 2026, 11:30 PM EST".
  full: string;
};

// Missing, non-string or unparseable stamps (old or hand-edited data) count as absent.
const ms = (s: unknown) => (typeof s === "string" && s.trim() ? Date.parse(s) : NaN);

export function stampOf(d: { created_at?: unknown; updated_at?: unknown }, now: Date = new Date()): Stamp | null {
  const c = ms(d.created_at);
  const u = ms(d.updated_at);
  // "updated" only when updated_at is later than created_at (or created_at is unusable).
  const updated = !Number.isNaN(u) && (Number.isNaN(c) || u > c);
  if (!updated && Number.isNaN(c)) return null;
  const verb = updated ? "updated" : "added";
  const t = updated ? u : c;
  const iso = String(updated ? d.updated_at : d.created_at);
  const time = TIME.format(t);
  const when =
    DAY.format(t) === DAY.format(now) ? time : `${(YEAR.format(t) === YEAR.format(now) ? MONTH_DAY : MONTH_DAY_YEAR).format(t)}, ${time}`;
  return { verb, iso, when: plain(when), full: plain(FULL.format(t)) };
}

// The board header's date, "Fri 13 Nov": today in the board's zone, so it rolls at midnight there like the stamps.
const HEADER = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, weekday: "short", day: "numeric", month: "short" });
export const headerDate = (now: Date): string => HEADER.format(now);

// "added 9:14 AM", "updated Nov 12, 2:40 PM", or null when the card has no usable stamp.
export function cardStamp(d: { created_at?: string; updated_at?: string }, now?: Date): string | null {
  const s = stampOf(d, now);
  return s && `${s.verb} ${s.when}`;
}
