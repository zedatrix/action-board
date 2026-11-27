// Quick add for the to-do list: "call the vendor Friday 3pm p1" -> name "call the vendor", due Friday 15:00 Eastern, urgent.
// Shared by the Board's quick-add input and `ab todo-add {"quick": ...}` (bin/ab.mjs loads it with Node's type
// stripping, so local imports carry their .ts extension and types are imported with `import type`).
import * as chrono from "chrono-node";
import type { TodoDue, TodoPriority } from "./data/types";
import { easternWall } from "./eastern.ts";

export type QuickAdd = { name: string; priority?: TodoPriority; due?: TodoDue };

// "!urgent" "!high" "!medium" "!low", or p1 (urgent) to p4 (low), with or without "!", as a word of its own.
const PRIORITY_TOKEN = /(^|\s)(?:!(urgent|high|medium|low)|!?p([1-4]))(?=\s|$)/gi;
const BY_NUMBER: TodoPriority[] = ["urgent", "high", "medium", "low"];
// A word left dangling once the date is taken out: "dentist on" -> "dentist".
const DANGLING = /\s+(?:on|at|by|due|for)$/i;

const pad = (n: number) => String(n).padStart(2, "0");

// The words, the first priority token, and the first date or time chrono finds, read on the Eastern wall clock
// at `now`. A date with no time stays date-only. The tokens and the date text are taken out of the name.
// The name may come back empty; quickAdd refuses that.
export function parseQuickAdd(text: string, now: Date = new Date()): QuickAdd {
  let priority: TodoPriority | undefined;
  const rest = text.replace(PRIORITY_TOKEN, (_m, lead: string, word?: string, num?: string) => {
    priority ??= word ? (word.toLowerCase() as TodoPriority) : BY_NUMBER[Number(num) - 1];
    return lead;
  });
  // chrono reads dates in the machine's zone, so give it the Eastern wall clock as a local Date.
  const w = easternWall(now);
  const ref = new Date(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const [hit] = chrono.parse(rest, ref, { forwardDate: true });
  let name = rest;
  let due: TodoDue | undefined;
  if (hit) {
    const s = hit.start;
    due = { date: `${s.get("year")}-${pad(s.get("month")!)}-${pad(s.get("day")!)}` };
    if (s.isCertain("hour")) due.time = `${pad(s.get("hour")!)}:${pad(s.get("minute") ?? 0)}`;
    name = rest.slice(0, hit.index) + " " + rest.slice(hit.index + hit.text.length);
  }
  name = name.replace(/\s+/g, " ").trim().replace(DANGLING, "").trim();
  return { name, ...(priority ? { priority } : {}), ...(due ? { due } : {}) };
}

// parseQuickAdd, refusing a name that is empty once the date and priority are taken out.
export function quickAdd(text: string, now?: Date): QuickAdd | { error: string } {
  const q = parseQuickAdd(text, now);
  return q.name ? q : { error: "quick add needs a name besides the date and priority, like \"call the vendor Friday 3pm\"" };
}
