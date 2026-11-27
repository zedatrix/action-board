import { describe, expect, it } from "vitest";
import { parseQuickAdd, quickAdd } from "../src/quickadd";

// Thursday, Nov 26, 2026, 10:00 AM Eastern.
const THU = new Date("2026-11-26T15:00:00Z");

describe("quickAdd", () => {
  it("reads a weekday and time: next Friday at 15:00 Eastern, taken out of the name", () => {
    expect(quickAdd("call the vendor Friday 3pm", THU)).toEqual({ name: "call the vendor", due: { date: "2026-11-27", time: "15:00" } });
    expect(quickAdd("call the vendor next tuesday at 9:30", THU)).toEqual({ name: "call the vendor", due: { date: "2026-12-01", time: "09:30" } });
  });

  it("keeps a date with no time date-only", () => {
    expect(quickAdd("pay rent tomorrow", THU)).toEqual({ name: "pay rent", due: { date: "2026-11-27" } });
    expect(quickAdd("dentist on Dec 3", THU)).toEqual({ name: "dentist", due: { date: "2026-12-03" } });
  });

  it("reads priority tokens: p1 urgent, p2 high, p3 medium, p4 low, and !urgent style words", () => {
    expect(quickAdd("fix the build p1", THU)).toEqual({ name: "fix the build", priority: "urgent" });
    expect(quickAdd("p2 review project", THU)).toEqual({ name: "review project", priority: "high" });
    expect(quickAdd("tidy desk !p3", THU)).toEqual({ name: "tidy desk", priority: "medium" });
    expect(quickAdd("water plants P4", THU)).toEqual({ name: "water plants", priority: "low" });
    expect(quickAdd("!urgent ship the fix", THU)).toEqual({ name: "ship the fix", priority: "urgent" });
    expect(quickAdd("call bank !LOW tomorrow", THU)).toEqual({ name: "call bank", priority: "low", due: { date: "2026-11-27" } });
    // The first token wins; all are taken out. Words that only contain one stay.
    expect(quickAdd("p2 plan p1 trip", THU)).toEqual({ name: "plan trip", priority: "high" });
    expect(quickAdd("update p10 report and app1", THU)).toEqual({ name: "update p10 report and app1" });
  });

  it("leaves a plain name alone, with no due and no priority", () => {
    expect(quickAdd("  buy   printer paper ", THU)).toEqual({ name: "buy printer paper" });
  });

  it("refuses a name that is empty after the date and priority are taken out", () => {
    for (const text of ["tomorrow p1", "Friday 3pm", "!urgent", "", "   "]) expect([text, quickAdd(text, THU)]).toEqual([text, { error: expect.stringContaining("needs a name") }]);
    // parseQuickAdd itself returns the empty name, for callers that bring their own.
    expect(parseQuickAdd("tomorrow p1", THU)).toEqual({ name: "", priority: "urgent", due: { date: "2026-11-27" } });
  });

  it("reads days on the Eastern clock, not UTC", () => {
    // 10:30 PM Eastern on Thursday is already Friday in UTC; tomorrow is still Friday.
    const lateThu = new Date("2026-11-27T03:30:00Z");
    expect(quickAdd("pay rent tomorrow", lateThu)).toEqual({ name: "pay rent", due: { date: "2026-11-27" } });
    expect(quickAdd("call mom today 11pm", lateThu)).toEqual({ name: "call mom", due: { date: "2026-11-26", time: "23:00" } });
  });
});
