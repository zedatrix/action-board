import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isTodos, parseTodosSource, TODOS_END, TODOS_START } from "../src/data/parse";
import { todos as realTodos } from "../src/data/todos";
import type { Todo } from "../src/data/types";
import { easternInstant } from "../src/eastern";
import {
  doneView,
  dueLabel,
  isOverdue,
  lateBy,
  nextPriority,
  sortTodos,
  subtaskProgress,
  subtasksOf,
  todayView,
  upcomingView,
  viewCounts,
} from "../src/todos";

// Thursday, Nov 26, 2026, 10:00 AM Eastern.
const NOW = new Date("2026-11-26T15:00:00Z");
let n = 0;
const t = (id: string, extra: Partial<Todo> = {}): Todo => ({
  id,
  name: id,
  priority: "medium",
  comments: [],
  created_at: `2026-11-20T09:00:${String(n++ % 60).padStart(2, "0")}.000Z`,
  updated_at: "2026-11-20T09:00:00.000Z",
  ...extra,
});
const ids = (xs: Todo[]) => xs.map((x) => x.id);

describe("todos.ts data file", () => {
  it("parses: the real file has the markers and an items list", () => {
    const src = readFileSync(new URL("../src/data/todos.ts", import.meta.url), "utf8");
    expect(src.split(TODOS_START)).toHaveLength(2);
    expect(src.split(TODOS_END)).toHaveLength(2);
    expect(parseTodosSource(src)).toEqual(realTodos);
    expect(isTodos(realTodos)).toBe(true);
  });

  it("refuses missing markers and wrong shapes", () => {
    expect(() => parseTodosSource("export const todos = {};")).toThrow(/markers missing/);
    const wrap = (v: unknown) => `${TODOS_START}\n${JSON.stringify(v)}\n${TODOS_END}`;
    expect(() => parseTodosSource(wrap({ updated_at: "x" }))).toThrow(/wrong shape/);
    expect(() => parseTodosSource(wrap({ updated_at: "x", items: [{ id: "a", name: "A" }] }))).toThrow(/wrong shape/);
    expect(parseTodosSource(wrap({ updated_at: "x", items: [t("a")] })).items[0].id).toBe("a");
  });
});

describe("sortTodos", () => {
  it("sorts by priority, then due (timed before date-only, no due last), then created_at", () => {
    const items = [
      t("low", { priority: "low", due: { date: "2026-11-20" } }),
      t("med-nodue", { created_at: "2026-11-01T00:00:00.000Z" }),
      t("med-dateonly", { due: { date: "2026-11-26" } }),
      t("med-3pm", { due: { date: "2026-11-26", time: "15:00" } }),
      t("med-9am", { due: { date: "2026-11-26", time: "09:00" } }),
      t("urgent", { priority: "urgent" }),
      t("high-b", { priority: "high", created_at: "2026-11-02T00:00:00.000Z" }),
      t("high-a", { priority: "high", created_at: "2026-11-01T00:00:00.000Z" }),
    ];
    expect(ids(sortTodos(items))).toEqual(["urgent", "high-a", "high-b", "med-9am", "med-3pm", "med-dateonly", "med-nodue", "low"]);
  });

  it("cycles the priority chip urgent, high, medium, low", () => {
    expect([nextPriority("urgent"), nextPriority("high"), nextPriority("medium"), nextPriority("low")]).toEqual(["high", "medium", "low", "urgent"]);
  });
});

