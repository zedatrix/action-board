import { describe, expect, it } from "vitest";
import { cardStamp, headerDate, stampOf } from "../src/stamp";

// Fri Nov 13 2026, 10:00 AM Eastern (EST, UTC-5).
const now = new Date("2026-11-13T15:00:00.000Z");

describe("cardStamp", () => {
  it("says added for a card that was never updated", () => {
    expect(cardStamp({ created_at: "2026-11-13T14:14:00.000Z" }, now)).toBe("added 9:14 AM");
  });

  it("says added when updated_at equals created_at or is not later", () => {
    const c = "2026-11-13T14:14:00.000Z";
    expect(cardStamp({ created_at: c, updated_at: c }, now)).toBe("added 9:14 AM");
    expect(cardStamp({ created_at: c, updated_at: "2026-11-13T09:14:00-05:00" }, now)).toBe("added 9:14 AM");
    expect(cardStamp({ created_at: c, updated_at: "2026-11-13T13:00:00.000Z" }, now)).toBe("added 9:14 AM");
  });

  it("says updated, with the updated time, when updated_at is later", () => {
    expect(cardStamp({ created_at: "2026-11-13T14:14:00.000Z", updated_at: "2026-11-13T19:40:00.000Z" }, now)).toBe("updated 2:40 PM");
    expect(cardStamp({ created_at: "2026-11-10T14:00:00.000Z", updated_at: "2026-11-13T14:59:00.000Z" }, now)).toBe("updated 9:59 AM");
  });

  it("shows the time only today, and the date too on another day", () => {
    expect(cardStamp({ created_at: "2026-11-13T05:00:00.000Z" }, now)).toBe("added 12:00 AM");
    expect(cardStamp({ created_at: "2026-11-12T19:40:00.000Z", updated_at: "2026-11-12T19:40:00.000Z" }, now)).toBe("added Nov 12, 2:40 PM");
    expect(cardStamp({ created_at: "2026-11-01T14:00:00.000Z", updated_at: "2026-11-12T19:40:00.000Z" }, now)).toBe("updated Nov 12, 2:40 PM");
  });

  it("adds the year only when it differs from now's", () => {
    expect(cardStamp({ created_at: "2025-11-12T19:40:00.000Z" }, now)).toBe("added Nov 12, 2025, 2:40 PM");
    expect(cardStamp({ created_at: "2026-01-02T15:05:00.000Z" }, now)).toBe("added Jan 2, 10:05 AM");
  });

  it("uses the Eastern calendar date, not UTC's", () => {
    // 04:30 UTC on Nov 13 is 11:30 PM on Nov 12 in New York.
    const late = { created_at: "2026-11-13T04:30:00.000Z" };
    expect(cardStamp(late, now)).toBe("added Nov 12, 11:30 PM");
    expect(cardStamp(late, new Date("2026-11-13T04:45:00.000Z"))).toBe("added 11:30 PM");
    expect(cardStamp(late, new Date("2026-11-13T05:00:00.000Z"))).toBe("added Nov 12, 11:30 PM");
  });

  it("follows daylight saving time", () => {
    expect(cardStamp({ created_at: "2026-07-01T13:14:00.000Z" }, new Date("2026-07-01T20:00:00.000Z"))).toBe("added 9:14 AM");
  });

  it("returns null when neither stamp is usable, and uses whichever one is", () => {
    expect(cardStamp({}, now)).toBeNull();
    expect(cardStamp({ created_at: "", updated_at: "  " }, now)).toBeNull();
    expect(cardStamp({ created_at: "not a date", updated_at: "2026-13-45" }, now)).toBeNull();
    expect(cardStamp({ created_at: 7, updated_at: null } as never, now)).toBeNull();
    expect(cardStamp({ updated_at: "2026-11-13T19:40:00.000Z" }, now)).toBe("updated 2:40 PM");
    expect(cardStamp({ created_at: "garbage", updated_at: "2026-11-13T19:40:00.000Z" }, now)).toBe("updated 2:40 PM");
    expect(cardStamp({ created_at: "2026-11-13T14:14:00.000Z", updated_at: "garbage" }, now)).toBe("added 9:14 AM");
  });

  it("uses plain spaces, never a narrow no-break space", () => {
    expect(cardStamp({ created_at: "2026-11-12T19:40:00.000Z" }, now)).not.toMatch(/[  ]/);
  });
});

describe("stampOf", () => {
  it("returns the stored ISO string and the full Eastern date and time for the tooltip", () => {
    const s = stampOf({ created_at: "2026-11-10T09:00:00.000Z", updated_at: "2026-11-13T04:30:00.000Z" }, now)!;
    expect(s).toEqual({ verb: "updated", iso: "2026-11-13T04:30:00.000Z", when: "Nov 12, 11:30 PM", full: "Thu, Nov 12, 2026, 11:30 PM EST" });
  });

  it("evaluates today at call time when now is not given", () => {
    expect(stampOf({ created_at: new Date().toISOString() })!.when).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
  });
});

describe("headerDate", () => {
  it("is today in Eastern time, rolling at midnight Eastern rather than UTC or local", () => {
    expect(headerDate(now)).toBe("Fri 13 Nov");
    expect(headerDate(new Date("2026-11-14T04:59:59.999Z"))).toBe("Fri 13 Nov");
    expect(headerDate(new Date("2026-11-14T05:00:00.000Z"))).toBe("Sat 14 Nov");
    // EDT (UTC-4) in summer.
    expect(headerDate(new Date("2026-07-02T03:59:00.000Z"))).toBe("Wed 1 Jul");
    expect(headerDate(new Date("2026-07-02T04:00:00.000Z"))).toBe("Thu 2 Jul");
  });
});
