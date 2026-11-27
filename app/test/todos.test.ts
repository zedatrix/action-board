import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isTodos, parseTodosSource, TODOS_END, TODOS_START } from "../src/data/parse";
import { todos as realTodos } from "../src/data/todos";
import type { Todo } from "../src/data/types";
import { nextPriority, openSubtasks, sortTodos, subtaskProgress } from "../src/todos";

const t = (id: string, extra: Partial<Todo> = {}): Todo => ({
  id,
  name: id,
  priority: "medium",
  comments: [],
  created_at: "2026-11-20T09:00:00.000Z",
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
  it("sorts by priority and creation time, ignoring due dates and preserving ties", () => {
    const items = [
      t("low", { priority: "low", due: { date: "2026-11-20" } }),
      t("medium-b", { due: { date: "2026-11-20", time: "09:00" } }),
      t("medium-a", { due: { date: "2026-11-19" } }),
      t("medium-oldest", { created_at: "2026-11-01T00:00:00.000Z" }),
      t("urgent", { priority: "urgent" }),
      t("high-newer", { priority: "high" }),
      t("high-older", { priority: "high", created_at: "2026-11-01T00:00:00.000Z", due: { date: "2026-12-01" } }),
    ];
    expect(ids(sortTodos(items))).toEqual(["urgent", "high-older", "high-newer", "medium-oldest", "medium-b", "medium-a", "low"]);
  });

  it("cycles the priority chip urgent, high, medium, low", () => {
    expect([nextPriority("urgent"), nextPriority("high"), nextPriority("medium"), nextPriority("low")]).toEqual(["high", "medium", "low", "urgent"]);
  });
});

describe("subtasks", () => {
  const items = [
    t("parent", { due: { date: "2026-11-26" } }),
    t("sub-open-b", { parent_id: "parent", priority: "low" }),
    t("sub-open-a", { parent_id: "parent", priority: "high" }),
    t("sub-done", { parent_id: "parent", done_at: "2026-11-25T10:00:00.000Z" }),
  ];

  it("lists open subtasks by priority and counts completed subtasks in progress", () => {
    expect(ids(openSubtasks(items, "parent"))).toEqual(["sub-open-a", "sub-open-b"]);
    expect(subtaskProgress(items, "parent")).toEqual({ done: 1, total: 3 });
    expect(subtaskProgress(items, "sub-done")).toBeNull();
  });
});
