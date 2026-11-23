import type { Decision, Priority } from "./data/types";

// Dev-server route that sets a card's priority in board.ts through `ab priority` (PRIORITY_ROUTE in vite.config.ts).
export const PRIORITY_PATH = "/__ab/priority";

export const PRIORITIES: readonly Priority[] = ["high", "medium", "low"];
export const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
export const PRIORITY_LABEL: Record<Priority, string> = { high: "High", medium: "Medium", low: "Low" };

export const isPriority = (v: unknown): v is Priority => typeof v === "string" && Object.prototype.hasOwnProperty.call(PRIORITY_RANK, v);

// A missing priority, or anything else from a hand edit of board.ts, counts as medium.
export function effectivePriority(d: Pick<Decision, "priority">): Priority {
  return isPriority(d.priority) ? d.priority : "medium";
}

// High, then medium, then low. Within a level, oldest created_at first; a missing or unparseable created_at
// goes after the dated cards of its level. Ties keep the file's order. Returns a new array.
export function sortByPriority<T extends Pick<Decision, "priority" | "created_at">>(decisions: readonly T[]): T[] {
  const time = (d: T) => {
    const t = typeof d.created_at === "string" ? Date.parse(d.created_at) : NaN;
    return Number.isNaN(t) ? Infinity : t;
  };
  return decisions
    .map((d, i) => ({ d, i, rank: PRIORITY_RANK[effectivePriority(d)], t: time(d) }))
    .sort((a, b) => a.rank - b.rank || (a.t === b.t ? 0 : a.t < b.t ? -1 : 1) || a.i - b.i)
    .map((x) => x.d);
}

// Splits a sortByPriority result into its levels, High, Medium, Low, keeping each level's order.
// Levels with no cards are left out. Returns new arrays; the input is not touched.
export function groupByPriority<T extends Pick<Decision, "priority">>(sorted: readonly T[]): { level: Priority; items: T[] }[] {
  return PRIORITIES.map((level) => ({ level, items: sorted.filter((d) => effectivePriority(d) === level) })).filter((g) => g.items.length > 0);
}
