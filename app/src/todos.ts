import type { Todo, TodoPriority } from "./data/types";
import { easternDate } from "./eastern.ts";

export const TODO_PRIORITIES: TodoPriority[] = ["urgent", "high", "medium", "low"];
export const isTodoPriority = (v: unknown): v is TodoPriority => TODO_PRIORITIES.includes(v as TodoPriority);
// Tapping the priority chip: urgent -> high -> medium -> low -> urgent.
export const nextPriority = (p: TodoPriority): TodoPriority => TODO_PRIORITIES[(TODO_PRIORITIES.indexOf(p) + 1) % 4];

export const isDone = (t: Todo): boolean => !!t.done_at;
// Anything but the four levels (a hand edit) counts as medium.
const rank = (t: Todo) => (isTodoPriority(t.priority) ? TODO_PRIORITIES.indexOf(t.priority) : 2);
const comparePriority = (a: Todo, b: Todo) => rank(a) - rank(b);
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Priority, then oldest creation first. Equal keys keep the input order.
export function sortTodos(items: Todo[]): Todo[] {
  return [...items].sort((a, b) => comparePriority(a, b) || compareText(a.created_at, b.created_at));
}

export function completedTodos(items: Todo[]): Todo[] {
  const doneAt = (t: Todo) => Date.parse(t.done_at ?? "") || 0;
  return items.filter(isDone).sort((a, b) => doneAt(b) - doneAt(a));
}

export function openSubtasks(items: Todo[], id: string): Todo[] {
  return sortTodos(items.filter((t) => t.parent_id === id && !isDone(t)));
}

export function subtaskProgress(items: Todo[], id: string): { done: number; total: number } | null {
  const subs = items.filter((t) => t.parent_id === id);
  return subs.length ? { done: subs.filter(isDone).length, total: subs.length } : null;
}

// The CLI's existing todo-list filters keep their date ordering and entry rules.
export function cliTodoList(items: Todo[], view: "today" | "upcoming" | "done", now: Date): Todo[] {
  const done = view === "done";
  const byId = new Map(items.map((t) => [t.id, t]));
  const entries = items.filter((t) => {
    if (isDone(t) !== done) return false;
    const parent = t.parent_id ? byId.get(t.parent_id) : undefined;
    return !parent || isDone(parent) !== done;
  });
  if (done) return completedTodos(entries);

  const today = easternDate(now);
  const dueDate = (t: Todo) => t.due?.date ?? "~";
  const dueTime = (t: Todo) => t.due?.time ?? "24:00";
  return entries
    .filter((t) => view === "today" ? dueDate(t) <= today : dueDate(t) > today)
    .sort((a, b) => {
      const dateOrder = compareText(dueDate(a), dueDate(b));
      const priorityOrder = comparePriority(a, b);
      return (view === "today" ? priorityOrder || dateOrder : dateOrder || priorityOrder)
        || compareText(dueTime(a), dueTime(b))
        || compareText(a.created_at, b.created_at);
    });
}