describe("views", () => {
  const items = [
    t("overdue-day", { due: { date: "2026-11-24" } }),
    t("overdue-hour", { due: { date: "2026-11-26", time: "07:00" } }),
    t("today-later", { priority: "urgent", due: { date: "2026-11-26", time: "16:00" } }),
    t("today-any", { due: { date: "2026-11-26" } }),
    t("tomorrow", { due: { date: "2026-11-27" } }),
    t("dec-3", { priority: "high", due: { date: "2026-12-03" } }),
    t("dec-3-low", { priority: "low", due: { date: "2026-12-03", time: "08:00" } }),
    t("no-date"),
    t("done-old", { done_at: "2026-11-24T12:00:00.000Z", due: { date: "2026-11-24" } }),
    t("done-new", { done_at: "2026-11-25T12:00:00.000Z" }),
  ];

  it("Today: due today and overdue, open only, sorted", () => {
    expect(ids(todayView(items, NOW))).toEqual(["today-later", "overdue-day", "overdue-hour", "today-any"]);
  });

  it("marks overdue with how late", () => {
    const by = (id: string) => items.find((x) => x.id === id)!;
    expect(isOverdue(by("overdue-day"), NOW)).toBe(true);
    expect(lateBy(by("overdue-day"), NOW)).toBe("2 days late");
    expect(lateBy(by("overdue-hour"), NOW)).toBe("3 h late");
    expect(lateBy(t("x", { due: { date: "2026-11-26", time: "09:35" } }), NOW)).toBe("25 min late");
    expect(lateBy(t("x", { due: { date: "2026-11-25" } }), NOW)).toBe("1 day late");
    expect(lateBy(t("x", { due: { date: "2026-11-24", time: "09:00" } }), NOW)).toBe("2 days late");
    // Due later today, date-only today, done, or no due: not late.
    for (const id of ["today-later", "today-any", "done-old", "no-date"]) expect([id, isOverdue(by(id), NOW), lateBy(by(id), NOW)]).toEqual([id, false, null]);
  });

  it("Upcoming: future due grouped by day in date order, sorted inside, then No date", () => {
    expect(upcomingView(items, NOW).map((g) => [g.date, g.label, ids(g.items)])).toEqual([
      ["2026-11-27", "Tomorrow", ["tomorrow"]],
      ["2026-12-03", "Thu, Dec 3", ["dec-3", "dec-3-low"]],
      [null, "No date", ["no-date"]],
    ]);
    expect(upcomingView([t("a", { due: { date: "2027-01-04" } })], NOW)[0].label).toBe("Mon, Jan 4, 2027");
    expect(upcomingView([], NOW)).toEqual([]);
  });

  it("Done: newest completion first", () => {
    expect(ids(doneView(items))).toEqual(["done-new", "done-old"]);
  });

  it("counts each view", () => {
    expect(viewCounts(items, NOW)).toEqual({ today: 4, upcoming: 4, done: 2 });
  });

  it("uses the Eastern day: 10:30 PM Thursday Eastern is still Thursday", () => {
    const late = new Date("2026-11-27T03:30:00Z");
    expect(ids(todayView([t("thu", { due: { date: "2026-11-26" } }), t("fri", { due: { date: "2026-11-27" } })], late))).toEqual(["thu"]);
    expect(dueLabel({ date: "2026-11-27", time: "15:00" }, late)).toBe("Tomorrow 3:00 PM");
  });

  it("labels the due chip", () => {
    expect(dueLabel({ date: "2026-11-26" }, NOW)).toBe("Today");
    expect(dueLabel({ date: "2026-11-25", time: "00:05" }, NOW)).toBe("Yesterday 12:05 AM");
    expect(dueLabel({ date: "2026-12-03", time: "12:30" }, NOW)).toBe("Thu, Dec 3, 12:30 PM");
  });

  it("computes Eastern instants across daylight saving time", () => {
    expect(new Date(easternInstant("2026-11-26", "10:00")).toISOString()).toBe("2026-11-26T15:00:00.000Z");
    expect(new Date(easternInstant("2026-07-01", "10:00")).toISOString()).toBe("2026-07-01T14:00:00.000Z");
  });
});

describe("subtasks", () => {
  const items = [
    t("parent", { due: { date: "2026-11-26" } }),
    t("sub-open-b", { parent_id: "parent", priority: "low" }),
    t("sub-open-a", { parent_id: "parent", priority: "high" }),
    t("sub-done", { parent_id: "parent", done_at: "2026-11-25T10:00:00.000Z" }),
    t("done-parent", { done_at: "2026-11-25T11:00:00.000Z" }),
    t("dp-open", { parent_id: "done-parent", due: { date: "2026-11-26" } }),
    t("dp-done", { parent_id: "done-parent", done_at: "2026-11-25T11:00:00.000Z" }),
  ];

  it("lists a parent's subtasks, open sorted then done, with progress", () => {
    expect(ids(subtasksOf(items, "parent"))).toEqual(["sub-open-a", "sub-open-b", "sub-done"]);
    expect(subtaskProgress(items, "parent")).toEqual({ done: 1, total: 3 });
    expect(subtaskProgress(items, "sub-done")).toBeNull();
  });

  it("shows subtasks under their parent, not as entries of their own", () => {
    expect(ids(todayView(items, NOW))).toEqual(["parent", "dp-open"]);
    expect(upcomingView(items, NOW)).toEqual([]);
  });

  it("a done parent hides from Today and Upcoming with its done subtasks; its open subtasks stay as entries", () => {
    expect(ids(todayView(items, NOW))).not.toContain("done-parent");
    expect(ids(todayView(items, NOW))).toContain("dp-open");
    // Done: the done parent (with dp-done under it) and sub-done, whose parent is still open.
    expect(ids(doneView(items))).toEqual(["done-parent", "sub-done"]);
  });
});
