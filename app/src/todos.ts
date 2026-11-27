// The to-do list's views (Today, Upcoming, Done), sort and subtasks. Pure functions of the items and the clock;
// bin/ab.mjs (todo-list) loads this file with Node's type stripping, like quickadd.ts.
import type { Todo, TodoDue, TodoPriority } from "./data/types";
import { addDays, daysBetween, easternDate, easternInstant, easternTime } from "./eastern.ts";

export type TodoView = "today" | "upcoming" | "done";
export const TODO_VIEWS: { key: TodoView; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "done", label: "Done" },
];
export const TODO_PRIORITIES: TodoPriority[] = ["urgent", "high", "medium", "low"];
export const isTodoPriority = (v: unknown): v is TodoPriority => TODO_PRIORITIES.includes(v as TodoPriority);
// Tapping the priority chip: urgent -> high -> medium -> low -> urgent.
export const nextPriority = (p: TodoPriority): TodoPriority => TODO_PRIORITIES[(TODO_PRIORITIES.indexOf(p) + 1) % 4];

export const isDone = (t: Todo): boolean => !!t.done_at;
// Anything but the four levels (a hand edit) counts as medium.
const rank = (t: Todo) => (isTodoPriority(t.priority) ? TODO_PRIORITIES.indexOf(t.priority) : 2);
// A date-only due sorts after the timed ones that day; no due sorts last.
const dueKey = (t: Todo) => (t.due ? `${t.due.date} ${t.due.time ?? "24:00"}` : "~");

// Priority (urgent, high, medium, low), then due, then created_at; ties keep their order.
export function sortTodos(items: Todo[]): Todo[] {
  return [...items].sort((a, b) => rank(a) - rank(b) || cmp(dueKey(a), dueKey(b)) || cmp(a.created_at, b.created_at));
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// A view's entries: top-level to-dos, plus a subtask whose parent is in the other state (an open subtask of a done
// parent, a done subtask of an open parent) or missing. Every other subtask shows under its parent.
function entries(items: Todo[], done: boolean): Todo[] {
  const byId = new Map(items.map((t) => [t.id, t]));
  return items.filter((t) => {
    if (isDone(t) !== done) return false;
    const parent = t.parent_id ? byId.get(t.parent_id) : undefined;
    return !parent || isDone(parent) !== done;
  });
}

// Today: open entries due today or earlier (overdue), sorted.
export function todayView(items: Todo[], now: Date): Todo[] {
  const today = easternDate(now);
  return sortTodos(entries(items, false).filter((t) => t.due && t.due.date <= today));
}

export type UpcomingGroup = { date: string | null; label: string; items: Todo[] };

// Upcoming: open entries due after today, one group per day in date order, then a "No date" group when there is any.
export function upcomingView(items: Todo[], now: Date): UpcomingGroup[] {
  const today = easternDate(now);
  const open = entries(items, false);
  const later = sortTodos(open.filter((t) => t.due && t.due.date > today));
  const dates = [...new Set(later.map((t) => t.due!.date))].sort();
  const groups: UpcomingGroup[] = dates.map((date) => ({ date, label: dayLabel(date, now), items: later.filter((t) => t.due!.date === date) }));
  const undated = sortTodos(open.filter((t) => !t.due));
  if (undated.length) groups.push({ date: null, label: "No date", items: undated });
  return groups;
}

// Newest completion first; an unparseable done_at goes last.
const doneAt = (t: Todo) => Date.parse(t.done_at ?? "") || 0;
const newestDone = (items: Todo[]) => [...items].sort((a, b) => doneAt(b) - doneAt(a));

// Done: done entries, newest completion first.
export const doneView = (items: Todo[]): Todo[] => newestDone(entries(items, true));

export function viewCounts(items: Todo[], now: Date): Record<TodoView, number> {
  return {
    today: todayView(items, now).length,
    upcoming: upcomingView(items, now).reduce((n, g) => n + g.items.length, 0),
    done: doneView(items).length,
  };
}

// A to-do's subtasks: open ones sorted, then done ones newest completion first.
export function subtasksOf(items: Todo[], id: string): Todo[] {
  const subs = items.filter((t) => t.parent_id === id);
  return [...sortTodos(subs.filter((t) => !isDone(t))), ...newestDone(subs.filter(isDone))];
}

// "2/3": done and total subtasks, or null when there are none.
export function subtaskProgress(items: Todo[], id: string): { done: number; total: number } | null {
  const subs = items.filter((t) => t.parent_id === id);
  return subs.length ? { done: subs.filter(isDone).length, total: subs.length } : null;
}

// Open and past due: a date before today, or today at a time already gone. A date-only due is late from the next day.
export function isOverdue(t: Todo, now: Date): boolean {
  if (isDone(t) || !t.due) return false;
  const today = easternDate(now);
  if (t.due.date !== today) return t.due.date < today;
  return !!t.due.time && t.due.time < easternTime(now);
}

// How late an overdue to-do is: "25 min late", "3 h late", "1 day late", "4 days late". null when not overdue.
export function lateBy(t: Todo, now: Date): string | null {
  if (!isOverdue(t, now)) return null;
  const due = t.due!;
  if (!due.time) {
    const days = daysBetween(due.date, easternDate(now));
    return `${days} ${days === 1 ? "day" : "days"} late`;
  }
  const min = Math.max(1, Math.floor((now.getTime() - easternInstant(due.date, due.time)) / 60000));
  if (min < 60) return `${min} min late`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h late`;
  const days = Math.floor(min / (24 * 60));
  return `${days} ${days === 1 ? "day" : "days"} late`;
}

const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const DAY_YEAR = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });

// "Today", "Tomorrow", "Yesterday", "Fri, Nov 27", or "Fri, Jan 1, 2027" in another year.
export function dayLabel(date: string, now: Date): string {
  const today = easternDate(now);
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  if (date === addDays(today, -1)) return "Yesterday";
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return (date.slice(0, 4) === today.slice(0, 4) ? DAY : DAY_YEAR).format(t);
}

// "15:00" -> "3:00 PM".
export function clockLabel(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// The due chip: "Today", "Tomorrow 3:00 PM", "Fri, Nov 27, 9:30 AM".
export function dueLabel(due: TodoDue, now: Date): string {
  const day = dayLabel(due.date, now);
  if (!due.time) return day;
  return `${day}${/^(Today|Tomorrow|Yesterday)$/.test(day) ? " " : ", "}${clockLabel(due.time)}`;
}
