import { isTodos } from "./data/parse";
import type { Todos } from "./data/types";
import { useLiveFeed, type Feed } from "./useLiveFeed";

// Dev-server routes (see server/live.ts and vite.config.ts): the to-do list as JSON, and the POST route that
// runs `ab todo-<action>` for the page.
export const TODOS_PATH = "/__ab/todos";
export const TODO_PATH = "/__ab/todo";

const TODOS_FEED: Feed<Todos> = { path: TODOS_PATH, event: "todos", check: isTodos };

// The to-do list as the dev server currently has it. Starts from the bundled todos.ts, then follows the "todos"
// events on /__ab/events, polling /__ab/todos while the stream is down (see useLiveFeed).
export function useLiveTodos(initial: Todos): Todos {
  return useLiveFeed(initial, TODOS_FEED);
}
