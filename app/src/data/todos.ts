import type { Todos } from "./types";
// The Board's to-do list. Change it only with `node bin/ab.mjs todo-add|todo-update|todo-comment|todo-done|todo-reopen`
// (the page writes through POST /__ab/todo, which runs ab). Everything between the two marker lines must stay valid JSON.
// Shape (types in ./types.ts):
//   { updated_at (ISO UTC), items: [{ id, name, description?, priority: "urgent"|"high"|"medium"|"low",
//     due?: { date: "YYYY-MM-DD", time?: "HH:MM" } (Eastern wall clock), parent_id? (subtask of a top-level to-do),
//     comments: [{ id, text, author, at }], created_at, updated_at, done_at? }] }
//   Done means done_at is set. Completing a parent leaves its subtasks as they are.
export const todos: Todos =
/* TODOS-JSON-START */
{
  "updated_at": "2026-11-23T15:00:00.000Z",
  "items": []
}
/* TODOS-JSON-END */
;
