import { describe, expect, it } from "vitest";
import type { Decision } from "../src/data/types";
import { effectivePriority, groupByPriority, PRIORITY_RANK, sortByPriority } from "../src/priority";

const d = (id: string, priority: unknown, created_at?: unknown): Decision =>
  ({
    id,
    card_ref: null,
    question: `Question ${id}?`,
    what_happens_after: "A.",
    options: [{ id: "a", label: "A" }],
    ...(priority === undefined ? {} : { priority }),
    ...(created_at === undefined ? {} : { created_at }),
  }) as Decision;

const ids = (ds: Decision[]) => ds.map((x) => x.id);

describe("effectivePriority", () => {
  it("returns the stored level, and medium for a missing or invalid one", () => {
    expect(effectivePriority(d("a", "high"))).toBe("high");
    expect(effectivePriority(d("a", "low"))).toBe("low");
    expect(effectivePriority(d("a", "medium"))).toBe("medium");
    for (const bad of [undefined, null, "", "HIGH", "urgent", 1, true, {}, ["high"], "toString", "__proto__"])
      expect([bad, effectivePriority(d("a", bad))]).toEqual([bad, "medium"]);
  });

  it("ranks high before medium before low", () => {
    expect(PRIORITY_RANK.high).toBeLessThan(PRIORITY_RANK.medium);
    expect(PRIORITY_RANK.medium).toBeLessThan(PRIORITY_RANK.low);
  });
});

describe("sortByPriority", () => {
  it("puts high, then medium, then low, oldest first inside a level", () => {
    const input = [
      d("low-old", "low", "2026-11-01T09:00:00.000Z"),
      d("med-new", "medium", "2026-11-12T09:00:00.000Z"),
      d("high-new", "high", "2026-11-12T09:00:00.000Z"),
      d("med-old", "medium", "2026-11-02T09:00:00.000Z"),
      d("high-old", "high", "2026-11-03T09:00:00.000Z"),
      d("low-new", "low", "2026-11-13T09:00:00.000Z"),
    ];
    expect(ids(sortByPriority(input))).toEqual(["high-old", "high-new", "med-old", "med-new", "low-old", "low-new"]);
  });

  it("counts a missing or invalid priority as medium", () => {
    const input = [
      d("low", "low", "2026-11-01T09:00:00.000Z"),
      d("none", undefined, "2026-11-05T09:00:00.000Z"),
      d("bad", "urgent", "2026-11-04T09:00:00.000Z"),
      d("med", "medium", "2026-11-06T09:00:00.000Z"),
      d("high", "high", "2026-11-10T09:00:00.000Z"),
    ];
    expect(ids(sortByPriority(input))).toEqual(["high", "bad", "none", "med", "low"]);
  });

  it("puts a missing or unparseable created_at after the dated cards of its level, in file order", () => {
    const input = [
      d("h-none", "high"),
      d("m-bad", "medium", "not a date"),
      d("m-dated", "medium", "2026-11-10T09:00:00.000Z"),
      d("m-none", "medium"),
      d("h-dated", "high", "2026-11-12T09:00:00.000Z"),
      d("m-num", "medium", 12),
    ];
    expect(ids(sortByPriority(input))).toEqual(["h-dated", "h-none", "m-dated", "m-bad", "m-none", "m-num"]);
  });

  it("compares instants, not strings, and keeps the file order for equal stamps", () => {
    const input = [
      d("b", "medium", "2026-11-10T10:00:00.000Z"),
      d("a", "medium", "2026-11-10T05:30:00-05:00"),
      d("c", "medium", "2026-11-10T10:00:00Z"),
      d("x", "medium", "2026-11-10T09:00:00.000Z"),
    ];
    // 05:30-05:00 is 10:30Z, after the two 10:00Z cards, which keep their file order.
    expect(ids(sortByPriority(input))).toEqual(["x", "b", "c", "a"]);
  });

  it("does not mutate the input and returns a new array", () => {
    const input = [d("l", "low", "2026-11-01T09:00:00.000Z"), d("h", "high", "2026-11-02T09:00:00.000Z")];
    const copy = JSON.parse(JSON.stringify(input));
    const out = sortByPriority(input);
    expect(ids(out)).toEqual(["h", "l"]);
    expect(out).not.toBe(input);
    expect(input).toEqual(copy);
    expect(ids(input)).toEqual(["l", "h"]);
    expect(sortByPriority([])).toEqual([]);
  });
});

describe("groupByPriority", () => {
  const groups = (ds: Decision[]) => groupByPriority(ds).map((g) => [g.level, ids(g.items)]);

  it("splits a sorted queue into High, Medium, Low, keeping the oldest-first order inside each level", () => {
    const sorted = sortByPriority([
      d("m2", undefined, "2026-11-10T10:00:00Z"),
      d("l1", "low", "2026-11-10T08:00:00Z"),
      d("h2", "high", "2026-11-10T11:00:00Z"),
      d("m1", "medium", "2026-11-10T09:00:00Z"),
      d("h1", "high", "2026-11-10T07:00:00Z"),
      d("bad", "urgent", "2026-11-10T09:30:00Z"),
    ]);
    expect(groups(sorted)).toEqual([
      ["high", ["h1", "h2"]],
      ["medium", ["m1", "bad", "m2"]],
      ["low", ["l1"]],
    ]);
    // Flattened back, it is exactly the sorted order: grouping never re-sorts.
    expect(groupByPriority(sorted).flatMap((g) => ids(g.items))).toEqual(ids(sorted));
  });

  it("leaves out levels with no cards, and returns nothing for an empty queue", () => {
    expect(groups([d("a", undefined), d("b", "medium")])).toEqual([["medium", ["a", "b"]]]);
    expect(groups([d("l", "low"), d("h", "high")])).toEqual([
      ["high", ["h"]],
      ["low", ["l"]],
    ]);
    expect(groupByPriority([])).toEqual([]);
  });

  it("keeps the given order inside a level (stable) and does not touch the input", () => {
    const input = [d("x", "low"), d("y", "high"), d("z", "low"), d("w", "high")];
    const copy = JSON.parse(JSON.stringify(input));
    expect(groups(input)).toEqual([
      ["high", ["y", "w"]],
      ["low", ["x", "z"]],
    ]);
    expect(input).toEqual(copy);
    expect(ids(input)).toEqual(["x", "y", "z", "w"]);
    expect(groupByPriority(input)[0].items[0]).toBe(input[1]);
  });
});
