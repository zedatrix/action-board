import type { Todo, TodoPriority } from "./data/types";
import { TODO_PATH } from "./useLiveTodos";

// A body for POST /__ab/todo: the action, then that `ab todo-<action>` command's keys. The server sets a
// comment's author ("User").
export type TodoAction =
  | { action: "add"; name: string; priority?: TodoPriority; parent_id?: string }
  | { action: "update"; id: string; name?: string; description?: string | null; priority?: TodoPriority }
  | { action: "comment"; id: string; text: string }
  | { action: "done" | "reopen"; id: string };

export type Send = (body: TodoAction) => Promise<boolean>;

// Runs one action through the dev server. ok is false for any failure (refused, unknown id, server down);
// todo is the to-do as ab wrote it, when the reply has one.
export async function postTodo(body: TodoAction): Promise<{ ok: boolean; todo?: Todo }> {
  try {
    const res = await window.fetch(TODO_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return { ok: false };
    const reply = await res.json().catch(() => null);
    const todo = reply?.todo;
    return todo && typeof todo.id === "string" && Array.isArray(todo.comments) ? { ok: true, todo } : { ok: true };
  } catch {
    return { ok: false };
  }
}

// The live list with the to-dos the page just saved laid over it, so a write shows before the live feed
// brings it. A saved copy only wins while it is newer than the feed's (by updated_at).
export function withSaved(items: Todo[], saved: Record<string, Todo>): Todo[] {
  const ids = new Set(items.map((t) => t.id));
  const merged = items.map((t) => (saved[t.id] && saved[t.id].updated_at > t.updated_at ? saved[t.id] : t));
  return [...merged, ...Object.values(saved).filter((t) => !ids.has(t.id))];
}

// The saved copies the feed has caught up with (same or newer updated_at), to drop.
export function caughtUp(items: Todo[], saved: Record<string, Todo>): string[] {
  const byId = new Map(items.map((t) => [t.id, t]));
  return Object.keys(saved).filter((id) => {
    const t = byId.get(id);
    return !!t && t.updated_at >= saved[id].updated_at;
  });
}
